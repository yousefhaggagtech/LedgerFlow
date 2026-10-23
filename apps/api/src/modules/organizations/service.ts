import { createHash } from "node:crypto";
import type { MembershipRole } from "@ledgerflow/shared";
import { requireAssignment, requireVisibleOrganization } from "./policy.ts";
import { RequestCapabilityResolver, requireActiveMembership, requireCapability, type AuthorizedMembership, type Capability } from "./capabilities.ts";
import { isCreationResult } from "./validation.ts";
import { membershipDto, OrganizationError, type Actor, type CreateOrganizationInput, type CreationResult,
  type OrganizationRepository, type OrganizationStore, type OrganizationTransaction, type PageInput,
  type StoredMembership } from "./types.ts";

const CREATION_RETENTION_MS = 24 * 60 * 60 * 1_000;

async function tenantAccess(transaction: OrganizationTransaction, organizationId: string, userId: string,
  capability: Capability | undefined, lock: "read" | "write") {
  const resolver = new RequestCapabilityResolver(transaction);
  const repository = await transaction.forOrganization(organizationId);
  // Check visibility before loading the root, then recheck after acquiring its lock.
  const authorize = (member: AuthorizedMembership | undefined) => capability
    ? requireCapability(capability, member) : requireActiveMembership(member);
  authorize(await resolver.resolve(organizationId, userId));
  const organization = requireVisibleOrganization(await repository.organization(lock));
  // Waiting for a lock may span a role change or grant revocation: discard the earlier snapshot.
  resolver.invalidate(organizationId, userId);
  const actor = authorize(await resolver.resolve(organizationId, userId));
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
    return this.store.transaction(actor, async (transaction) => {
      // The global user row serializes bootstrap retries before a tenant exists.
      if (!await transaction.lockCreator()) throw new OrganizationError("UNAUTHENTICATED", "Unauthorized");
      const existing = await transaction.findCreation(key);
      if (existing) {
        if (existing.requestHash !== requestHash) throw new OrganizationError("BUSINESS_CONFLICT", "Idempotency key was used with a different request.");
        if (existing.status === "EXPIRED" || existing.expiresAt <= this.now()) throw new OrganizationError("BUSINESS_CONFLICT", "Idempotency key has expired. Check the existing organization before retrying.");
        const repository = await transaction.forOrganization(existing.organizationId);
        const member = await repository.findMembership(actor.userId);
        if (!member || member.status !== "ACTIVE") throw new OrganizationError("RESOURCE_NOT_FOUND", "Organization not found.");
        requireVisibleOrganization(await repository.organization("read"));
        const current = await repository.findMembership(actor.userId);
        if (!current || current.status !== "ACTIVE") throw new OrganizationError("RESOURCE_NOT_FOUND", "Organization not found.");
        if (!isCreationResult(existing.response)) throw new Error("Invalid stored creation response.");
        if (existing.response.organization.id !== existing.organizationId ||
            existing.response.membership.userId !== actor.userId) throw new Error("Invalid stored creation scope.");
        return existing.response;
      }
      const organization = await transaction.createOrganization(input);
      const repository = await transaction.forOrganization(organization.id);
      const owner = await repository.addMember(actor.userId, "OWNER");
      const result = { organization, membership: membershipDto(owner) };
      await repository.audit({ actor: owner, correlationId: actor.correlationId,
        action: "ORGANIZATION_CREATED", targetType: "ORGANIZATION", targetId: organization.id,
        previousState: null, newState: result });
      await transaction.saveCreation(key, requestHash, result,
        new Date(this.now().getTime() + CREATION_RETENTION_MS));
      return result;
    });
  }

  access(organizationId: string, userId: string) {
    return this.store.transaction({ userId }, async (transaction) => {
      // Hints must remain readable after a grant is revoked; membership is the visibility boundary.
      const { actor } = await tenantAccess(transaction, organizationId, userId, undefined, "read");
      return { membership: membershipDto(actor), capabilities: [...actor.capabilities] };
    });
  }

  get(organizationId: string, userId: string) {
    return this.store.transaction({ userId }, async (transaction) => {
      const { organization } = await tenantAccess(transaction, organizationId, userId, "org:read", "read");
      return organization;
    });
  }

  list(userId: string, page: PageInput) {
    return this.store.transaction({ userId }, async (transaction) => {
      const rows = await transaction.listForUser(page);
      const items = rows.slice(0, page.limit);
      return { items, nextCursor: rows.length > page.limit ? items.at(-1)?.id ?? null : null };
    });
  }

  members(organizationId: string, userId: string, page: PageInput) {
    return this.store.transaction({ userId }, async (transaction) => {
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
    return this.store.transaction(actor, async (transaction) => {
      const { repository, actor: member } = await tenantAccess(transaction, organizationId, actor.userId, "member:invite", "write");
      requireAssignment(member, input.role);
      if (await repository.findMembership(input.userId)) throw new OrganizationError("BUSINESS_CONFLICT", "Membership already exists.");
      // This is the only global identity resolution; it returns no user profile/directory.
      if (!await transaction.findActiveUser(input.userId)) throw new OrganizationError("RESOURCE_NOT_FOUND", "User is unavailable.");
      const added = await repository.addMember(input.userId, input.role);
      await repository.audit({ actor: member, correlationId: actor.correlationId,
        action: "MEMBER_ADDED", targetType: "MEMBERSHIP", targetId: added.id,
        previousState: null, newState: membershipDto(added) });
      return membershipDto(added);
    });
  }

  changeRole(organizationId: string, actor: Actor, userId: string, role: MembershipRole) {
    return this.store.transaction(actor, async (transaction) => {
      const { repository, actor: member } = await tenantAccess(transaction, organizationId, actor.userId, "member:edit", "write");
      const target = await repository.findMembership(userId);
      if (!target) throw new OrganizationError("RESOURCE_NOT_FOUND", "Membership not found.");
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
      throw new OrganizationError("BUSINESS_CONFLICT", "Organization must retain at least one active Owner.");
    }
  }
}
