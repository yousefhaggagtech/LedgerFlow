# Identity and tenancy database foundation — Task 1.1

`packages/db` owns PostgreSQL connection setup, Kysely schema types, migrations,
and development fixtures. Business use cases remain in `apps/api`.

## Schema contract

- `organizations`: UUID primary key, required name, three uppercase currency
  letters, explicit nonblank accounting timezone, `organization_status`
  (`ACTIVE`, `SUSPENDED`), and timestamps.
- `users`: global UUID identity, unique nonblank email, required password hash
  and full name, `user_status` (`ACTIVE`, `INACTIVE`), and timestamps.
- `memberships`: UUID primary key, required organization/user foreign keys,
  `membership_role` (`OWNER`, `ADMIN`, `ACCOUNTANT`, `FINANCE_MEMBER`, `VIEWER`),
  `membership_status` (`ACTIVE`, `INACTIVE`), and timestamps.

All IDs default to PostgreSQL 16's built-in `gen_random_uuid()` (UUID v4),
without an extension. Status defaults are `ACTIVE`; a membership role must be
supplied explicitly. Timestamps are `timestamptz NOT NULL DEFAULT now()`;
future mutation code must explicitly set `updated_at` on updates.
Email uniqueness currently uses PostgreSQL's case-sensitive text equality;
normalization/lookup policy belongs to the future identity boundary.
Supported currencies, timezone validity, email validity, and password hash
validation must also be enforced at that boundary before exposing writes.
The schema checks currency syntax and nonblank values, not a supported-value catalog.

Membership uniqueness is enforced across **all** statuses by
`UNIQUE (organization_id, user_id)`. Its B-tree index also indexes
`organization_id` as the leading column; a redundant single-column organization
index is unnecessary. A separate `memberships_user_id_index` supports user lookups.
Foreign keys use `ON DELETE RESTRICT ON UPDATE RESTRICT`; no parent deletion
cascades through memberships.

Users are global identities, so their FK does not include an organization.
Memberships are tenant-owned. `UNIQUE (organization_id, id)` enables every future
tenant-owned actor reference to use this contract:

```sql
FOREIGN KEY (organization_id, actor_membership_id)
  REFERENCES memberships (organization_id, id)
  ON DELETE RESTRICT ON UPDATE RESTRICT
```

This prevents cross-tenant actor references. It does not authorize reads or
writes: application authorization and centrally scoped repositories remain
required before business endpoints are introduced. RLS is not added here.

Task 1.2 adds `002_sessions`: UUID selector, hashed secret, global user FK,
expiry/creation timestamps, and audit metadata. See [authentication](authentication.md)
for constraints, indexes, cleanup, and rollback. The original migration is unchanged.
Task 1.3 adds `003_organization_management`: append-only `audit_events` with a
tenant/user-consistent membership actor FK, and completed `idempotency_records`
for creation response replay. An additional `(organization_id, id, user_id)`
membership unique key supports the audit FK. Existing identity/session rows and
previous migrations are preserved. See the [organization API contract](features/organization-management.md#task-13--confirmed-implementation-contract)
for constraints, retry scope/expiry, strict role authority, locks, and tests.
Task 1.3 introduces no permission tables or financial settings; Direct Add requires
no invitation entity. Last-active-Owner retention is enforced by the service
inside the same organization-row lock and transaction as the role change;
future membership/status writers must use that protocol too.

Database change checklist for Task 1.3:

- [x] Required fields, controlled values, JSON shapes, hashes, actor references,
  and append-only audit enforcement are backed by PostgreSQL constraints/triggers.
- [x] Additive migration preserves existing data; disposable-schema tests verify
  rollback/reapplication. Shared-data rollback loses the new history and needs approval.
- [x] Existing organization/user unique index supports keyset pages and membership
  lookups (EXPLAIN verified); audit tenant/time and idempotency expiry indexes added.
- [x] Tenant-scoped repositories and capability/assignment checks cover every route.
- [x] All mutations/audit writes are atomic; creation keys serialize per user and
  member updates serialize per organization. Failed writes leave no success history.
- [x] No data migration, destructive forward DDL, financial records, or credentials
  changed. Bounded lists, existing pool/query deadlines, and short local transactions
  preserve performance, scalability, and failure isolation. The new membership unique
  constraint requires a schema lock; account for table size at deployment.

## Dynamic capabilities — Task 1.4

`004_rbac_permissions` adds the global authorization catalog:

- `permissions`: generated UUID primary key, unique required `code` in
  `resource:action` syntax, and a required nonblank description.
- `role_permissions`: composite primary key `(role, permission_id)`, where
  `role` uses the existing `membership_role` enum. An enum is a PostgreSQL type,
  not a referenced table; it enforces valid role values without a role FK.
  `permission_id` references `permissions(id)` with restrictive update/delete.
  The primary key supports role lookup; a permission index supports FK checks.

The migration seeds all five S1 codes once as deployment data, including in
production. OWNER and ADMIN receive `org:read`, `member:read`, `member:invite`,
and `member:edit`; other roles have no grants. `org:create` is cataloged but is
not role-mapped: authenticated active-user bootstrap is a structural rule and
must also work without any membership. No existing role, identity, session,
audit, or idempotency rows are rewritten. Migration reruns and the separate
development fixture seed do not restore revoked grants.

The application resolves active membership and its permission codes in one
parameterized left join scoped by organization and user. A missing/inactive
membership yields the existing non-disclosing `404`; an active membership with
no required grant yields `403`, even for OWNER. Role grants are global defaults
shared by all tenants; tenant membership is always required to use them.
Only trusted database administration should change this catalog; no grant API,
role-management UI, or runtime grant-management privileges are introduced.

Each tenant request creates a resolver inside its application transaction.
Its promise cache is keyed by both organization and user, shares concurrent
lookups, and holds immutable capability snapshots. No process-wide/Redis/session
authorization cache exists, so committed grant changes apply on the next request.
The pre-lock snapshot is explicitly invalidated after acquiring the organization
lock; authorization then reloads under READ COMMITTED before reads/mutations.
These two bounded joins preserve the existing concurrent-demotion protection
without per-capability or per-member queries. Failed lookups propagate as the
existing generic infrastructure error; they never grant access.

Bootstrap eligibility, Option A assignment restrictions, and Last Owner retention
remain explicit domain invariants. Granting `member:edit` cannot override them.
Capability checks do not write audit events; successful mutations retain their
existing atomic audit writes.

Database change checklist for Task 1.4:

- [x] Required fields, code format, enum roles, unique mappings, and permission
  references are enforced by PostgreSQL and reflected in Kysely types.
- [x] Additive transactional DDL and initial seed preserve existing data;
  rollback/reapplication are tested in isolated schemas. Shared rollback drops
  the two new tables and loses grant changes, so it requires approval and backup.
- [x] Existing tenant/user and new role/permission indexes support the join;
  EXPLAIN verifies index eligibility with sequential scans locally disabled.
- [x] Tenant/user scoping, inactive memberships, grant/revocation, deny by default,
  and structural assignment constraints are tested through the API.
- [x] Existing short transactions, organization locks, creation idempotency, and
  audit atomicity remain intact. No external calls or cross-request cache added.
- [x] Catalog growth uses normalized mapping rows; no existing large table is
  altered. Pool limits/timeouts, backups, and session contracts are unchanged.

Run the existing migrate command below to deploy the schema **and** its initial
grants; the development seed command is not required for RBAC. Apply migration
004 before starting the updated API. Rolling the application back can leave the
additive tables intact; removing them while this API runs will fail requests
closed. For manual inspection:

```sql
SELECT rp.role, p.code FROM role_permissions rp
JOIN permissions p ON p.id = rp.permission_id
ORDER BY rp.role, p.code;
```

`tests/rbac.test.mjs` covers catalog constraints, seed contents, rerun behavior,
query plans, and rollback preserving identities/sessions. API unit and integration
tests cover request cache scope, immutable snapshots, live grants/revocations,
and invalidation after lock contention.

Verified October 18, 2026 with Node 24.19.0 and disposable PostgreSQL 16.11:
all 69 combined API/database checks and all 4 web checks passed. All workspace
lint/type-check command equivalents and production builds passed (the shell has
no npm executable on PATH, so the declared Node/TypeScript/Next commands were
invoked directly). Tests changed only randomly generated schemas in a disposable
cluster, which was stopped afterward; the development database was not migrated.

## Migrate and seed

With Node 24, installed workspace dependencies, a root `.env` containing
`DATABASE_URL`, and PostgreSQL 16 running:

```powershell
npm run migrate --workspace=@ledgerflow/db
npm run seed --workspace=@ledgerflow/db
```

`src/migrations/001_identity_and_tenancy.ts` creates the enums and tables together.
Kysely's Migrator runs PostgreSQL DDL in a transaction, serializes concurrent
migration runners, and records completed migrations. Rerunning `migrate` is a
no-op. The explicit migration registry works with compiled ESM on Windows.

The forward migration only adds objects and does not rewrite existing data.
Its `down` method removes tables before enum types, with no `CASCADE` to discard
external references. **Rollback loses these tables' data and requires explicit
approval and a backup outside disposable tests.** No rollback CLI is supplied.
For an applied migration containing real data, prefer a reviewed forward fix.

The seed transaction creates one `LedgerFlow Test Organization` (`EGP`,
`Africa/Cairo`), `owner@ledgerflow.example`, and their active `OWNER` membership.
The password hash is the deliberately unusable marker `!`; no login credential
is provided. The CLI rejects `NODE_ENV=production`. Run it only on a development
database. It is a one-time fixture: a second execution fails on unique email and
rolls back the whole transaction, including its new organization. It never
overwrites existing identities or memberships. This is separate from future
organization-creation request idempotency.

## Automated verification

Use a disposable PostgreSQL 16 database to which the test user can connect and
create schemas. Set the URL through your environment; it is deliberately
separate from `DATABASE_URL` and has no fallback:

```powershell
$env:TEST_DATABASE_URL = '<PostgreSQL connection URL for a disposable test database>'
npm run test --workspace=@ledgerflow/db
npm run lint
npm run typecheck
npm run build
```

Tests create a randomly named schema, isolate both application and Kysely
migration tables there, and remove only that schema and its fixtures in cleanup.
They verify migration/reapplication, seed defaults, seed failure atomicity,
duplicate and concurrent memberships, global users in multiple organizations,
required fields, enum labels, FK restrictions, and cross-tenant actor references.
No existing schema or development fixture is reset.

Verified on October 18, 2026 using disposable PostgreSQL 16.11 and Node 24.21.0
(the available npm executable was 10.9.4; the project targets npm 11).
All 12 database checks, 3 existing API tests, and 4 existing web tests passed;
repository lint, type-check, and production build passed. Compiled migration
and seed CLIs also succeeded, including a no-op migration rerun, and SQL
confirmed the seeded chain. The development database was not modified.

## SQL verification after seeding

Run in a SQL client connected to the database used by `migrate` and `seed`:

```sql
-- Expect one linked row, all three statuses ACTIVE, and role OWNER.
SELECT o.id AS organization_id, o.name, o.base_currency,
       o.accounting_timezone, o.status AS organization_status,
       u.id AS user_id, u.email, u.status AS user_status,
       m.id AS membership_id, m.role, m.status AS membership_status
FROM memberships m
JOIN organizations o ON o.id = m.organization_id
JOIN users u ON u.id = m.user_id
WHERE u.email = 'owner@ledgerflow.example';

-- Inspect required fields, enum types, and UUID/timestamp defaults.
SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('organizations', 'users', 'memberships')
ORDER BY table_name, ordinal_position;

-- Inspect PKs, unique constraints, checks, and restrictive FKs.
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('organizations'::regclass, 'users'::regclass, 'memberships'::regclass)
ORDER BY table_name, conname;

-- Both composite unique indexes start with organization_id.
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'memberships';

-- Run interactively: expect SQLSTATE 23505, even with status INACTIVE.
-- Run ROLLBACK separately afterward if your client stops on errors.
BEGIN;
INSERT INTO memberships (organization_id, user_id, role, status)
SELECT m.organization_id, m.user_id, 'VIEWER', 'INACTIVE'
FROM memberships m JOIN users u ON u.id = m.user_id
WHERE u.email = 'owner@ledgerflow.example';
ROLLBACK;
```


## Tenant repository pattern - Task 1.5

`apps/api/src/infrastructure/tenant-repository.ts` supplies typed scoped query
factories and returned-resource guards for OrganizationStore and future modules.
The hardening below binds these factories to authenticated transaction context.
Creation and authenticated user-scoped discovery remain explicit identity boundaries.

Database review (no schema migration):

- Integrity: verify returned membership ownership; retain DB constraints and atomic audit.
- Security: mandatory tenant query predicates; discovery scopes by authenticated user.
- Performance: keyset pages and batched role grants; existing user/tenant indexes
  are verified by integration EXPLAIN checks.
- Scalability: bounded pages; no per-member or per-organization grant query loop.
- Reliability: existing pool timeouts, transaction/rollback/idempotency, Owner
  retention, health, and backup contracts remain intact.

Checklist: schema/validation assessed (unchanged); no migration needed; indexes
reviewed; tenant/user scoping and authorization verified; transaction/idempotency
boundaries preserved; existing data and callers assessed. No financial writes,
data backfills, or new destructive database operations are introduced.

## Tenant isolation hardening — migration 005

Application authorization and scoped repositories remain the read/write security
boundary; PostgreSQL RLS stays disabled. Composite keys reject invalid tenant
relationships even if an application insert is incorrect. They do not prevent
an arbitrary unscoped SELECT from reading another tenant's valid rows.

The current schema has no invoices/customers or other financial child tables yet.
Its tenant relationships are:

| Child / reference | Enforcement |
| --- | --- |
| memberships → organizations | organization_id references the global tenant root id. |
| audit_events → acting membership | Existing (organization_id, actor_membership_id, actor_user_id) FK. |
| audit_events → target membership | New (organization_id, target_membership_id) FK to memberships(organization_id, id). |
| audit_events → target organization | New CHECK requires target_id = organization_id for organization targets. |
| idempotency_records → creator membership | New (organization_id, user_id) FK to memberships(organization_id, user_id). |

The existing membership UNIQUE constraints already provide the required parent
keys; adding reversed duplicate unique indexes would be redundant. Users/sessions
and permission catalogs are global and intentionally do not acquire tenant IDs.
Every future FK between tenant-owned tables must include matching organization_id
columns. A catalog-based regression test checks this rule across all migrations.

`005_tenant_relationship_guards` adds a stored generated `target_membership_id`:
it equals target_id for membership targets and NULL for organization targets.
Existing insert payloads remain compatible and cannot supply a different generated
target. Audit history is never logically updated or deleted. Restrictive composite
FKs cover both actor and target; the append-only trigger remains in place.
Creation snapshots must also contain the same organization and authenticated user
as the idempotency row. New child indexes support both composite FK checks.
Tenant IDs are insert-only in Kysely's application types.

### Deployment and rollback

Apply through the existing migrate command before deploying the updated API:

```powershell
npm run migrate --workspace=@ledgerflow/db
```

**Approved availability exception:** PostgreSQL 16 rewrites audit_events when adding
the stored generated column, and the transactional migration holds schema locks.
This migration is not zero downtime; deploy during a maintenance window sized for
the audit table, indexes, constraint validation, and temporary disk use. The current
CLI inherits a three-second query/statement deadline; larger deployments require a
separately reviewed migration-runner timeout configuration. No timeout is silently
disabled by this change. The development database is not migrated by tests.

Run these read-only preflight queries against the intended deployment schema.
Each count must be zero. They return no row payloads:

```sql
SELECT count(*) AS invalid_audit_targets
FROM audit_events a
WHERE (a.target_type = 'ORGANIZATION' AND a.target_id <> a.organization_id)
   OR (a.target_type = 'MEMBERSHIP' AND NOT EXISTS (
     SELECT 1 FROM memberships m
     WHERE m.organization_id = a.organization_id AND m.id = a.target_id
   ));

SELECT count(*) AS invalid_creator_memberships
FROM idempotency_records i
WHERE NOT EXISTS (
  SELECT 1 FROM memberships m
  WHERE m.organization_id = i.organization_id AND m.user_id = i.user_id
);

SELECT count(*) AS invalid_creation_snapshots
FROM idempotency_records
WHERE command_type = 'organization:create' AND NOT ((
  response_snapshot #>> '{organization,id}' = organization_id::text
  AND response_snapshot #>> '{membership,organizationId}' = organization_id::text
  AND response_snapshot #>> '{membership,userId}' = user_id::text
) IS TRUE);
```

Existing invalid data causes migration failure and transactional rollback; nothing
is automatically deleted or repaired. Investigate any violation before deployment,
especially immutable audit history. Migration down removes only the new guards,
indexes, and reproducible generated column, preserving original rows. It weakens
isolation and requires approval on shared databases. Old application versions may
run with the additive guards retained; prefer an application rollback over removing
the database protections.

Database review:

- Integrity: composite FKs, generated targets, snapshot scope checks, and existing
  append-only audit are enforced in PostgreSQL; failed migrations are atomic.
- Security: authenticated transaction identity, active membership at repository
  creation, scoped query helpers, and server-owned insert scope; service capabilities
  and authorization reload after locking remain mandatory.
- Performance: existing parent unique indexes are reused; new child indexes have
  EXPLAIN coverage. Repository creation adds one bounded membership lookup.
- Scalability: tenant context stays local to a transaction/repository; no shared
  mutable tenant state or unbounded relationship arrays are introduced.
- Availability: pool deadlines/short application transactions remain; the approved
  migration rewrite/lock requires a maintenance window and preflight checks.

DB checklist:

- [x] Schema constraints and boundary validation assessed and enforced.
- [x] Additive, reversible migration preserves valid existing data; failures roll back.
- [x] Parent and child indexes reviewed; new query plans tested.
- [x] Tenant scope, actor identity, authorization, and non-disclosing failures tested.
- [x] Existing transactions, audit atomicity, and bootstrap idempotency retained.
- [x] Existing data, old insert shapes, repository callers, and rollback assessed.

### Verification

Build dependencies first, then run the suites in order against a disposable database:

```powershell
npm run build
$env:TEST_DATABASE_URL = '<disposable PostgreSQL connection URL>'
npm run test --workspace=@ledgerflow/db
npm run test --workspace=@ledgerflow/api
npm run test:integration --workspace=@ledgerflow/api
npm run lint
npm run typecheck
```

Migration-heavy test files run with `--test-concurrency=1`: Kysely 0.28's PostgreSQL
introspector enumerates other schemas while checking migration tables, which races
with concurrent DROP/ALTER operations in other test files. Do not run separate
migration suites concurrently against one test database; use separate disposable
databases for parallel CI jobs. Explicit request/write concurrency regression tests
remain enabled. Cleanup touches only each run's randomly generated schema.

Verified October 20, 2026 with Node 24.19.0 and disposable PostgreSQL 16.11:
25 API unit tests, 70 PostgreSQL-backed checks, and 8 web tests passed. Backend
TypeScript builds, workspace lint/type-check command equivalents, and the Next.js
production build passed. npm was unavailable on PATH, so the declared Node,
TypeScript, and Next.js commands were invoked directly. All test schemas were
removed and the disposable cluster was stopped. The development database was not
migrated; browser E2E and production-size migration duration were not measured.
