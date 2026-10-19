import type { MembershipRole } from "@ledgerflow/db";
import { OrganizationError, type CreateOrganizationInput, type CreationResult, type PageInput } from "./types.ts";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: readonly string[] = ["OWNER", "ADMIN", "ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"];
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
const MAX_NAME_LENGTH = 200;
const MAX_TIMEZONE_LENGTH = 100;

function invalid(message: string): never { throw new OrganizationError(400, message); }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fields(body: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!object(body) || Object.keys(body).length !== expected.length ||
      !expected.every((key) => Object.hasOwn(body, key))) invalid("Invalid request fields.");
  return body;
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) invalid("Invalid identifier.");
  return value.toLowerCase();
}
export function isRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && ROLES.includes(value);
}
export function creationInput(body: unknown): CreateOrganizationInput {
  const { name, baseCurrency, accountingTimezone } = fields(body, ["name", "baseCurrency", "accountingTimezone"]);
  if (typeof name !== "string" || !name.trim() || name.trim().length > MAX_NAME_LENGTH || name.includes("\0")) {
    invalid("Name must contain 1 to 200 characters.");
  }
  if (typeof baseCurrency !== "string" || !CURRENCIES.has(baseCurrency)) invalid("Unsupported base currency.");
  if (typeof accountingTimezone !== "string" || !accountingTimezone || accountingTimezone.length > MAX_TIMEZONE_LENGTH ||
      /^[+-]/.test(accountingTimezone)) invalid("Invalid accounting timezone.");
  try { new Intl.DateTimeFormat("en", { timeZone: accountingTimezone }); }
  catch { invalid("Invalid accounting timezone."); }
  return { name: name.trim(), baseCurrency, accountingTimezone };
}
export function memberInput(body: unknown): { userId: string; role: MembershipRole } {
  const { userId, role } = fields(body, ["userId", "role"]);
  if (!isRole(role)) invalid("Invalid membership role.");
  return { userId: identifier(userId), role };
}
export function roleInput(body: unknown): MembershipRole {
  const { role } = fields(body, ["role"]);
  if (!isRole(role)) invalid("Invalid membership role.");
  return role;
}
export function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    invalid("Idempotency-Key must contain 1 to 128 letters, digits, dots, underscores, colons, or hyphens.");
  }
  return value;
}
export function pageInput(query: unknown, organizationId: string): PageInput {
  if (!object(query) || Object.keys(query).some((key) => key !== "cursor" && key !== "limit")) invalid("Invalid pagination.");
  const { cursor, limit } = query;
  if (limit !== undefined && (typeof limit !== "string" || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > MAX_PAGE_LIMIT)) {
    invalid("Limit must be between 1 and 100.");
  }
  const page: PageInput = { limit: limit === undefined ? DEFAULT_PAGE_LIMIT : Number(limit) };
  if (cursor !== undefined) {
    if (typeof cursor !== "string" || cursor.length > 100 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalid("Invalid cursor.");
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const [tenant, member, extra] = decoded.split(":");
    if (extra !== undefined || tenant !== organizationId || !member || !UUID_PATTERN.test(member) ||
        Buffer.from(decoded).toString("base64url") !== cursor) invalid("Invalid cursor.");
    page.cursor = member;
  }
  return page;
}

export function organizationPageInput(query: unknown): PageInput {
  if (!object(query) || Object.keys(query).some((key) => key !== "cursor" && key !== "limit")) invalid("Invalid pagination.");
  const { cursor, limit } = query;
  if (limit !== undefined && (typeof limit !== "string" || !/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > MAX_PAGE_LIMIT)) {
    invalid("Limit must be between 1 and 100.");
  }
  return { limit: limit === undefined ? DEFAULT_PAGE_LIMIT : Number(limit),
    ...(cursor === undefined ? {} : { cursor: identifier(cursor) }) };
}

export function isCreationResult(value: unknown): value is CreationResult {
  if (!object(value) || !object(value.organization) || !object(value.membership)) return false;
  const { organization: org, membership: member } = value;
  return typeof org.id === "string" && UUID_PATTERN.test(org.id) && typeof org.name === "string" &&
    typeof org.baseCurrency === "string" && typeof org.accountingTimezone === "string" &&
    (org.status === "ACTIVE" || org.status === "SUSPENDED") && member.organizationId === org.id &&
    typeof member.userId === "string" && UUID_PATTERN.test(member.userId) && isRole(member.role) &&
    (member.status === "ACTIVE" || member.status === "INACTIVE");
}
