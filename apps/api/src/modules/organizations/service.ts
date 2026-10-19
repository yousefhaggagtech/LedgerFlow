import { createHash } from "node:crypto";
import type { MembershipRole } from "@ledgerflow/db";
import { requireAssignment } from "./policy.ts";
import { RequestCapabilityResolver, requireCapability, type Capability } from "./capabilities.ts";
import { isCreationResult } from "./validation.ts";
import { membershipDto, OrganizationError, type Actor, type CreateOrganizationInput, type CreationResult,
  type OrganizationRepository, type OrganizationStore, type OrganizationTransaction, type PageInput,
  type StoredMembership } from "./types.ts";

const CREATION_RETENTION_MS = 24 * 60 * 60 * 1_000;

async function tenantAccess(transaction: OrganizationTransaction, organizationId: string, userId: string,
  capability: Capability, lock: "read" | "write") {
  const repository = transaction.forOrganization(organizationId);
  const resolver = new RequestCapabilityResolver(transaction);
  // Check visibility before loading the root, then recheck after acquiring its lock.
  requireCapability(capability, await resolver.resolve(organizationId, userId));
  const organization = await repository.organization(lock);
  if (!organization) throw new OrganizationError(404, "Organization not found.");
  // Waiting for a lock may span a role change or grant revocation: discard the earlier snapshot.
  resolver.invalidate(organizationId, userId);
  const actor = requireCapability(capability, await resolver.resolve(organizationId, userId));
  return { repository, organization, actor };
}

export class OrganizationService {
  private readonly store: OrganizationStore;
  private readonly now: () => Date;

  constructor(store: OrganizationStore, now = () => new Date()) {
    this.store = store;
    this.now = now;
  }

  async create(actor: Actor, input: CreateOrganizationInput, key: string): Promise<CreationResult> {
    const requestHash = createHash("sha256").update(JSON.stringify({
      name: input.name, baseCurrency: input.baseCurrency, accountingTimezone: input.accountingTimezone
    })).digest("hex");
    return this.store.transaction(async (transaction) => {
      // The global user row serializes bootstrap retries before a tenant exists.
      if (!await transaction.lockCreator(actor.userId)) throw new OrganizationError(401, "Unauthorized");
      const existing = await transaction.findCreation(actor.userId, key);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new OrganizationError(409, "Idempotency key was used with a different request.");
        if (existing.expiresAt <= this.now()) throw new OrganizationError(409, "Idempotency key has expired. Check the existing organization before retrying.");
        const repository = transaction.forOrganization(existing.organizationId);
        const member = await repository.findMembership(actor.userId);
        if (!member || member.status !== "ACTIVE") throw new OrganizationError(404, "Organization not found.");
        await repository.organization("read");
        const current = await repository.findMembership(actor.userId);
        if (!current || current.status !== "ACTIVE") throw new OrganizationError(404, "Organization not found.");
        if (!isCreationResult(existing.response)) throw new Error("Invalid stored creation response.");
        return existing.response;
      }
      const organization = await transaction.createOrganization(input);
      const repository = transaction.forOrganization(organization.id);
      const owner = await repository.addMember(actor.userId, "OWNER");
      const result = { organization, membership: membershipDto(owner) };
      await repository.audit({ actor: owner, correlationId: actor.correlationId,
        action: "ORGANIZATION_CREATED", targetType: "ORGANIZATION", targetId: organization.id,
        previousState: null, newState: result });
      await transaction.saveCreation(actor.userId, key, requestHash, result,
        new Date(this.now().getTime() + CREATION_RETENTION_MS));
      return result;
    });
  }

  get(organizationId: string, userId: string) {
    return this.store.transaction(async (transaction) => {
      const { organization } = await tenantAccess(transaction, organizationId, userId, "org:read", "read");
      return organization;
    });
  }

  list(userId: string, page: PageInput) {
    return this.store.transaction(async (transaction) => {
      const rows = await transaction.listForUser(userId, page);
      const items = rows.slice(0, page.limit);
      return { items, nextCursor: rows.length > page.limit ? items.at(-1)?.id ?? null : null };
    });
  }

  members(organizationId: string, userId: string, page: PageInput) {
    return this.store.transaction(async (transaction) => {
      const { repository } = await tenantAccess(transaction, organizationId, userId, "member:read", "read");
      const rows = await repository.listMembers(page);
      const items = rows.slice(0, page.limit).map(membershipDto);
      const last = items.at(-1);
      const nextCursor = rows.length > page.limit && last
        ? Buffer.from(`${organizationId}:${last.userId}`).toString("base64url") : null;
      return { items, nextCursor };
    });
  }

  add(organizationId: string, actor: Actor, input: { userId: string; role: MembershipRole }) {
    return this.store.transaction(async (transaction) => {
      const { repository, actor: member } = await tenantAccess(transaction, organizationId, actor.userId, "member:invite", "write");
      requireAssignment(member, input.role);
      if (await repository.findMembership(input.userId)) throw new OrganizationError(409, "Membership already exists.");
      // This is the only global identity resolution; it returns no user profile/directory.
      if (!await transaction.findActiveUser(input.userId)) throw new OrganizationError(404, "User is unavailable.");
      const added = await repository.addMember(input.userId, input.role);
      await repository.audit({ actor: member, correlationId: actor.correlationId,
        action: "MEMBER_ADDED", targetType: "MEMBERSHIP", targetId: added.id,
        previousState: null, newState: membershipDto(added) });
      return membershipDto(added);
    });
  }

  changeRole(organizationId: string, actor: Actor, userId: string, role: MembershipRole) {
    return this.store.transaction(async (transaction) => {
      const { repository, actor: member } = await tenantAccess(transaction, organizationId, actor.userId, "member:edit", "write");
      const target = await repository.findMembership(userId);
      if (!target) throw new OrganizationError(404, "Membership not found.");
      requireAssignment(member, role, target);
      if (target.role === role) return membershipDto(target);
      await this.retainOwner(repository, target, role);
      const changed = await repository.changeRole(userId, role);
      await repository.audit({ actor: member, correlationId: actor.correlationId,
        action: "MEMBER_ROLE_CHANGED", targetType: "MEMBERSHIP", targetId: target.id,
        previousState: membershipDto(target), newState: membershipDto(changed) });
      return membershipDto(changed);
    });
  }

  private async retainOwner(repository: OrganizationRepository, target: StoredMembership, role: MembershipRole): Promise<void> {
    if (target.status === "ACTIVE" && target.role === "OWNER" && role !== "OWNER" &&
        !await repository.hasOtherActiveOwner(target.userId)) {
      throw new OrganizationError(409, "Organization must retain at least one active Owner.");
    }
  }
}
