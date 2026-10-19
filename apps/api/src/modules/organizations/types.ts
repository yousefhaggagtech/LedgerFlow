import type { MembershipRole, MembershipStatus, OrganizationStatus } from "@ledgerflow/db";
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

export interface AuditChange {
  actor: StoredMembership;
  correlationId: string;
  action: "ORGANIZATION_CREATED" | "MEMBER_ADDED" | "MEMBER_ROLE_CHANGED";
  targetType: "ORGANIZATION" | "MEMBERSHIP";
  targetId: string;
  previousState: Membership | null;
  newState: Membership | CreationResult;
}

// A repository instance carries its tenant; callers cannot omit a WHERE scope.
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
  listForUser(userId: string, page: PageInput): Promise<AccessibleOrganization[]>;
  forOrganization(organizationId: string): OrganizationRepository;
  lockCreator(userId: string): Promise<boolean>;
  findActiveUser(userId: string): Promise<boolean>;
  createOrganization(input: CreateOrganizationInput): Promise<Organization>;
  findCreation(userId: string, key: string): Promise<CreationRecord | undefined>;
  saveCreation(userId: string, key: string, hash: string, result: CreationResult, expiresAt: Date): Promise<void>;
}

export interface OrganizationStore {
  transaction<T>(work: (transaction: OrganizationTransaction) => Promise<T>): Promise<T>;
}

export class OrganizationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function membershipDto(member: StoredMembership): Membership {
  return { userId: member.userId, organizationId: member.organizationId, role: member.role, status: member.status };
}
