import type { MembershipRole, MembershipStatus, OrganizationStatus } from "@ledgerflow/shared";
import type { CapabilitySource } from "./capabilities.ts";

export interface Organization {
  id: string;
  name: string;
  baseCurrency: string;
  accountingTimezone: string;
  status: OrganizationStatus;
}

export interface Membership {
  userId: string;
  organizationId: string;
  role: MembershipRole;
  status: MembershipStatus;
}

export interface StoredMembership extends Membership { id: string }
export interface CreateOrganizationInput { name: string; baseCurrency: string; accountingTimezone: string }
export interface CreationResult { organization: Organization; membership: Membership }
export interface MemberPage { items: Membership[]; nextCursor: string | null }
export interface PageInput { cursor?: string; limit: number }
export interface AccessibleOrganization {
  id: string;
  name: string;
  membership: Membership;
  capabilities: string[];
}
export interface Actor { userId: string; correlationId: string }
export interface AuthenticatedContext { readonly userId: string }

export interface AuditChange {
  actor: StoredMembership;
  correlationId: string;
  action: "ORGANIZATION_CREATED" | "MEMBER_ADDED" | "MEMBER_ROLE_CHANGED";
  targetType: "ORGANIZATION" | "MEMBERSHIP";
  targetId: string;
  previousState: Membership | null;
  newState: Membership | CreationResult;
}

/**
 * Service-owned transactional port, not an alternate command API. Tenant scope
 * is captured by infrastructure. For an existing root, await organization("write")
 * on this instance before addMember/changeRole/hasOtherActiveOwner/audit.
 * The service must refresh authorization after locking, validate assignment and
 * Owner retention, and await the matching audit before returning. The adapter's
 * lock guard does not enforce those policies or protect arbitrary SQL writers.
 * Bootstrap is limited to roots created under lockCreator in this transaction.
 */
export interface OrganizationRepository {
  findMembership(userId: string): Promise<StoredMembership | undefined>;
  organization(lock: "read" | "write"): Promise<Organization | undefined>;
  listMembers(page: PageInput): Promise<StoredMembership[]>;
  addMember(userId: string, role: MembershipRole): Promise<StoredMembership>;
  changeRole(userId: string, role: MembershipRole): Promise<StoredMembership>;
  hasOtherActiveOwner(userId: string): Promise<boolean>;
  audit(change: AuditChange): Promise<void>;
}

export interface CreationRecord {
  requestHash: string;
  organizationId: string;
  expiresAt: Date;
  response: unknown;
}

export interface OrganizationTransaction extends CapabilitySource {
  listForUser(page: PageInput): Promise<AccessibleOrganization[]>;
  forOrganization(organizationId: string): Promise<OrganizationRepository>;
  /** Bootstrap lock precedes creation-key lookup and all new-root writes. */
  lockCreator(): Promise<boolean>;
  findActiveUser(userId: string): Promise<boolean>;
  createOrganization(input: CreateOrganizationInput): Promise<Organization>;
  findCreation(key: string): Promise<CreationRecord | undefined>;
  saveCreation(key: string, hash: string, result: CreationResult, expiresAt: Date): Promise<void>;
}

export interface OrganizationStore {
  /**
   * OrganizationService owns this callback. Await every operation: resolve only
   * after commit; a thrown callback must roll back and propagate its error.
   * Never retain transaction/repository instances beyond the callback.
   */
  transaction<T>(context: AuthenticatedContext, work: (transaction: OrganizationTransaction) => Promise<T>): Promise<T>;
}

export type OrganizationErrorCode = "VALIDATION_FAILED" | "UNAUTHENTICATED" | "PERMISSION_DENIED"
  | "RESOURCE_NOT_FOUND" | "BUSINESS_CONFLICT" | "CONCURRENT_CONFLICT";

export class OrganizationError extends Error {
  readonly code: OrganizationErrorCode;
  constructor(code: OrganizationErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function membershipDto(member: StoredMembership): Membership {
  return { userId: member.userId, organizationId: member.organizationId, role: member.role, status: member.status };
}
