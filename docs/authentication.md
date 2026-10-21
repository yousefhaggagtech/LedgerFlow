# Authentication core - Task 1.2

Authentication uses PostgreSQL-backed sessions. Redis remains a non-authoritative
cache. Signup remains deferred. Tasks 1.5/1.6 implement identity UI and selection;
server-side membership/capability checks remain a separate authorization boundary. Authentication alone grants no tenant access.

## Implementation and database contract

`apps/api/src/modules/auth` owns the use cases, validation, cookie policy,
Argon2id verification, and `authenticate` middleware. Infrastructure implements
its `AuthStore` interface with parameterized Kysely queries. `packages/db` owns
the additive `002_sessions` migration and schema types.

Phase 4 separates the login workflow into `modules/auth/login.ts`. `createApp`
wires the existing AuthStore, Argon2 verifier, session credential issuer, and clock
once per app. The use case owns lookup, verification, ACTIVE eligibility, issuance,
expiry, and atomic persistence/rotation through the store port. The router keeps
validation, metadata extraction, throttling, cookies, generic response mapping,
and correlated diagnostics. Password verification still runs for absent/inactive
users. No extra lookup, verification, or transaction is added.

`modules/auth/types.ts` contains only inward contracts; Request augmentation is
in `presentation/express.d.ts`. Session lifetime/cleanup constants live in the
framework-independent session policy, with compatible config re-exports. Token
generation/hashing is an infrastructure adapter, retaining the existing session
helper exports. See [Phase 4 verification](reviews/phase-4-clean-architecture.md).

The table has `id UUID PRIMARY KEY`, `user_id UUID NOT NULL` referencing global
users with restrictive update/delete rules, `token_hash TEXT NOT NULL`,
`created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `expires_at TIMESTAMPTZ NOT NULL`,
nullable `user_agent VARCHAR(512)`, and nullable `ip_address INET`. Checks enforce
a SHA-256 hex digest and expiry after creation. User and expiry indexes support
revocation and cleanup; the primary key supports request authentication.

The cookie contains `<UUID>.<256-bit random secret>`. The UUID selects the row;
only a SHA-256 hash of the secret is stored. The UUID alone cannot authenticate.
Node's cryptographic RNG generates both components. Login always issues fresh
credentials; replacing a presented valid session and inserting its replacement
commit in one transaction. Other devices retain their sessions. A forged secret
cannot revoke a session.

Sessions expire **24 hours after login**, without sliding renewal. Every lookup
checks expiry and current user `ACTIVE` status. Cleanup runs at startup and every
five minutes, deleting at most 1,000 expired sessions per run with row locks and
`SKIP LOCKED`. Multiple API instances can clean safely; failures retry on the next
interval. Expiry enforcement does not depend on cleanup. For higher expiry volumes,
schedule more frequent batches using the same store method. Shutdown waits for
pending cleanup before closing the pool. Logout/expiry delete ephemeral session
metadata; this table is not permanent login audit history.

Database change checklist:

- [x] Required fields, FK, digest/timestamp checks, inet, and audit bounds enforced.
- [x] Additive migration preserves identities. Rollback drops only sessions and
  requires approval on shared data; disposable-schema tests verify both directions.
- [x] PK, expiry, and user indexes reviewed; integration tests inspect the lookup plan.
- [x] Global identity queries expose no organization data; tenant authorization is separate.
- [x] Rotation is atomic; logout is idempotent and credential-scoped. Login retries
  issue fresh credentials instead of reusing a session token.
- [x] Existing identity contracts and fixtures preserved. Bounded cleanup, existing
  pool/query timeouts, and fail-closed errors protect performance and reliability.

## Configuration and cookies

Add to an existing root `.env` (new checkouts use `.env.example`):

```dotenv
WEB_ORIGIN=http://localhost:3000
NODE_ENV=development
```

`WEB_ORIGIN` must be one exact HTTP(S) origin without a path, trailing slash,
credentials, or wildcard. Production requires HTTPS. Unknown `NODE_ENV` values
fail startup; omitting it selects development. Existing `DATABASE_URL`, `API_HOST`,
and `API_PORT` retain their meanings. Apply migrations before starting the API:

```powershell
npm run migrate --workspace=@ledgerflow/db
npm run dev
```

Use **localhost for both browser URLs**: web `http://localhost:3000`, API
`http://localhost:4000`. Different ports are different origins but the same site.
The server-only health `API_URL=http://127.0.0.1:4000` may remain unchanged.
Mixing localhost and 127.0.0.1 in browser requests breaks the host/site policy.

Cookies are host-only, `Path=/`, `HttpOnly`, `SameSite=Lax`, with 24-hour Max-Age
and expiry. Local development uses `ledgerflow_session` over HTTP. Production
uses `__Host-ledgerflow_session` with `Secure` and requires browser-facing HTTPS.
Production web/API must share a schemeful site (HTTPS sibling subdomains or one
host behind routing). Unrelated domains need a separately reviewed cookie/CSRF
policy; do not silently switch to SameSite=None.

Credentialed CORS permits only `WEB_ORIGIN`, GET/POST/PATCH/OPTIONS, Content-Type,
and Idempotency-Key; X-Request-Id is exposed for API request correlation.
The browser must opt in to credentials for login, authenticated requests, and logout:

```javascript
await fetch("http://localhost:4000/auth/login", {
  method: "POST", credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password })
});
await fetch("http://localhost:4000/auth/me", { credentials: "include" });
```

Next.js server-side fetches must explicitly forward the incoming user's Cookie
header to the trusted API; they do not inherit browser cookies automatically.
The login UI is available at `/login`; see the setup below.

Unsafe requests require `Content-Type: application/json`; mismatched Origin and
cross-site Fetch Metadata are rejected. JSON forces browser preflight, protecting
against simple-form CSRF; origin checks also reject sibling-origin mutations.
CLI clients may omit Origin. Helmet sets security headers, with HSTS enabled only
in production. Auth responses/errors use `Cache-Control: no-store`.

Forwarded IP headers remain untrusted. Direct connection IPs determine audit IP
and login throttling. Login permits 10 attempts per IP per 15 minutes using a
**per-process** limiter (including invalid requests). Before production behind
proxies/multiple replicas, define a reviewed trusted proxy boundary and shared/edge
throttling; otherwise proxy users share a limit and replicas multiply the allowance.

## HTTP contract

| Endpoint | Request | Success | Failures |
| --- | --- | --- | --- |
| `POST /auth/login` | JSON `{ "email": "...", "password": "..." }` | 200 `{ "user": { "id", "email", "fullName" } }`, Set-Cookie | 400 invalid input, 401 generic credentials, 429 throttled |
| `POST /auth/logout` | JSON content type; optional cookie | 204, session revoked and cookie cleared; repeatable | 503 if revocation fails |
| `GET /auth/me` | Session cookie | 200 `{ "user": { "id", "email", "fullName" } }` | 401 missing, malformed, forged, expired, or inactive identity |

Other errors: 403 disallowed origin, 415 non-JSON mutation, 413 body over 8 KiB,
and generic 503 infrastructure failure. No password hashes, session tokens, audit
metadata, or internal errors appear in JSON responses or application logs.

Credentials must be salted **Argon2id PHC hashes** generated by `argon2.hash`.
Unknown identities, inactive users, wrong passwords, and the seed's unusable `!`
hash return `Invalid email or password`. Dummy verification avoids skipping the
hash work for unknown users. Email lookup trims surrounding whitespace and
preserves case, matching the existing unique constraint; password whitespace is
preserved. Password change/reset and global revocation remain future workflows;
changing a password alone currently does not revoke existing sessions.

Protect future routes with `authenticate(store, config)` after cookie-parser.
It attaches typed `request.user` and `request.userId`. Membership/capability guards
and centrally tenant-scoped repositories remain mandatory for tenant resources.

## Verification

Each API request receives a fresh server-generated UUID in `X-Request-Id`, before
CORS, origin checks, JSON parsing, or authentication. Client-supplied IDs are
ignored. Unexpected request failures emit one bounded JSON diagnostic event with
the same ID, a safe route template, method, status, and allowlisted category.
Routine invalid credentials, permission denials, validation errors, and throttling
remain quiet. An unexpected malformed stored password hash emits a warning while
retaining dummy verification and the generic credential response.

Logs exclude request bodies, credentials, cookies, tokens, hashes, identities,
idempotency keys, raw errors, SQL, URLs, and query parameters. Diagnostic output
is best effort; output failures do not change authentication responses. Cleanup
and lifecycle events have process context rather than fabricated request IDs.
See [Phase 3 evidence](reviews/phase-3-observability.md) for the schema and tests.

```powershell
npm run test --workspace=@ledgerflow/api
# Disposable PostgreSQL only; tests create/remove randomly named schemas.
$env:TEST_DATABASE_URL = '<disposable PostgreSQL connection URL>'
npm run test --workspace=@ledgerflow/db
npm run test:integration --workspace=@ledgerflow/api
npm run test --workspace=@ledgerflow/web
npm run lint
npm run typecheck
npm run build
```

For manual testing, provision a **new local test identity** using an Argon2id
hash through a SQL client. The Task 1.1 seed intentionally has no usable password
and remains unchanged. From `apps/api`, generate a salted hash with a disposable
test password (console input is visible; password whitespace is preserved):

```powershell
node --input-type=module -e "import * as argon2 from 'argon2'; import { createInterface } from 'node:readline/promises'; const cli=createInterface({input:process.stdin,output:process.stdout}); const password=await cli.question('Test password (visible): '); cli.close(); console.log(await argon2.hash(password, {type:argon2.argon2id}));"
```

Insert the generated hash without overwriting the existing seed:

```sql
INSERT INTO users (email, password_hash, full_name)
VALUES ('auth-test@ledgerflow.example', '<generated Argon2id PHC hash>', 'Auth Test');
```

In Postman, enable the cookie jar, send login JSON with Content-Type application/json,
inspect Set-Cookie, call `/auth/me`, log out, and call `/auth/me` again (401).
Equivalent cURL commands (POSIX shell; PowerShell users can use curl.exe and
`--data-binary @login.json` to preserve JSON quoting):

```sh
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"auth-test@ledgerflow.example","password":"<test-password>"}' \
  http://localhost:4000/auth/login
curl -i -b cookies.txt http://localhost:4000/auth/me
curl -i -b cookies.txt -c cookies.txt -X POST -H 'Content-Type: application/json' \
  http://localhost:4000/auth/logout
curl -i -b cookies.txt http://localhost:4000/auth/me
```

Expect 200 with HttpOnly/Lax cookie, 200 with safe user fields, 204 with expired
cookie, then 401. Verify Secure over HTTPS in production. Cookie jars and login
JSON contain credentials; keep them outside tracked files. Automated tests verify
the exact expiry boundary using an injected clock without sleeping or mutating timestamps.

The implementation follows the documented [Argon2id API](https://github.com/ranisalt/node-argon2),
[credentialed CORS configuration](https://expressjs.com/en/resources/middleware/cors/),
and [cookie parsing API](https://expressjs.com/en/resources/middleware/cookie-parser/).

Verified October 18, 2026 on Node 24.5.0, npm 10.8.1, and disposable PostgreSQL
16.11: 14 API checks, 8 PostgreSQL auth checks, 12 identity checks, and 4 web checks
passed. Repository lint, type-check, and build passed (unchanged web/shared work
used Turbo cache). Source and compiled API startup and graceful shutdown passed.
The production dependency audit found zero vulnerabilities. npm installation
reported the existing toolchain mismatch: this repository targets npm 11.
No development database migration or credential mutation was performed. Browser
cookie behavior over a real production HTTPS/proxy deployment remains unverified;
production cookie attributes and CORS headers were tested at the HTTP layer.


## Identity UI - Tasks 1.5/1.6

Add `NEXT_PUBLIC_API_URL=http://localhost:4000` to an existing root `.env` before
starting/building web. It is a public API origin, validated at startup and embedded
at build time; it contains no secrets. Keep WEB_ORIGIN=http://localhost:3000 and
open web through localhost for the documented site/cookie policy. API_URL remains
server-only for health. Browser calls go directly to the API with credentials,
preserving Origin/Fetch-Metadata checks and direct-connection login throttling.
No Next.js authentication proxy or forwarded-IP trust change is introduced.

`/login` -> `/organizations` -> `/settings/organization` uses React context for
user and selected organization. Protected `401` redirects to Login; failed
credentials stay on Login with the API error. Logout revokes the API session and
clears context. No token/organization ID enters browser storage. Refresh without
selected context checks authentication and reopens selection. See
[organization management](features/organization-management.md) for the approved
discovery contract, responsive member UI, and executable browser verification.
