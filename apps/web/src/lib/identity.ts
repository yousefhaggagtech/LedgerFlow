export const ROLES = ["OWNER", "ADMIN", "ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"] as const;
export type Role = typeof ROLES[number];
export const ROLE_LABELS: Record<Role, string> = { OWNER: "Owner", ADMIN: "Admin", ACCOUNTANT: "Accountant", FINANCE_MEMBER: "Finance member", VIEWER: "Viewer" };
export interface User { id: string; email: string; fullName: string }
export interface Membership { userId: string; organizationId: string; role: Role; status: "ACTIVE" | "INACTIVE" }
export interface Organization { id: string; name: string; baseCurrency: string; accountingTimezone: string; status: "ACTIVE" | "SUSPENDED" }
export interface OrganizationAccess { id: string; name: string; membership: Membership; capabilities: string[] }
export interface Page<T> { items: T[]; nextCursor: string | null }
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function isRole(value: unknown): value is Role { return ROLES.some((role) => role === value); }
function isId(value: unknown): value is string { return typeof value === "string" && UUID_PATTERN.test(value); }
export function isSession(value: unknown): value is { user: User } {
  return isObject(value) && isObject(value.user) && isId(value.user.id) && typeof value.user.email === "string" && typeof value.user.fullName === "string";
}
export function isMember(value: unknown): value is Membership {
  return isObject(value) && isId(value.userId) && isId(value.organizationId) && isRole(value.role) && (value.status === "ACTIVE" || value.status === "INACTIVE");
}
export function isOrganization(value: unknown): value is Organization {
  return isObject(value) && isId(value.id) && typeof value.name === "string" && typeof value.baseCurrency === "string" &&
    typeof value.accountingTimezone === "string" && (value.status === "ACTIVE" || value.status === "SUSPENDED");
}
export function isAccess(value: unknown): value is OrganizationAccess {
  return isObject(value) && isId(value.id) && typeof value.name === "string" && isMember(value.membership) &&
    value.membership.organizationId === value.id && Array.isArray(value.capabilities) && value.capabilities.every((code: unknown) => typeof code === "string");
}
export function isPage<T>(guard: (value: unknown) => value is T) {
  return (value: unknown): value is Page<T> => isObject(value) && Array.isArray(value.items) && value.items.every(guard) &&
    (value.nextCursor === null || typeof value.nextCursor === "string");
}
export function assignableRoles(role: Role): readonly Role[] {
  if (role === "OWNER") return ROLES;
  return role === "ADMIN" ? ["ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"] : [];
}
export function canEditMember(access: OrganizationAccess, target: Membership): boolean {
  const roles = assignableRoles(access.membership.role);
  return access.capabilities.includes("member:edit") && roles.includes(target.role) &&
    !(access.membership.role === "ADMIN" && access.membership.userId === target.userId);
}
