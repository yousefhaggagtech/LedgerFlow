import type { MembershipRole } from "@ledgerflow/shared";
import { OrganizationError, type Organization, type StoredMembership } from "./types.ts";

export const ACTIVE_ORGANIZATION_STATUS = "ACTIVE";

// Business visibility gate; a future privileged platform path must opt out deliberately.
export function requireVisibleOrganization(organization: Organization | undefined): Organization {
  if (!organization || organization.status !== ACTIVE_ORGANIZATION_STATUS) {
    throw new OrganizationError("RESOURCE_NOT_FOUND", "Organization not found.");
  }
  return organization;
}

// Structural assignment limits are domain invariants, independent of capability grants.
const STANDARD_ROLES: readonly MembershipRole[] = ["ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"];
const ASSIGNABLE_ROLES: Readonly<Record<MembershipRole, readonly MembershipRole[]>> = {
  OWNER: ["OWNER", "ADMIN", ...STANDARD_ROLES], ADMIN: STANDARD_ROLES,
  ACCOUNTANT: [], FINANCE_MEMBER: [], VIEWER: []
};

export function requireAssignment(actor: StoredMembership, role: MembershipRole, target?: StoredMembership): void {
  const allowed = ASSIGNABLE_ROLES[actor.role];
  if (!allowed.includes(role) || (target && (!allowed.includes(target.role) ||
      (actor.userId === target.userId && actor.role === "ADMIN")))) {
    throw new OrganizationError("PERMISSION_DENIED", "Permission denied.");
  }
}
