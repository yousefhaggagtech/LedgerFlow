# Organization Management

## Current access hints

`GET /organizations/:id/access` is authenticated and returns
`{ membership, capabilities }` using current grants in the existing tenant-scoped
transaction. It requires active membership and an ACTIVE organization, then
refreshes membership/grants after the root read lock. It returns the same
`404 { error: "Organization not found." }` for absent, foreign, inactive or
suspended access. No org:read grant is required to retrieve one's own hints;
otherwise revoking that grant would prevent refreshing the restricted hint set.
The response grants no authority and does not change capability enforcement on
any existing endpoint.

All direct business operations and creation replay also hide non-ACTIVE
organizations with the same non-disclosing 404 as a missing organization. The
named visibility policy is checked on locked roots and the tenant repository gate
requires organization/membership ACTIVE; transaction-owned bootstrap is preserved.

The web provider refreshes hints on settings load and once after a mutation 403,
without retrying the mutation or polling. Selection/refresh generations discard
old responses. Failed refreshes clear stale selection; 401 clears identity.
Capabilities remain in React memory only, never session/cookie/server session
state. The server remains authoritative for every operation.

## 1. Overview

### Goal

Allow an authenticated new user to create an organization, establish their membership as its initial Owner, and let authorized Owners/Admins add members and assign or change their organization-specific roles. An organization is the tenant boundary for all subsequent financial operations.

This feature belongs to the Identity & Organization context. It covers organization creation, viewing organization settings and members, adding a member, and changing a member's role. Account registration/authentication supplies the authenticated User; it is not implemented by this feature. Organization deletion, member removal, lifecycle administration, and financial configuration workflows are not specified here.

This specification supplements the product overview, domain model, and architecture with membership uniqueness and Owner-retention requirements. The implementation contract in §4 supersedes the earlier conceptual proposals.

### User Stories

| Actor                                    | Story                                                                                                              | Acceptance behavior                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authenticated new user                   | As a new user, I want to create my organization so that my business has its own workspace.                         | Submit a name, base currency, and accounting timezone. Success creates the organization and the creator's active Owner membership atomically. Failure leaves neither partially created.                                                                      |
| Owner/Admin with the required capability | As an Owner/Admin, I want to add a member so that a teammate can work in my organization.                          | Identify an existing active User by UUID and choose an allowed role. The server checks authorization and uniqueness within this organization, then directly creates an ACTIVE membership. |
| Owner/Admin with the required capability | As an Owner/Admin, I want to assign or change a member's role so that their access matches their responsibilities. | Change only a membership in the current organization. Validate the requested role and grant authority; preserve at least one active Owner. The user's memberships in other organizations remain unchanged.                                                   |

### Business Value

SMBs keep sensitive customer, vendor, payment, and financial information in their workspace. A user may participate in several businesses, but membership in one must never grant access to another. Strict tenant isolation prevents accidental disclosure, unauthorized financial activity, and incorrect attribution of actions. Organization-scoped capabilities and membership-based actors make subsequent financial workflows and audit history trustworthy.

## 2. Domain Model & Logic

### Entities

| Entity                                  | Conceptual fields from the domain model                                           | Responsibilities                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Organization`                          | `id`, `name`, `baseCurrency`, `status`, `accountingTimezone`, `financialSettings` | Primary tenant and resource-ownership boundary. Anchors the single base currency used in v1 and the timezone used to derive accounting dates. Owns financial-control settings and system ledger mappings.              |
| `User`                                  | `id`                                                                              | Authenticated human identity. A User is not itself tenant-owned and has no organization-wide authority without the relevant membership. Docs 01–03 do not define email, display name, credentials, or identity lookup. |
| `Membership` / `OrganizationMembership` | `userId`, `organizationId`, `role`, `status`                                      | Connects exactly one User to exactly one Organization and determines participation and permissions there. Both names refer to the same domain concept, not separate entities.                                          |

Relationships: a User may belong to multiple Organizations; an Organization has multiple Memberships; User ↔ Organization is many-to-many through Membership. A role belongs to a Membership, never globally to a User. The roles are Owner, Admin, Accountant, Finance Member, and Viewer; the confirmed storage/wire values are listed in §4.

Every actor reference in tenant-owned business records identifies a membership in that same organization. Membership reference identity must be stable for audit and historical records; its physical key design belongs to database design.

`OrganizationFinancialSettings` is the existing value object containing `largeTransferThreshold` and `largeReversalThreshold`. It is not a fourth membership entity. Threshold initialization and editing are outside this feature's scope; no threshold defaults or automatic financial setup are assumed.

### Invariants

1. **One membership per user per organization.** The pair `(organizationId, userId)` is unique, regardless of membership status. Membership in Org A does not prevent the same User joining Org B.
2. **At least one active OWNER.** Creation establishes the creator as an active Owner. Any role change that would leave the organization with no active Owner is rejected. Concurrent changes must preserve this invariant as well as sequential changes. Future status/removal workflows must preserve it too.
3. **Atomic creation.** The Organization, creator's Owner membership, and corresponding audit history commit together or not at all. The creator is the authenticated User, not a client-supplied actor. The audit actor can reference the membership created in that transaction.
4. **Membership controls participation.** Protected access requires an authenticated User, an active membership in the selected organization, the required capability, and a resource belonging to that organization. Inactive memberships grant no protected access.
5. **Tenant-consistent references.** Target and acting memberships belong to the same organization as the operation. Knowing an organization, user, or membership identifier is not authorization.
6. **Capabilities govern actions.** The server derives capabilities from the acting membership's role. Requested target roles are validated separately; accepting a requested role never makes the caller that role. Only the five established roles are valid.
7. **No cross-organization role effects.** A role change updates only the selected Membership. Authorization on subsequent requests must reflect committed changes; stale role claims must not retain privileges.
8. **Single base currency and explicit timezone.** Organization creation requires valid configuration for v1's single-currency semantics and accounting date derivation. Do not infer the accounting timezone from the server's local timezone. Post-creation currency/timezone changes require a separate policy.
9. **Auditable management changes.** Successful creation, member addition, and role changes produce append-only, tenant-scoped audit history with the authenticated actor, target, timestamp, correlation information, and necessary before/after metadata. Failed writes leave no successful-change audit record. Do not record credentials, tokens, or full request payloads.

Organization status is `ACTIVE`/`SUSPENDED`; membership and user status is `ACTIVE`/`INACTIVE`. This API creates active organizations/memberships and exposes no status-transition endpoint. Status administration remains deferred.

### Use-Case Behavior

**Create organization:** authenticate the User; validate the submitted organization fields; create the Organization and initial active Owner membership within one transaction; persist audit history; return the created resources only after commit. The absence of an existing membership must not block this bootstrap operation. It grants no access to an existing organization. Organization names are not assumed globally unique.

**Add member:** authorize the acting membership in the organization; resolve the intended User using the agreed identity mechanism; validate the target role and grant authority; enforce unique membership; create the membership and audit history atomically. A duplicate request for an existing membership produces a conflict and does not change its role. Role changes use the separate role-change operation. A User already belonging to another organization is not a duplicate in this one.

**Change role:** authorize the actor and load the target membership under the same organization; validate the requested role and assignment policy; check Owner retention in the same transaction as the update; commit the role change and audit history together. An unchanged role is a successful no-op and must not create a fictitious role-change audit event. Competing Owner demotions must not both succeed if they would leave no active Owner.

## 3. Accounting Impact

Organization creation, member addition, and role changes have **no direct ledger impact**. They create no journal entries, debits, credits, opening balances, or movements of money. Audit history records management actions and does not substitute for accounting history.

This feature establishes prerequisites for financial operations:

- Every financial resource and actor is scoped to an Organization and its Memberships.
- `baseCurrency` anchors v1 currency consistency; `accountingTimezone` determines accounting dates.
- Organization financial settings later govern large-transfer and large-reversal approvals.
- System ledger roles must map to organization-owned ledger accounts before posting: `ACCOUNTS_PAYABLE`, `ACCOUNTS_RECEIVABLE`, `DEFAULT_REVENUE`, `BANK_FEES`, and `OPENING_BALANCE_EQUITY`.

User roles such as Owner/Admin are authorization groupings; system ledger roles are accounting mappings. They are separate concepts. Creating an organization does not imply a configured chart of accounts or posting readiness. Missing required ledger mappings must reject subsequent posting as a configuration error; this feature does not invent defaults, mappings, or a chart-of-accounts setup workflow.

## 4. Technical Specification

### Persistence decisions

The persistence model uses Direct Add (no invitations), Owner-only promotion,
organization status `ACTIVE`/`SUSPENDED`, user and membership status
`ACTIVE`/`INACTIVE`, and role storage values `OWNER`, `ADMIN`, `ACCOUNTANT`,
`FINANCE_MEMBER`, `VIEWER`. UUID primary keys use PostgreSQL
`DEFAULT gen_random_uuid()`. Users have unique email, password hash, and full
name; all three tables have creation/update timestamps. These decisions
supersede the earlier conceptual status and invitation questions.

The [database contract and verification guide](../database.md) documents the
implemented schema, tenant-aware membership reference key, migrations, and
development seed. Organization management provides creation idempotency, authorization, audited
commands, and concurrency-safe Owner retention as described below.

### Implementation contract

- **Authority (Option A):** Owners may assign all five roles and edit any member,
  including themselves, subject to active-Owner retention. Admins may add/edit
  only ACCOUNTANT, FINANCE_MEMBER, and VIEWER memberships. Both the target's current
  role and requested role must be in that set; Admins cannot edit themselves,
  other Admins, or Owners, including unchanged-role requests.
- **Capabilities:** authenticated active users have `org:create`. Active Owner/Admin
  memberships have `org:read`, `member:read`, `member:invite`, and `member:edit`.
  Other roles receive none of these tenant management capabilities by default.
- **Direct Add:** `{ userId, role }` identifies an existing active global User by
  UUID; successful additions are immediately ACTIVE. There is no invitation,
  email lookup, account creation, or unrestricted user directory. Duplicate
  membership is `409` across every status. Absent/inactive target Users return the
  same `404` only after tenant authorization.
- **Validation:** reject unknown body/query fields and server-controlled fields.
  Accept UUID identifiers (case-insensitive, normalized to lowercase), names of
  1–200 UTF-16 code units after trimming (no NUL), uppercase currencies from
  Node's `Intl.supportedValuesOf("currency")`, and explicit named timezones accepted
  by `Intl.DateTimeFormat`, including UTC (maximum 100 characters; numeric offsets
  are rejected). Only the five exact uppercase role values are accepted.
- **Pagination:** `limit` defaults to 25 and is bounded to 1–100. Keyset order is
  ascending `userId` using the existing `(organization_id, user_id)` unique index.
  `nextCursor` is an opaque base64url encoding of organization UUID and last user
  UUID, bound to the selected tenant. Empty/end pages return `nextCursor: null`.
  List DTOs contain only `userId`, `organizationId`, `role`, and `status`.
- **Creation retry identity:** require a 1–128 character `Idempotency-Key` containing
  letters, digits, `.`, `_`, `:`, or `-`. Scope it to authenticated User plus
  `organization:create`; hash the normalized validated fields in fixed order.
  Same-key/same-payload retries return the original `201` snapshot; changed payloads
  return `409`. An active membership is checked again before replay. Keys expire
  after 24 hours; retained expired keys return `409` and cannot create a second
  organization. Inspect the existing organization before deliberately starting
  a new creation with a new key. Startup and five-minute cleanup batches compact
  up to 1000 expired snapshots to EXPIRED tombstones, clearing response data but
  retaining the row, creator/tenant scope and unique key permanently. Keys are
  never reusable; this reduces payload growth, not the total tombstone count.
- **Transactions and concurrency:** the service owns Kysely READ COMMITTED
  transactions. Creation locks the global creator User row before retry lookup,
  then commits Organization, Owner, audit, and completed idempotency record together.
  There is no committed IN_PROGRESS record or external work inside a transaction.
  Member mutations serialize with `FOR UPDATE` on the organization root; reads
  use `FOR SHARE`. Visibility is checked before root lookup and capabilities are
  rechecked after acquiring the lock. Last-Owner validation and role update occur
  under the same lock/transaction; inactive Owners do not count. Future status,
  removal, or membership writers must follow this same locking protocol.
- **Audit:** additive migration `003_organization_management` creates `audit_events`
  and `idempotency_records`, without rewriting old migrations or identity/session
  data. Audit actions are ORGANIZATION_CREATED, MEMBER_ADDED, MEMBER_ROLE_CHANGED.
  Human actor references use `(organization_id, membership_id, user_id)` to prevent
  both cross-tenant and wrong-user attribution. Audit includes target, timestamp,
  correlation UUID, and minimal before/after DTOs; no credentials or full request
  payloads. PostgreSQL rejects audit UPDATE, DELETE, and TRUNCATE. Replayed creation,
  failed requests, and unchanged roles create no new successful-change audit event.
- **Transport:** errors preserve the shared `{ error: string }` envelope and use
  server-generated `X-Request-Id` for correlation on organization routes (also
  stored on audit events). CORS permits credentialed PATCH and Idempotency-Key
  from WEB_ORIGIN and exposes X-Request-Id; existing JSON/Origin/CSRF checks apply.
  Generic infrastructure errors remain `503`; detected deadlock/serialization
  conflicts are `409`. Status values are returned as stored; this feature adds
  no organization suspension/activation policy or lifecycle administration.

`idempotency_records` currently serves organization creation. Membership addition
uses uniqueness (duplicates are conflicts); repeated unchanged role assignments
are no-ops. Before wiring future tenant commands, define their tenant-aware command
identity and retention/recovery semantics. Financial command idempotency and
lease recovery remain unimplemented.

### API Contract

The shared package owns role/status vocabulary. Organization errors carry
application reasons, and Presentation owns HTTP status/message and
diagnostic-category mapping. The application service owns authorization,
locking, and audit/idempotency orchestration; the repository enforces write-lock
preconditions.

These endpoints are implemented in `apps/api/src/modules/organizations`. Paths use `:id` as the Organization identifier. JSON uses the domain's `organizationId` spelling; `organization_id` denotes the equivalent persistence tenant key, not a second field. Identifiers are validated at the boundary.

| Method and path                            | Request                                                                             | Success                                                                                                     | Authorization                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /organizations`                      | `{ name, baseCurrency, accountingTimezone }`; required `Idempotency-Key` header.      | `201` with `{ organization, membership }` for the new tenant and its creator (or replayed result).          | Authenticated User; `org:create` eligibility; no pre-existing membership required.       |
| `GET /organizations/:id`                   | Organization path identifier.                                                       | `200` with the organization's settings DTO.                                                                 | Active membership in `:id` and `org:read`.                                               |
| `GET /organizations/:id/members`           | Organization path identifier; optional `cursor` and bounded `limit`.                | `200` with `{ items, nextCursor }`. Items contain membership fields and only approved user identity fields. | Active membership in `:id` and `member:read`.                                            |
| `POST /organizations/:id/members`          | Existing-user form: `{ userId, role }`.                                             | `201` with the created ACTIVE membership.                                                                  | Active membership in `:id`, `member:invite`, and authority to assign the requested role. |
| `PATCH /organizations/:id/members/:userId` | `{ role }` only; target is the membership identified by `(organizationId, userId)`. | `200` with the updated membership, including for an unchanged role.                                         | Active membership in `:id`, `member:edit`, and authority to assign the requested role.   |

The existing-user form implements the confirmed Direct Add decision. It introduces no email lookup, invitation acceptance, notifications, automatic account creation, or unrestricted user discovery.

Organization DTO fields are `id`, `name`, `baseCurrency`, `status`, and `accountingTimezone`; financial settings may be included only under the agreed read policy. Membership DTO fields are `userId`, `organizationId`, `role`, and `status`. Do not return raw database models, authentication data, or unrelated user memberships.

**Validation and errors:**

- Validate names, currencies, timezones, role/status serialization, identifiers, and pagination against the confirmed implementation contract above.
- Reject unknown or server-controlled input fields. Clients cannot choose organization IDs, creator identity, membership status, audit actors, or their own effective privileges. The role field is a requested target role, subject to server authorization. Tenant identity is resolved from the path and authenticated access context, never overridden by a request body.
- Use `400` for invalid identifiers, bodies, role values, or pagination; `401` for missing/expired authentication; `403` for an accessible organization where the actor lacks the required capability; `404` for an organization/resource not visible to the caller, including cross-tenant targets; `409` for duplicate membership, last-Owner violations, or detected concurrent-update conflicts.
- Use the same non-disclosing response for absent and inaccessible tenant resources. Error responses use the shared API error format and correlation identifier; do not expose SQL, stack traces, or information about other tenants. The exact error envelope is a shared API decision, not defined by docs 01–03.
- Return a generic infrastructure failure on an unsuccessful transaction and no partial management state. After an uncertain creation response, retry with the same key and payload within the retention window. Membership uniqueness prevents duplicate additions, but a duplicate conflict is not a replayed success response.

### Tenant Isolation and Repository Boundaries

The existing `organizations` backend module owns these use cases. Presentation parses and validates requests and extracts authentication; application services authorize and own transaction boundaries; domain rules enforce membership/ownership invariants; infrastructure repositories implement scoped persistence. Other modules consume supported interfaces rather than modifying membership persistence directly.

Enforcement follows the architecture's chain:

```text
Authentication → Active Organization Membership → Capability Authorization
→ Organization-scoped Repository Queries → Tenant-aware Database Constraints
```

- Require organization context centrally in tenant-scoped repository interfaces. Load tenant-owned resources by `findById({ organizationId, id })`, never `findById(id)`. All list, count, existence, read, and mutation queries carry the same tenant scope. Loading the Organization root itself uses its ID only after the membership/access check; authenticated creation is the explicit bootstrap exception.
- For membership changes, use the organization plus target User identifier; never load/update by `userId` alone. Resolve global User identity through a narrowly authorized identity boundary; this does not grant access to that User's other memberships.
- Use a unique `(organization_id, user_id)` membership constraint and tenant-aware composite foreign keys for references between tenant-owned records. A record's actor reference must include its `organization_id` and identify a membership from the same tenant. The global User reference is not an organization-owned resource.
- Scope reads and writes in PostgreSQL and enforce referential integrity there; application checks alone are insufficient. Enforce Owner retention under concurrency using a bounded transaction that serializes competing changes for the organization, with database enforcement defined in the schema design.
- PostgreSQL RLS remains optional defense in depth. If adopted, establish tenant context safely for each transaction/pooled connection; it supplements authorization. Background work needs deliberate tenant policies. This specification does not require a new RLS architecture.
- Read current authoritative membership/role state for authorization, or invalidate any authorization cache/claims when it changes. Check permission again on submission even if the UI previously displayed an enabled control.

**Database design — implemented by the additive `003_organization_management` migration:**

| Pillar      | Required treatment in later implementation                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrity   | Explicit required fields, valid role/status values, membership uniqueness, tenant-aware references, atomic creation/audit, and concurrency-safe Owner retention.             |
| Security    | Server authorization, centralized tenant scoping, parameterized repository queries, least-privilege access, and minimal user-data projection.                                |
| Performance | Bounded member pagination with deterministic ordering; review organization/member and user-membership lookup indexes against actual queries; avoid per-row identity queries. |
| Scalability | Store individual memberships rather than an unbounded organization-embedded member array; keep application state in shared persistence.                                      |
| Reliability | Short transactions with no external calls; roll back partial writes; define safe retries; preserve historical actor references and audit history.                            |

Integration tests verify schema constraints, migration rollback/reapplication, preservation of existing sessions, query plans for scoped member lookup/pagination, authorization, transaction rollback, and concurrency. Index creation on the existing membership table takes a schema lock; plan migration execution for the deployment's data volume. Rollback drops the two new tables and requires approval on shared data; prefer a forward fix where history must be preserved.

### RBAC — Feature Capabilities

These capabilities are implemented for organization management. The complete financial role-to-capability matrix remains deferred. Assignment authority is separately constrained by the confirmed strict Owner/Admin policy above.

| Capability      | Meaning                                                       | Intended access for this feature                                                                                          |
| --------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `org:create`    | Create a new organization and bootstrap its Owner membership. | Authenticated new user; eligibility cannot depend on membership in the organization that does not yet exist.              |
| `org:read`      | View the current organization's settings.                     | Owner/Admin for the requested management page; other roles' settings visibility requires an explicit grant in the matrix. |
| `member:read`   | List memberships in the current organization.                 | Owner/Admin for member management; other roles' member visibility requires an explicit grant in the matrix.               |
| `member:invite` | Request addition of a member with an allowed role.            | Owner/Admin, subject to role-assignment policy. The name does not imply an invitation lifecycle.                          |
| `member:edit`   | Change an existing member's role.                             | Owner/Admin, subject to role-assignment policy and Owner retention.                                                       |

Accountant, Finance Member, and Viewer receive no membership mutation capability from this feature. Capabilities must be checked in application services rather than scattered Owner/Admin string comparisons. The existing `financial_controls:manage` capability is separate; managing members does not implicitly grant threshold editing, financial approvals, or posting capabilities.

### Dynamic access authorization

Tenant access now comes from `permissions` and `role_permissions`, seeded by
`004_rbac_permissions`. The role column uses the existing `membership_role` enum.
The capability table above describes initial grants, not hardcoded runtime
access: removing an Admin's `member:invite` mapping denies the next request with
`403`; restoring it permits Direct Add again, subject to Option A. Granting Viewer
`org:read` permits settings reads without changing that user's role.

`RequestCapabilityResolver` loads active membership and all mapped codes in one
tenant/user-scoped left join. Its cache lasts only for the request's application
transaction; no grant is stored in the session or shared across requests. A role
with no mappings receives zero tenant capabilities. After the organization lock
is acquired, the cached snapshot is invalidated and reloaded so lock contention
cannot preserve a revoked capability or an earlier privileged membership role.
Application authorization checks use `capabilities.includes(...)`, with no
role-name comparisons or fallback grants in that layer. `authenticate` and the
public HTTP request/response contracts remain unchanged.

The confirmed hybrid model keeps three structural domain rules explicit:
authenticated active-user organization bootstrap, Option A assignment limits,
and Last Owner retention. These are independent of configurable endpoint access.
`org:create` is present in the catalog but is not mapped to a membership role;
a new user needs no existing membership to create an organization. In particular,
giving a Viewer a mutation capability does not grant assignment authority, and
granting an Admin all capabilities still cannot permit editing Owners/Admins or
promoting a standard member to OWNER/ADMIN. Capability checks themselves are
not audited; mutations keep their existing audit behavior.

Role/permission mappings apply globally, while membership and resources remain
tenant-scoped. Permission administration is trusted database work; no permission
management UI or grant-writing API is provided. See the [database guide](../database.md#dynamic-capabilities)
for schema, deployment, indexes, cache lifecycle, and rollback details.

### Mutation port preconditions

`OrganizationService` remains the only production consumer of organization
transaction/repository operations. Routes receive service methods; startup and
`createApp` only wire the persistence dependency. The API boundary test checks
resolved port calls (including aliases/bracket calls), restricts persistence
capability references to service/adapter/wiring files, and detects literal
organization-table writes outside the adapter. It is an architectural regression
check, not protection against arbitrary SQL or deliberately erased types.

For an existing tenant, the same repository instance must successfully await
`organization("write")` before adding/changing members, querying other active
Owners, or writing audit. Read locks, an unawaited lock request, another repository
instance, and a previous transaction do not satisfy this runtime precondition.
New roots created in the current creator-locked transaction are the bootstrap
exception. This adds no database query or isolation-level change.

The service still owns active-Owner retention, Strict Option A,
active tenant/capability authorization, matching audit in the same
transaction (no audit for no-ops/denials), and post-lock authorization
refresh. The adapter guard does not independently authorize a locked caller,
enforce Owner count, or require a matching audit before arbitrary callbacks
commit. New writers must enter through the service or undergo a separate review
with the same lock/invariant/audit protocol.

### Remaining Deferred Work

Direct Add, strict role authority, status enums, bootstrap retry identity, and the
transport limits are settled above. Full financial RBAC, organization/member
lifecycle administration, financial settings initialization/editing, organization-creation UI, signup,
and idempotency cleanup or future command lease recovery remain outside the membership-management scope.

### Verification

Build workspace dependencies, set `TEST_DATABASE_URL` to a disposable PostgreSQL
database, and run `npm run test:integration --workspace=@ledgerflow/api`.
`tests/integration/organizations-postgres.test.mjs` creates/removes only its own
random schema. It covers Last Owner (including concurrent demotions), Tenant Leak,
strict Admin authority, live authorization after lock contention, creation replay,
audit failure rollback for every mutation, validation, pagination/query plans,
append-only audit enforcement, actor references, and additive migration compatibility.

Verified October 18, 2026 on Node 24.5.0 and disposable PostgreSQL 16.11: all 18
organization cases passed, including Last Owner/race and Tenant Leak. The combined
API integration run passed 27 checks; API unit/health (14), identity database (12),
and web (4) checks also passed. Repository lint, type-check, and build passed;
unchanged shared/web work used Turbo cache. The available npm was 10.8.1 (the
repository targets npm 11). No development database migration or data changes
were performed. Browser interaction over a production HTTPS/proxy deployment
and migration lock duration on a large existing membership table remain unverified.

## 5. UI/UX Requirements

### Organization Creation

An authenticated new user can enter the organization name, base currency, and accounting timezone. Require explicit valid selections rather than silently assuming a currency or the server's timezone. Explain that v1 uses one base currency and that creation gives the user the Owner role. Show field-level validation, pending submission, and a clear error/success outcome. After confirmed creation, open that organization's settings with its identity visible.

Do not present automatic accounting setup or posting readiness as a creation outcome. Recover an uncertain creation response with the original key and payload within the retention window; never silently generate a new key for a retry.

### Organization Settings Page

Use the existing app shell, design tokens, and reusable controls. Reach the page through Settings in the current organization context, and keep the organization name visible so users can identify the tenant being managed. The identity pages use the responsive shell; financial sections remain previews.

Display the organization's name, base currency, accounting timezone, and status, plus the Member Management section when permitted. This view supports reading those organization fields; post-creation editing of currency/timezone, threshold management, ledger mappings, and organization lifecycle actions are outside its scope. Show only sections the caller may read; backend authorization remains authoritative for direct navigation and requests.

### Member Management Table

- Display User identifier (or an approved identity label once defined), role, membership status, and permitted role-change action. Do not assume email/display-name fields absent from the domain model. Clearly identify the current user's row.
- Render one row per membership and paginate with the API. Do not infer a total membership count from the current page or require an unbounded full-team fetch.
- Provide Add member for callers with `member:invite` and role controls for callers with `member:edit`. Role choices also respect the agreed assignment policy; hiding a choice does not replace server validation.
- Explain a rejected last-Owner change. Preserve the displayed committed role after an unsuccessful change and refresh authoritative data after a conflict. Do not claim success until the server confirms it.

### Add-Member Flow

1. Owner/Admin opens Organization Settings and selects Add member in the visible organization context.
2. Show a form identifying the target organization, the intended User UUID, and role choices permitted by the confirmed assignment policy. No global search or email invitation flow is supplied by this API.
3. Require an explicit role selection; do not silently default to a privileged role. Validate required fields and show errors near their controls.
4. On submission, disable duplicate submissions and show progress. The server rechecks current active membership, capability, target-role authority, and membership uniqueness.
5. After confirmed persistence, show the returned membership/status, close or reset the form, and refresh the table. Do not say “invitation sent” or “member active” unless the agreed contract and response establish that outcome.
6. On validation/conflict errors, retain entered values and explain the correction. On permission loss or inaccessible organization, stop the operation and show an access error. On an uncertain network result, refresh membership state before offering a retry; never automatically turn an addition into a role update.

### View States and Accessibility

Provide loading placeholders; a clear no-results state; an error state with a retry where safe; and announced success feedback. A newly created organization's full member list includes its Owner, so a truly empty organization membership set is an invariant failure rather than a normal “no members yet” state. An empty later page can offer navigation back to the first page.

Use semantic headings/table markup, associated form labels and field errors, keyboard-operable controls, visible focus, and accessible status announcements. If the form uses a dialog, manage focus on open/close and validation failures. At mobile widths preserve readable organization identity, member identity, role, status, and actions without clipping controls or relying on color alone.


## 6. Tenant Repositories and Identity UI

### Approved organization discovery

`GET /organizations?limit=25&cursor=<organization UUID>` requires authentication.
It returns `{ items, nextCursor }` ordered by organization UUID. The default page
limit is 25; maximum 100. The cursor is the last returned organization UUID.
Invalid limits, UUIDs, repeated fields, or unknown query fields return `400`;
missing/expired authentication returns `401`. Errors use `{ error: string }` with
`X-Request-Id`, matching the existing organization error contract.

Each item has `id`, `name`, the caller's `membership` (userId, organizationId,
role, ACTIVE status), and `capabilities: string[]`. The database query filters by
authenticated userId and ACTIVE membership/organization before pagination.
Clients cannot choose another user. No other member profiles, financial settings,
or session details are exposed. One batched role-grant query supplies current
capability hints; unmapped roles receive an empty list. Every tenant endpoint
still authorizes against authoritative membership/capabilities in its transaction.

### Implemented UI and flow refinements

- `/login` accepts email/password, then opens `/organizations`. No signup flow.
- Selection is explicit even for one organization. The page also shows the user's
  UUID for sharing with an administrator for Direct Add. React context holds the
  selected organization and its access hints in memory only. Refreshing Settings
  checks the session then reopens selection. Switching, logout, and protected-request
  `401` clear context. No organization ID or credentials enter browser storage.
- `/settings/organization` shows name, currency, accounting timezone, and status.
  The shell shows actual user/tenant identity, links Settings without losing
  context, and supports switching organization and signing out.
- Members appear when `member:read` is granted, with 25-row cursor pagination,
  Next/First page controls, UUID, role, status, current-user marker, and permitted
  role selects. The page never presents its row count as a total team size.
- Add member uses the accessible Radix drawer, existing User UUID, and an explicit
  role selection. It is Direct Add; no email invitation or account creation.
  Both capability hints and structural Owner/Admin assignment limits govern
  controls. The server rechecks all permissions on submission.
- Confirmed writes announce returned UUID/role/status and refresh members. Failed
  role changes preserve committed state. Conflict/uncertain writes reload before
  a manual retry; failed reload or permission loss pauses changes. A self-role
  change returns to selection to reload capabilities.
- Protected `401` returns to Login. `403` announces **Permission Denied**, the
  shared API message, and correlation reference where present. Inline form errors,
  pending controls, loading/empty/error states, safe read retries, semantic tables,
  keyboard focus restoration, and stacked member rows with visible actions on mobile
  are included.

Set public `NEXT_PUBLIC_API_URL=http://localhost:4000` before starting/building web;
use web `http://localhost:3000` and matching WEB_ORIGIN locally. Next validates the
public origin at startup and embeds it at build time. Browser requests use the
existing credentialed CORS/cookie/CSRF contract directly; API_URL remains server-only
for health. No frontend authentication proxy or trusted-IP policy is added.
Production retains the existing same-site HTTPS requirement.

### Repository pattern

`apps/api/src/infrastructure/tenant-repository.ts` defines
`BaseTenantRepository<Resource>`. Each instance captures immutable organization
and actor IDs from an authenticated transaction's checked repository factory.
Typed inherited find/update/delete query factories automatically apply this
parameterized scope before resource filters; callers cannot substitute another
tenant per method. `insertValues` injects organization_id and rejects supplied
ownership fields. `ensureOrganization` fails closed if a returned resource belongs
to another organization. OrganizationStore uses these for membership lookup,
pagination, Owner existence, and role updates, and verifies memberships returned
from reads/inserts/updates. Its transaction-bound tenant repository interface stays
decoupled from Kysely; root locking scopes organizations.id because the root itself
has no organization_id column. Missing role-update targets now return a controlled
404 instead of a query-builder exception.

Creation and authenticated user-scoped discovery are explicit identity/bootstrap
exceptions. Future Expense/Invoice repositories inherit the base and expose
domain-specific methods with mandatory tenant context; inserts, joins, counts,
and existence checks must also remain scoped. There is no generic delete API or
change to immutable audit/history behavior. Existing
user-membership and tenant/member indexes are covered by integration EXPLAIN checks;
transaction, audit, idempotency, and concurrent Owner retention remain in force.

The hardening migration `005_tenant_relationship_guards` adds composite FKs for
audit membership targets and idempotency creators, plus organization-target and
creation-snapshot scope checks. See [deployment preflight and lock/rewrite
requirements](../database.md#tenant-isolation-hardening--migration-005).

`OrganizationStore.transaction({ userId }, work)` captures identity from the
authenticated session supplied by the service, never from a body tenant/user field.
`forOrganization` is asynchronous and verifies that user's active membership
before issuing a repository. The bootstrap exception covers only organization IDs
actually created in that same transaction after locking its active creator.
Discovery/idempotency lookup use the captured user, not a replacement caller ID.
Capability resolution rejects returned membership/user scope mismatches; capability
checks remain in the service and are reloaded after acquiring the organization lock.
Audit insertion checks the actor against the repository's tenant and session user.
Creation replay checks stored snapshot ownership before returning any response.

HTTP paths, bodies, status conventions, session cookies, global identity access,
and role-assignment/Owner policies are unchanged. Only the internal repository
transaction interface changes; alternate stores must implement the same context
and membership contract. A scoped repository is valid only inside its transaction.
Repository code must not bypass inherited scope helpers with raw/unscoped SQL;
composite FKs and application types do not make arbitrary SQL tenant-safe.

### Reproducible browser verification

Build backend dependencies, then use a disposable PostgreSQL database:

```powershell
npm run build
$env:TEST_DATABASE_URL = '<disposable PostgreSQL URL>'
$env:UI_BROWSER_EXECUTABLE = '<installed Chrome/Chromium executable>'
npm run test:identity-browser --workspace=@ledgerflow/web
```

The check creates a random schema, real Argon2 identities, API server, Next.js dev
server at 127.0.0.1:3135, and isolated Chromium profile. It cleans only its own
schema and server processes. Results/screenshots go to ignored
`test-results/identity-ui/`. It covers login, explicit selection/settings,
pagination, Direct Add, role updates, last-Owner conflict, revoked capabilities,
session expiry, Viewer denial, signout, keyboard focus, and responsive layout.
Production HTTPS/proxy deployment is a separate deployment check.


Verified October 19, 2026: 22 API unit checks, 8 web checks, 18 database checks,
and 32 API integration checks passed. The real Chromium flow passed at 1280px
and 375px with no uncaught browser errors; mobile member actions fit without
horizontal scrolling. Screenshots were visually reviewed. Lint, type-check, and
production build passed. Node 24.21.0 was used for final web/API and browser checks;
the available npm was 10.9.4 (repository target: npm 11). All database work used
a disposable local PostgreSQL 16 cluster; no development data was modified.
Existing identity/organization migrations must already be applied. No new migration
is introduced. Browser behavior behind production HTTPS/proxies remains unverified.
