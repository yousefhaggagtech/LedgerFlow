# Task 0.2: walking skeleton connection

The status page follows Web (Next.js server) → API → PostgreSQL. No tables,
schema, migrations, or new endpoints are introduced. Redis and RabbitMQ are
not part of this health check.

## Configuration

Keep the existing root `.env`. Add this line if it is missing:

```dotenv
API_URL=http://127.0.0.1:4000
```

`API_URL` is server-only and must point to the API origin. Next.js loads the
root `.env` in its configuration, while the API uses Node's `--env-file`.
`DATABASE_URL` is required and validated before the API starts. No connection
is opened until a health request executes `SELECT 1`. The process owns one
pool, with connection/query timeouts, and destroys it on shutdown. Malformed
configuration fails at startup; an unavailable database is a handled 503.

## Run and test manually

From the repository root:

```powershell
docker compose up -d --wait
npm run dev
```

Open http://localhost:3000. Expect green `API: UP` and `DB: UP`.
The page refreshes every five seconds without a full browser reload; requests
are uncached. Allow additional time for connection/query timeouts during an
outage. The initial page has a loading state.

In a second terminal:

```powershell
curl.exe -i http://localhost:4000/health
docker compose stop postgres
curl.exe -i http://localhost:4000/health
```

Before stopping PostgreSQL, expect HTTP 200:

```json
{ "api": "UP", "database": "UP" }
```

After stopping PostgreSQL, expect HTTP 503 and red `DB: DOWN` on the page,
while `API: UP` remains green:

```json
{ "api": "UP", "database": "DOWN", "error": "Database is unavailable." }
```

Restore PostgreSQL without restarting the API:

```powershell
docker compose start postgres
```

Once PostgreSQL is ready, expect `DB: UP` again. If the API is unreachable or
returns invalid JSON, the page displays `API: DOWN`, `DB: UNKNOWN`; it cannot
infer database availability without the API. Missing `API_URL` displays a
configuration message with both statuses unknown. Error output never exposes
driver exception messages, credentials, or connection strings.

Stop dev before quality checks:

```powershell
npm run build
npm run lint
npm run typecheck
npm run test --workspace=@ledgerflow/api
```

The API tests use Node's built-in test runner and injected success/failure
checks without external services. They cover status mapping and error
redaction. Docker/browser acceptance checks remain manual. No dependencies
were added, so no lockfile update is needed for this task.

## Verification status

Installation, tests, type-check, lint, build, and runtime checks were not
executed, following the earlier environment instruction. Run the commands
above to verify both outage and recovery behavior.
