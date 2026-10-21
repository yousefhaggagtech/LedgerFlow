import type { MembershipRole } from "@ledgerflow/shared";
import { OrganizationError, type StoredMembership } from "./types.ts";

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
