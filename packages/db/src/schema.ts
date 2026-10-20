import type { ColumnType, Generated } from "kysely";

export type OrganizationStatus = "ACTIVE" | "SUSPENDED";
export type UserStatus = "ACTIVE" | "INACTIVE";
export type MembershipStatus = "ACTIVE" | "INACTIVE";
export type MembershipRole = "OWNER" | "ADMIN" | "ACCOUNTANT" | "FINANCE_MEMBER" | "VIEWER";

interface Timestamps {
  created_at: Generated<Date>;
  // Writers must advance updated_at explicitly when changing a row.
  updated_at: Generated<Date>;
}

export interface OrganizationsTable extends Timestamps {
  id: Generated<string>;
  name: string;
  base_currency: string;
  status: Generated<OrganizationStatus>;
  accounting_timezone: string;
}

export interface UsersTable extends Timestamps {
  id: Generated<string>;
  email: string;
  password_hash: string;
  full_name: string;
  status: Generated<UserStatus>;
}

export interface MembershipsTable extends Timestamps {
  id: Generated<string>;
  organization_id: ColumnType<string, string, never>;
  user_id: string;
  role: MembershipRole;
  status: Generated<MembershipStatus>;
}

export interface Database {
  organizations: OrganizationsTable;
  users: UsersTable;
  memberships: MembershipsTable;
  sessions: SessionsTable;
  audit_events: AuditEventsTable;
  idempotency_records: IdempotencyRecordsTable;
  permissions: PermissionsTable;
  role_permissions: RolePermissionsTable;
}

export interface PermissionsTable {
  id: Generated<string>;
  code: string;
  description: string;
}

export interface RolePermissionsTable {
  role: MembershipRole;
  permission_id: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObjectColumn = ColumnType<{ [key: string]: JsonValue }, string, string>;

export interface AuditEventsTable {
  id: Generated<string>;
  organization_id: ColumnType<string, string, never>;
  actor_kind: "HUMAN" | "SYSTEM";
  actor_membership_id: string | null;
  actor_user_id: string | null;
  action: "ORGANIZATION_CREATED" | "MEMBER_ADDED" | "MEMBER_ROLE_CHANGED";
  target_type: "ORGANIZATION" | "MEMBERSHIP";
  target_id: string;
  target_membership_id: ColumnType<string | null, never, never>;
  occurred_at: Generated<Date>;
  correlation_id: string;
  previous_state: JsonObjectColumn | null;
  new_state: JsonObjectColumn;
}

export interface IdempotencyRecordsTable {
  id: Generated<string>;
  user_id: string;
  organization_id: ColumnType<string, string, never>;
  command_type: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number;
  response_snapshot: JsonObjectColumn;
  status: Generated<"COMPLETED">;
  created_at: Generated<Date>;
  expires_at: Date;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  created_at: Generated<Date>;
  user_agent: string | null;
  ip_address: string | null;
}
