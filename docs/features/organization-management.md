# Organization Management

## 1. Overview

### Goal

Allow an authenticated new user to create an organization, establish their membership as its initial Owner, and let authorized Owners/Admins add members and assign or change their organization-specific roles. An organization is the tenant boundary for all subsequent financial operations.

This feature belongs to the Identity & Organization context. It covers organization creation, viewing organization settings and members, adding a member, and changing a member's role. Account registration/authentication supplies the authenticated User; it is not implemented by this feature. Organization deletion, member removal, lifecycle administration, and financial configuration workflows are not specified here.

The six sections below use the task's Feature Document Template. Requirements explicitly supplied by the task, including unique memberships and retaining an Owner, supplement docs 01–03. Proposed transport details do not settle the unresolved domain decisions in §4.

### User Stories

| Actor                                    | Story                                                                                                              | Acceptance behavior                                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authenticated new user                   | As a new user, I want to create my organization so that my business has its own workspace.                         | Submit a name, base currency, and accounting timezone. Success creates the organization and the creator's active Owner membership atomically. Failure leaves neither partially created.                                                                      |
| Owner/Admin with the required capability | As an Owner/Admin, I want to add a member so that a teammate can work in my organization.                          | Identify the intended user, choose an allowed role, and submit. The server checks authorization and membership uniqueness within this organization before persisting the membership. The invitation/activation mechanism remains an explicit decision in §4. |
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

Relationships: a User may belong to multiple Organizations; an Organization has multiple Memberships; User ↔ Organization is many-to-many through Membership. A role belongs to a Membership, never globally to a User. The roles are Owner, Admin, Accountant, Finance Member, and Viewer. `OWNER` below denotes the Owner role, not an already agreed wire/storage enum.

Every actor reference in tenant-owned business records identifies a membership in that same organization. Membership reference identity must be stable for audit and historical records; its physical key design belongs to database design.

`OrganizationFinancialSettings` is the existing value object containing `largeTransferThreshold` and `largeReversalThreshold`. It is not a fourth membership entity. Threshold initialization and editing are not defined by this task; no threshold defaults or automatic financial setup are assumed.

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

Organization/membership status enums and transitions are not supplied by docs 01–03. “Active” expresses the existing access prerequisite; it does not introduce invitation or suspension states.

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

### API Contract — Initial Proposal

These endpoints describe the minimum transport surface for the requested flows. They are proposals, not existing routes. Paths use `:id` as the Organization identifier. JSON uses the domain's `organizationId` spelling; `organization_id` denotes the equivalent persistence tenant key, not a second field. Identifiers are opaque and validated at the boundary.

| Method and path                            | Request                                                                             | Success                                                                                                     | Authorization                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /organizations`                      | `{ name, baseCurrency, accountingTimezone }`                                        | `201` with `{ organization, membership }` for the new tenant and its creator.                               | Authenticated User; `org:create` eligibility; no pre-existing membership required.       |
| `GET /organizations/:id`                   | Organization path identifier.                                                       | `200` with the organization's settings DTO.                                                                 | Active membership in `:id` and `org:read`.                                               |
| `GET /organizations/:id/members`           | Organization path identifier; optional `cursor` and bounded `limit`.                | `200` with `{ items, nextCursor }`. Items contain membership fields and only approved user identity fields. | Active membership in `:id` and `member:read`.                                            |
| `POST /organizations/:id/members`          | Proposed existing-user form: `{ userId, role }`.                                    | `201` with the created membership. Activation semantics depend on the decision below.                       | Active membership in `:id`, `member:invite`, and authority to assign the requested role. |
| `PATCH /organizations/:id/members/:userId` | `{ role }` only; target is the membership identified by `(organizationId, userId)`. | `200` with the updated membership, including for an unchanged role.                                         | Active membership in `:id`, `member:edit`, and authority to assign the requested role.   |

The existing-user form is a minimal proposal based on the modeled User/Membership relationship. It does not establish email lookup, invitation acceptance, notifications, or automatic account creation. No endpoint for unrestricted user discovery is introduced. Confirm the member-identification/activation decision before implementing this contract.

Organization DTO fields are `id`, `name`, `baseCurrency`, `status`, and `accountingTimezone`; financial settings may be included only under the agreed read policy. Membership DTO fields are `userId`, `organizationId`, `role`, and `status`. Do not return raw database models, authentication data, or unrelated user memberships.

**Validation and errors:**

- Validate names as non-empty after trimming; validate currency and timezone against supported values. Exact length limits, supported currency set, role serialization, status values, and pagination limits must be documented in the implementation contract before coding.
- Reject unknown or server-controlled input fields. Clients cannot choose organization IDs, creator identity, membership status, audit actors, or their own effective privileges. The role field is a requested target role, subject to server authorization. Tenant identity is resolved from the path and authenticated access context, never overridden by a request body.
- Use `400` for invalid identifiers, bodies, role values, or pagination; `401` for missing/expired authentication; `403` for an accessible organization where the actor lacks the required capability; `404` for an organization/resource not visible to the caller, including cross-tenant targets; `409` for duplicate membership, last-Owner violations, or detected concurrent-update conflicts.
- Use the same non-disclosing response for absent and inaccessible tenant resources. Error responses use the shared API error format and correlation identifier; do not expose SQL, stack traces, or information about other tenants. The exact error envelope is a shared API decision, not defined by docs 01–03.
- Return a generic infrastructure failure on an unsuccessful transaction and no partial management state. A lost creation response has an uncertain outcome: do not automatically retry organization creation until its retry/idempotency policy is defined. Membership uniqueness prevents duplicate additions, but a duplicate conflict is not a replayed success response.

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
- Scope reads and writes in PostgreSQL and enforce referential integrity there; application checks alone are insufficient. Enforce Owner retention under concurrency using a bounded transaction that serializes competing changes for the organization, with database enforcement designed in the later schema task.
- PostgreSQL RLS remains optional defense in depth. If adopted, establish tenant context safely for each transaction/pooled connection; it supplements authorization. Background work needs deliberate tenant policies. This specification does not require a new RLS architecture.
- Read current authoritative membership/role state for authorization, or invalidate any authorization cache/claims when it changes. Check permission again on submission even if the UI previously displayed an enabled control.

**Database design implications — requirements only, no schema or migration changes in this task:**

| Pillar      | Required treatment in later implementation                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integrity   | Explicit required fields, valid role/status values, membership uniqueness, tenant-aware references, atomic creation/audit, and concurrency-safe Owner retention.             |
| Security    | Server authorization, centralized tenant scoping, parameterized repository queries, least-privilege access, and minimal user-data projection.                                |
| Performance | Bounded member pagination with deterministic ordering; review organization/member and user-membership lookup indexes against actual queries; avoid per-row identity queries. |
| Scalability | Store individual memberships rather than an unbounded organization-embedded member array; keep application state in shared persistence.                                      |
| Reliability | Short transactions with no external calls; roll back partial writes; define safe retries; preserve historical actor references and audit history.                            |

For the later database task, verify schema/validation enforcement, safe reversible migrations, index/query plans, tenant scoping and authorization, transaction/idempotency policy, and compatibility with existing records. This documentation task changes none of those mechanisms.

### RBAC — Initial Feature Capabilities

Capability names below are proposed for this feature. The complete role-to-capability matrix remains deferred by docs 01–03. These entries describe the task's intended management actors; they do not authorize unspecified role promotions or define permissions for other financial workflows.

| Capability      | Meaning                                                       | Intended access for this feature                                                                                          |
| --------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `org:create`    | Create a new organization and bootstrap its Owner membership. | Authenticated new user; eligibility cannot depend on membership in the organization that does not yet exist.              |
| `org:read`      | View the current organization's settings.                     | Owner/Admin for the requested management page; other roles' settings visibility requires an explicit grant in the matrix. |
| `member:read`   | List memberships in the current organization.                 | Owner/Admin for member management; other roles' member visibility requires an explicit grant in the matrix.               |
| `member:invite` | Request addition of a member with an allowed role.            | Owner/Admin, subject to role-assignment policy. The name does not imply an invitation lifecycle.                          |
| `member:edit`   | Change an existing member's role.                             | Owner/Admin, subject to role-assignment policy and Owner retention.                                                       |

Accountant, Finance Member, and Viewer receive no membership mutation capability from this feature. Capabilities must be checked in application services rather than scattered Owner/Admin string comparisons. The existing `financial_controls:manage` capability is separate; managing members does not implicitly grant threshold editing, financial approvals, or posting capabilities.

### Unresolved Decisions in the Authoritative Docs

These points must be settled before implementing the affected behavior. They are not additional feature commitments.

1. **Adding versus inviting:** docs 01–03 model Membership but no invitation entity, acceptance flow, email identity field, or activation rules. Should the initial flow directly add an existing User (the minimal API proposal), or does the product require an invitation design? How is the User identified without exposing a global user directory?
2. **Role-assignment authority:** the complete permission matrix is explicitly deferred. Can Admins grant Owner/Admin, edit an Owner, or change their own role? What authority governs Owner promotion/demotion? The at-least-one-active-Owner invariant applies regardless; do not infer unrestricted assignment from `member:edit`.
3. **Status and initialization:** what Organization/Membership status values and transitions exist, and how are initial active state and `financialSettings` initialized? The schema must not invent status enums or monetary threshold defaults. Which financial settings may management DTOs expose?
4. **Creation retry identity:** financial command idempotency is defined, but organization creation has no existing tenant key and no defined idempotency scope. Agree how a retry after a lost response recovers the first result without accidentally creating a second organization; do not assume names are unique.
5. **Shared transport details:** confirm identifier formats, role serialization, field limits, pagination defaults/maxima, and the standard error envelope. Docs 01–03 specify concepts and error classes rather than these wire details.

## 5. UI/UX Requirements

### Organization Creation

An authenticated new user can enter the organization name, base currency, and accounting timezone. Require explicit valid selections rather than silently assuming a currency or the server's timezone. Explain that v1 uses one base currency and that creation gives the user the Owner role. Show field-level validation, pending submission, and a clear error/success outcome. After confirmed creation, open that organization's settings with its identity visible.

Do not present automatic accounting setup or posting readiness as a creation outcome. Do not silently resubmit creation after an uncertain network result; the recovery behavior depends on the retry decision in §4.

### Organization Settings Page

Use the existing app shell, design tokens, and reusable controls. Reach the page through Settings in the current organization context, and keep the organization name visible so users can identify the tenant being managed. The current shell is a preview; these are future feature requirements.

Display the organization's name, base currency, accounting timezone, and status, plus the Member Management section when permitted. This task specifies viewing those organization fields, not post-creation editing of currency/timezone, threshold management, ledger mappings, or organization lifecycle actions. Show only sections the caller may read; backend authorization remains authoritative for direct navigation and requests.

### Member Management Table

- Display User identifier (or an approved identity label once defined), role, membership status, and permitted role-change action. Do not assume email/display-name fields absent from the domain model. Clearly identify the current user's row.
- Render one row per membership and paginate with the API. Do not infer a total membership count from the current page or require an unbounded full-team fetch.
- Provide Add member for callers with `member:invite` and role controls for callers with `member:edit`. Role choices also respect the agreed assignment policy; hiding a choice does not replace server validation.
- Explain a rejected last-Owner change. Preserve the displayed committed role after an unsuccessful change and refresh authoritative data after a conflict. Do not claim success until the server confirms it.

### Add-Member Flow

1. Owner/Admin opens Organization Settings and selects Add member in the visible organization context.
2. Show a form identifying the target organization, the intended User, and role choices permitted by the agreed assignment policy. Use the existing-user identifier for the proposed API; do not introduce global search or an email invitation flow without resolving §4.
3. Require an explicit role selection; do not silently default to a privileged role. Validate required fields and show errors near their controls.
4. On submission, disable duplicate submissions and show progress. The server rechecks current active membership, capability, target-role authority, and membership uniqueness.
5. After confirmed persistence, show the returned membership/status, close or reset the form, and refresh the table. Do not say “invitation sent” or “member active” unless the agreed contract and response establish that outcome.
6. On validation/conflict errors, retain entered values and explain the correction. On permission loss or inaccessible organization, stop the operation and show an access error. On an uncertain network result, refresh membership state before offering a retry; never automatically turn an addition into a role update.

### View States and Accessibility

Provide loading placeholders; a clear no-results state; an error state with a retry where safe; and announced success feedback. A newly created organization's full member list includes its Owner, so a truly empty organization membership set is an invariant failure rather than a normal “no members yet” state. An empty later page can offer navigation back to the first page.

Use semantic headings/table markup, associated form labels and field errors, keyboard-operable controls, visible focus, and accessible status announcements. If the form uses a dialog, manage focus on open/close and validation failures. At mobile widths preserve readable organization identity, member identity, role, status, and actions without clipping controls or relying on color alone.
