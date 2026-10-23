# Local development foundation

## Prerequisites

- Node.js 24.x and npm 11.x (`packageManager` records npm 11.6.2).
- Docker Engine/Desktop running Linux containers and Docker Compose v2+.
- Free local ports: 3000, 4000, 5432, 6379, 5672, 15672.

The configuration and sources are supplied in this repository in full. No
generator is needed: npm workspaces plus `turbo.json` establish Turborepo.
Version ranges are declared; the first install generates `package-lock.json`.
Review and commit that lockfile, then use `npm ci` for subsequent installs.

## Initialize from an empty directory (PowerShell)

Use this only when reconstructing the scaffold outside the existing checkout.
After creating directories, copy the supplied root and workspace files into
their matching paths before installing. Do not run a project generator over
the supplied files.

```powershell
New-Item -ItemType Directory -Path LedgerFlow
Set-Location LedgerFlow
git init
$directories = @(
  'apps/web/src/app', 'apps/api/src/infrastructure', 'apps/api/src/shared',
  'packages/db/src', 'packages/shared/src', 'docs'
)
$modules = @(
  'organizations', 'accounting', 'expenses', 'vendor-bills', 'invoicing',
  'transfers', 'bank-reconciliation', 'reporting', 'audit', 'documents', 'ai'
)
foreach ($directory in $directories) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
foreach ($module in $modules) {
  New-Item -ItemType Directory -Force -Path "apps/api/src/modules/$module" | Out-Null
}
# Copy the supplied scaffold files to their matching paths now.
```

## Install and start (existing checkout or reconstructed scaffold)

Run from the repository root, after installing Node.js and reopening the shell:

```powershell
node --version
npm --version
npm install
# Run once; preserve an existing .env instead of overwriting it.
if (!(Test-Path .env)) { Copy-Item .env.example .env }
docker compose config --quiet
docker compose up -d --wait
docker compose ps
npm run dev
```

`npm run dev` builds dependency packages before starting Next.js and the API
as parallel persistent processes. Visit http://localhost:3000 for System Status
and http://localhost:4000/health for API/database JSON status. The health
endpoint executes `SELECT 1` through Kysely. See [system connectivity checks](05-walking-skeleton.md)
for configuration and outage/recovery checks.
RabbitMQ management is at http://localhost:15672 using the credentials in `.env`.

The API uses Node's built-in TypeScript stripping and watch mode; no runtime
TypeScript runner is needed. Its scripts explicitly load the root `.env`.
Next.js loads the root `.env` and uses server-only `API_URL`. Redis and RabbitMQ
clients and the worker entrypoint are deferred. The API creates a database
pool at startup and uses it for health checks and PostgreSQL sessions.
Authentication requires `WEB_ORIGIN=http://localhost:3000` in the root `.env` and
the latest migrations; see [authentication setup and cURL checks](authentication.md).

## Manual acceptance checks

In a second PowerShell window at the root:

```powershell
Invoke-RestMethod http://localhost:4000/health
(Invoke-WebRequest http://localhost:3000).StatusCode
docker compose exec postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose exec redis redis-cli ping
docker compose exec rabbitmq rabbitmq-diagnostics -q ping
```

Expect `api: UP`, `database: UP`, HTTP 200, PostgreSQL accepting connections, Redis `PONG`,
and a successful RabbitMQ ping. All three services should show healthy in
`docker compose ps`.

Stop the dev processes with Ctrl+C before running build/type-generation checks:

```powershell
npm run lint
npm run typecheck
npm run build
# Optional: start the compiled API in one terminal and web in another.
npm run start --workspace=@ledgerflow/api
npm run start --workspace=@ledgerflow/web
```

`lint` currently runs TypeScript diagnostics, including Next.js route type
generation, rather than a separate style linter. API health mapping tests run
with `npm run test --workspace=@ledgerflow/api` after building dependencies.
Next.js generates ignored `next-env.d.ts`
and `.next` types automatically. Rebuild shared packages after editing them;
they have no watch mode at this stage.

To stop infrastructure while keeping local data:

```powershell
docker compose stop
```

## Configuration and boundaries

- `.env.example` contains local-only defaults and DB/Redis/RabbitMQ URLs.
  If credentials change, update the corresponding URL too; URL-encode special
  characters in credentials. Existing Docker volumes retain initialized
  credentials; changing `.env` does not reset them.
- Compose binds services to loopback, uses named volumes and health checks,
  and keeps PostgreSQL on major 16 and RabbitMQ on major 4. Redis uses `latest`
  as requested; this is mutable. This Compose file is local development
  infrastructure, not a production deployment or backup strategy.
- `createDatabase<Database>(url)` validates the URL and creates a bounded,
  lazy connection pool. Call once per process and await `db.destroy()` on
  shutdown. The database package provides identity/tenancy schema types, migrations, and a
  development seed; see [database setup and verification](database.md).
  Run `npm run migrate --workspace=@ledgerflow/db` before seeding.
  Tenant-scoped repositories and authorization must precede business queries.
- Shared workspace packages export compiled ESM and declarations; Turbo
  builds upstream packages before consumers. Domain code must not import DB
  or transport dependencies.
- The main page displays a workspace preview and system connectivity inside
  the responsive app shell. Shared UI components and their usage rules are
  documented in [design tokens](design-tokens.md). Login/logout and session
  middleware are implemented; login UI, tenant authorization, business
  features, financial logic, and Money implementation are deferred.

## Verification status

Installation, lint, type-check, build, Docker startup, and runtime smoke tests
were not executed during the initial scaffold setup.
A lockfile was subsequently supplied and committed. Acceptance remains pending
the manual checks above; no successful runtime verification is claimed.
