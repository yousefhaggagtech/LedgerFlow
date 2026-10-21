export const MEMBERSHIP_ROLES = Object.freeze(["OWNER", "ADMIN", "ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"] as const);
export const MEMBERSHIP_STATUSES = Object.freeze(["ACTIVE", "INACTIVE"] as const);
export const ORGANIZATION_STATUSES = Object.freeze(["ACTIVE", "SUSPENDED"] as const);

export type MembershipRole = typeof MEMBERSHIP_ROLES[number];
export type MembershipStatus = typeof MEMBERSHIP_STATUSES[number];
export type OrganizationStatus = typeof ORGANIZATION_STATUSES[number];
