import { OrganizationError, type StoredMembership } from "./types.ts";

export type Capability = "org:read" | "member:read" | "member:invite" | "member:edit";

export interface AuthorizedMembership extends Readonly<StoredMembership> {
  readonly capabilities: readonly string[];
}

export interface CapabilitySource {
  findAuthorization(organizationId: string, userId: string): Promise<AuthorizedMembership | undefined>;
}

// Construct inside the request's application transaction, never on a shared service/store.
export class RequestCapabilityResolver {
  private readonly source: CapabilitySource;
  private readonly cache = new Map<string, Promise<AuthorizedMembership | undefined>>();

  constructor(source: CapabilitySource) { this.source = source; }

  resolve(organizationId: string, userId: string): Promise<AuthorizedMembership | undefined> {
    const key = JSON.stringify([organizationId, userId]);
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.source.findAuthorization(organizationId, userId).then((member) => {
        if (member && (member.organizationId !== organizationId || member.userId !== userId)) {
          throw new Error("Authorization source returned an invalid scope.");
        }
        return member ? Object.freeze({ ...member, capabilities: Object.freeze([...member.capabilities]) }) : undefined;
      });
      this.cache.set(key, pending);
    }
    return pending;
  }

  invalidate(organizationId: string, userId: string): void {
    this.cache.delete(JSON.stringify([organizationId, userId]));
  }
}

export function requireCapability(capability: Capability, member: AuthorizedMembership | undefined): AuthorizedMembership {
  if (!member || member.status !== "ACTIVE") throw new OrganizationError("RESOURCE_NOT_FOUND", "Organization not found.");
  if (!member.capabilities.includes(capability)) throw new OrganizationError("PERMISSION_DENIED", "Permission denied.");
  return member;
}
