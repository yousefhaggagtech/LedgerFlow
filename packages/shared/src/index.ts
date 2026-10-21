export { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES, ORGANIZATION_STATUSES } from "./organizations.js";
export type { MembershipRole, MembershipStatus, OrganizationStatus } from "./organizations.js";

export type HealthResponse =
  | { api: "UP"; database: "UP" }
  | { api: "UP"; database: "DOWN"; error: string };

export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  if (!("api" in value) || value.api !== "UP" || !("database" in value)) return false;
  return value.database === "UP" ||
    (value.database === "DOWN" && "error" in value && typeof value.error === "string");
}
