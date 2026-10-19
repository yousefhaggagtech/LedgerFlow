import type { Kysely, Transaction } from "kysely";
import { BaseTenantRepository, tenantScope } from "./tenant-repository.ts";
import type { Database, MembershipRole } from "@ledgerflow/db";
import { OrganizationError, type AuditChange, type CreateOrganizationInput, type CreationResult,
  type StoredMembership, type OrganizationRepository, type OrganizationStore, type OrganizationTransaction, type PageInput } from "../modules/organizations/types.ts";

const CREATION_COMMAND = "organization:create";
const ORGANIZATION_FIELDS = ["id", "name", "base_currency as baseCurrency", "accounting_timezone as accountingTimezone", "status"] as const;
const MEMBER_FIELDS = ["id", "user_id as userId", "organization_id as organizationId", "role", "status"] as const;

class ScopedOrganizationRepository extends BaseTenantRepository<StoredMembership> implements OrganizationRepository {
  private readonly trx: Transaction<Database>;
  private readonly organizationId: string;

  constructor(trx: Transaction<Database>, organizationId: string) {
    super();
    this.trx = trx;
    this.organizationId = organizationId;
  }

  async findMembership(userId: string) {
    const member = await this.find(this.organizationId, this.trx.selectFrom("memberships")).select(MEMBER_FIELDS)
      .where("user_id", "=", userId).executeTakeFirst();
    return member && this.ensureOrganization(this.organizationId, member);
  }

  organization(lock: "read" | "write") {
    const query = this.trx.selectFrom("organizations").select(ORGANIZATION_FIELDS).where(tenantScope(this.organizationId, "organizations.id"));
    return (lock === "write" ? query.forUpdate() : query.forShare()).executeTakeFirst();
  }

  async listMembers(page: PageInput) {
    let query = this.find(this.organizationId, this.trx.selectFrom("memberships")).select(MEMBER_FIELDS);
    if (page.cursor) query = query.where("user_id", ">", page.cursor);
    const members = await query.orderBy("user_id").limit(page.limit + 1).execute();
    return members.map((member) => this.ensureOrganization(this.organizationId, member));
  }

  async addMember(userId: string, role: MembershipRole) {
    const member = await this.trx.insertInto("memberships").values({ organization_id: this.organizationId,
      user_id: userId, role, status: "ACTIVE" }).returning(MEMBER_FIELDS).executeTakeFirstOrThrow();
    return this.ensureOrganization(this.organizationId, member);
  }

  async changeRole(userId: string, role: MembershipRole) {
    const member = await this.update(this.organizationId, this.trx.updateTable("memberships")).set({ role, updated_at: new Date() })
      .where("user_id", "=", userId).returning(MEMBER_FIELDS).executeTakeFirstOrThrow();
    return this.ensureOrganization(this.organizationId, member);
  }

  async hasOtherActiveOwner(userId: string): Promise<boolean> {
    const owner = await this.find(this.organizationId, this.trx.selectFrom("memberships")).select("id")
      .where("role", "=", "OWNER").where("status", "=", "ACTIVE").where("user_id", "!=", userId).limit(1).executeTakeFirst();
    return owner !== undefined;
  }

  async audit(change: AuditChange): Promise<void> {
    await this.trx.insertInto("audit_events").values({ organization_id: this.organizationId,
      actor_kind: "HUMAN", actor_membership_id: change.actor.id, actor_user_id: change.actor.userId,
      correlation_id: change.correlationId, action: change.action, target_type: change.targetType, target_id: change.targetId,
      previous_state: change.previousState === null ? null : JSON.stringify(change.previousState),
      new_state: JSON.stringify(change.newState) }).execute();
  }
}

class PostgresOrganizationTransaction implements OrganizationTransaction {
  private readonly trx: Transaction<Database>;
  constructor(trx: Transaction<Database>) { this.trx = trx; }

  async listForUser(userId: string, page: PageInput) {
    // Discovery is an identity boundary, scoped to the authenticated user before pagination.
    let query = this.trx.selectFrom("memberships as m").innerJoin("organizations as o", "o.id", "m.organization_id")
      .select(["o.id", "o.name", "m.user_id as userId", "m.role", "m.status"])
      .where("m.user_id", "=", userId).where("m.status", "=", "ACTIVE").where("o.status", "=", "ACTIVE");
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

  forOrganization(organizationId: string): OrganizationRepository {
    return new ScopedOrganizationRepository(this.trx, organizationId);
  }

  async lockCreator(userId: string): Promise<boolean> {
    const user = await this.trx.selectFrom("users").select("id").where("id", "=", userId)
      .where("status", "=", "ACTIVE").forUpdate().executeTakeFirst();
    return user !== undefined;
  }

  async findActiveUser(userId: string): Promise<boolean> {
    const user = await this.trx.selectFrom("users").select("id").where("id", "=", userId)
      .where("status", "=", "ACTIVE").executeTakeFirst();
    return user !== undefined;
  }

  createOrganization(input: CreateOrganizationInput) {
    return this.trx.insertInto("organizations").values({ name: input.name, base_currency: input.baseCurrency,
      accounting_timezone: input.accountingTimezone, status: "ACTIVE" }).returning(ORGANIZATION_FIELDS).executeTakeFirstOrThrow();
  }

  findCreation(userId: string, key: string) {
    return this.trx.selectFrom("idempotency_records")
      .select(["request_hash as requestHash", "organization_id as organizationId", "expires_at as expiresAt", "response_snapshot as response"])
      .where("user_id", "=", userId).where("command_type", "=", CREATION_COMMAND).where("idempotency_key", "=", key)
      .executeTakeFirst();
  }

  async saveCreation(userId: string, key: string, hash: string, result: CreationResult, expiresAt: Date): Promise<void> {
    await this.trx.insertInto("idempotency_records").values({ user_id: userId, organization_id: result.organization.id,
      command_type: CREATION_COMMAND, idempotency_key: key, request_hash: hash,
      response_status: 201, response_snapshot: JSON.stringify(result), expires_at: expiresAt }).execute();
  }
}

export class PostgresOrganizationStore implements OrganizationStore {
  private readonly db: Kysely<Database>;
  constructor(db: Kysely<Database>) { this.db = db; }

  async transaction<T>(work: (transaction: OrganizationTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction().setIsolationLevel("read committed")
        .execute((trx) => work(new PostgresOrganizationTransaction(trx)));
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "23505" && "constraint" in error && error.constraint === "memberships_organization_user_unique") {
          throw new OrganizationError(409, "Membership already exists.");
        }
        if (error.code === "40001" || error.code === "40P01") {
          throw new OrganizationError(409, "Concurrent update conflict. Retry the request.");
        }
      }
      throw error;
    }
  }
}
