import type { Kysely, Transaction } from "kysely";
import { BaseTenantRepository, tenantScope } from "./tenant-repository.ts";
import type { Database } from "@ledgerflow/db";
import type { MembershipRole } from "@ledgerflow/shared";
import { ACTIVE_ORGANIZATION_STATUS } from "../modules/organizations/policy.ts";
import { OrganizationError, type AuditChange, type CreateOrganizationInput, type CreationResult,
  type StoredMembership, type AuthenticatedContext, type OrganizationRepository, type OrganizationStore, type OrganizationTransaction, type PageInput } from "../modules/organizations/types.ts";

const CREATION_COMMAND = "organization:create";
const ORGANIZATION_FIELDS = ["id", "name", "base_currency as baseCurrency", "accounting_timezone as accountingTimezone", "status"] as const;
const MEMBER_FIELDS = ["id", "user_id as userId", "organization_id as organizationId", "role", "status"] as const;

class ScopedOrganizationRepository extends BaseTenantRepository<StoredMembership> implements OrganizationRepository {
  private readonly trx: Transaction<Database>;
  private writeLocked: boolean;

  constructor(trx: Transaction<Database>, context: AuthenticatedContext & { readonly organizationId: string }, bootstrap = false) {
    super(context);
    this.trx = trx;
    // A root inserted by this transaction is already exclusively owned by it.
    this.writeLocked = bootstrap;
  }

  private requireWriteLock(): void {
    if (!this.writeLocked) throw new Error("Organization write lock is required.");
  }

  async findMembership(userId: string) {
    const member = await this.find(this.trx.selectFrom("memberships")).select(MEMBER_FIELDS)
      .where("user_id", "=", userId).executeTakeFirst();
    return member && this.ensureOrganization(member);
  }

  async organization(lock: "read" | "write") {
    const query = this.trx.selectFrom("organizations").select(ORGANIZATION_FIELDS).where(this.scope("organizations.id"));
    const organization = await (lock === "write" ? query.forUpdate() : query.forShare()).executeTakeFirst();
    if (organization && lock === "write") this.writeLocked = true;
    return organization;
  }

  async listMembers(page: PageInput) {
    let query = this.find(this.trx.selectFrom("memberships")).select(MEMBER_FIELDS);
    if (page.cursor) query = query.where("user_id", ">", page.cursor);
    const members = await query.orderBy("user_id").limit(page.limit + 1).execute();
    return members.map((member) => this.ensureOrganization(member));
  }

  async addMember(userId: string, role: MembershipRole) {
    this.requireWriteLock();
    const member = await this.trx.insertInto("memberships").values(this.insertValues({
      user_id: userId, role, status: "ACTIVE" as const })).returning(MEMBER_FIELDS).executeTakeFirstOrThrow();
    return this.ensureOrganization(member);
  }

  async changeRole(userId: string, role: MembershipRole) {
    this.requireWriteLock();
    const member = await this.update(this.trx.updateTable("memberships")).set({ role, updated_at: new Date() })
      .where("user_id", "=", userId).returning(MEMBER_FIELDS).executeTakeFirst();
    if (!member) throw new OrganizationError("RESOURCE_NOT_FOUND", "Membership not found.");
    return this.ensureOrganization(member);
  }

  async hasOtherActiveOwner(userId: string): Promise<boolean> {
    this.requireWriteLock();
    const owner = await this.find(this.trx.selectFrom("memberships")).select("id")
      .where("role", "=", "OWNER").where("status", "=", "ACTIVE").where("user_id", "!=", userId).limit(1).executeTakeFirst();
    return owner !== undefined;
  }

  async audit(change: AuditChange): Promise<void> {
    this.requireWriteLock();
    this.ensureOrganization(change.actor);
    if (change.actor.userId !== this.actorUserId) throw new Error("Audit actor does not match the authenticated user.");
    await this.trx.insertInto("audit_events").values(this.insertValues({
      actor_kind: "HUMAN", actor_membership_id: change.actor.id, actor_user_id: change.actor.userId,
      correlation_id: change.correlationId, action: change.action, target_type: change.targetType, target_id: change.targetId,
      previous_state: change.previousState === null ? null : JSON.stringify(change.previousState),
      new_state: JSON.stringify(change.newState) })).execute();
  }
}

class PostgresOrganizationTransaction implements OrganizationTransaction {
  private readonly trx: Transaction<Database>;
  private readonly userId: string;
  private readonly createdOrganizations = new Set<string>();
  private creatorLocked = false;
  constructor(trx: Transaction<Database>, userId: string) { this.trx = trx; this.userId = userId; }

  async listForUser(page: PageInput) {
    // Discovery is an identity boundary, scoped to the authenticated user before pagination.
    let query = this.trx.selectFrom("memberships as m").innerJoin("organizations as o", "o.id", "m.organization_id")
      .select(["o.id", "o.name", "m.user_id as userId", "m.role", "m.status"])
      .where("m.user_id", "=", this.userId).where("m.status", "=", "ACTIVE").where("o.status", "=", "ACTIVE");
    if (page.cursor) query = query.where("o.id", ">", page.cursor);
    const organizations = await query.orderBy("o.id").limit(page.limit + 1).execute();
    if (!organizations.length) return [];
    const roles = [...new Set(organizations.map((item) => item.role))];
    const grants = await this.trx.selectFrom("role_permissions as rp").innerJoin("permissions as p", "p.id", "rp.permission_id")
      .select(["rp.role", "p.code"]).where("rp.role", "in", roles).execute();
    return organizations.map((item) => ({ id: item.id, name: item.name,
      membership: { userId: item.userId, organizationId: item.id, role: item.role, status: item.status },
      capabilities: grants.filter((grant) => grant.role === item.role).map((grant) => grant.code) }));
  }

  async findAuthorization(organizationId: string, userId: string) {
    if (userId !== this.userId) return undefined;
    const rows = await this.trx.selectFrom("memberships as m")
      .leftJoin("role_permissions as rp", "rp.role", "m.role")
      .leftJoin("permissions as p", "p.id", "rp.permission_id")
      .select(["m.id", "m.user_id as userId", "m.organization_id as organizationId", "m.role", "m.status", "p.code"])
      .where(tenantScope(organizationId, "m.organization_id")).where("m.user_id", "=", userId)
      .where("m.status", "=", "ACTIVE").execute();
    const member = rows[0];
    if (!member) return undefined;
    return { id: member.id, userId: member.userId, organizationId: member.organizationId,
      role: member.role, status: member.status,
      capabilities: rows.flatMap((row) => row.code === null ? [] : [row.code]) };
  }

  async forOrganization(organizationId: string): Promise<OrganizationRepository> {
    // Bootstrap is restricted to roots created here, after locking this user.
    // Every existing tenant must prove active membership and business visibility.
    if (!this.createdOrganizations.has(organizationId)) {
      const member = await this.trx.selectFrom("memberships as m").innerJoin("organizations as o", "o.id", "m.organization_id")
        .select("m.organization_id")
        .where(tenantScope(organizationId, "m.organization_id")).where("m.user_id", "=", this.userId)
        .where("m.status", "=", "ACTIVE").where("o.status", "=", ACTIVE_ORGANIZATION_STATUS).executeTakeFirst();
      if (!member) throw new OrganizationError("RESOURCE_NOT_FOUND", "Organization not found.");
      organizationId = member.organization_id;
    }
    return new ScopedOrganizationRepository(this.trx, { organizationId, userId: this.userId }, this.createdOrganizations.has(organizationId));
  }

  async lockCreator(): Promise<boolean> {
    const user = await this.trx.selectFrom("users").select("id").where("id", "=", this.userId)
      .where("status", "=", "ACTIVE").forUpdate().executeTakeFirst();
    this.creatorLocked = user !== undefined;
    return this.creatorLocked;
  }

  async findActiveUser(userId: string): Promise<boolean> {
    const user = await this.trx.selectFrom("users").select("id").where("id", "=", userId)
      .where("status", "=", "ACTIVE").executeTakeFirst();
    return user !== undefined;
  }

  async createOrganization(input: CreateOrganizationInput) {
    if (!this.creatorLocked) throw new OrganizationError("UNAUTHENTICATED", "Unauthorized");
    const organization = await this.trx.insertInto("organizations").values({ name: input.name, base_currency: input.baseCurrency,
      accounting_timezone: input.accountingTimezone, status: "ACTIVE" }).returning(ORGANIZATION_FIELDS).executeTakeFirstOrThrow();
    this.createdOrganizations.add(organization.id);
    return organization;
  }

  findCreation(key: string) {
    return this.trx.selectFrom("idempotency_records")
      .select(["status", "request_hash as requestHash", "organization_id as organizationId", "expires_at as expiresAt", "response_snapshot as response"])
      .where("user_id", "=", this.userId).where("command_type", "=", CREATION_COMMAND).where("idempotency_key", "=", key)
      .executeTakeFirst();
  }

  async saveCreation(key: string, hash: string, result: CreationResult, expiresAt: Date): Promise<void> {
    if (!this.createdOrganizations.has(result.organization.id) || result.membership.organizationId !== result.organization.id ||
        result.membership.userId !== this.userId) throw new Error("Invalid organization creation scope.");
    await this.trx.insertInto("idempotency_records").values({ user_id: this.userId, organization_id: result.organization.id,
      command_type: CREATION_COMMAND, idempotency_key: key, request_hash: hash,
      response_status: 201, response_snapshot: JSON.stringify(result), expires_at: expiresAt }).execute();
  }
}

export const CREATION_CLEANUP_BATCH_SIZE = 1_000;

// Maintenance-only writer: preserve command identity/tenant ownership and release payloads, never keys.
export async function expireCreationSnapshots(db: Kysely<Database>, now: Date): Promise<void> {
  await db.updateTable("idempotency_records").set({ status: "EXPIRED", response_status: null, response_snapshot: null })
    .where("id", "in", db.selectFrom("idempotency_records").select("id")
      .where("status", "=", "COMPLETED").where("expires_at", "<=", now)
      .orderBy("expires_at").orderBy("id").limit(CREATION_CLEANUP_BATCH_SIZE).forUpdate().skipLocked()).execute();
}

export class PostgresOrganizationStore implements OrganizationStore {
  private readonly db: Kysely<Database>;
  constructor(db: Kysely<Database>) { this.db = db; }

  async transaction<T>(context: AuthenticatedContext, work: (transaction: OrganizationTransaction) => Promise<T>): Promise<T> {
    // Capture identity before yielding; never retain a mutable request object.
    const userId = context.userId;
    if (!userId.trim()) throw new OrganizationError("UNAUTHENTICATED", "Unauthorized");
    try {
      return await this.db.transaction().setIsolationLevel("read committed")
        .execute((trx) => work(new PostgresOrganizationTransaction(trx, userId)));
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "23505" && "constraint" in error && error.constraint === "memberships_organization_user_unique") {
          throw new OrganizationError("BUSINESS_CONFLICT", "Membership already exists.");
        }
        if (error.code === "40001" || error.code === "40P01") {
          throw new OrganizationError("CONCURRENT_CONFLICT", "Concurrent update conflict. Retry the request.");
        }
      }
      throw error;
    }
  }
}
