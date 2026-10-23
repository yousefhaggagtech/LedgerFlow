import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";

export type {
  Database, OrganizationsTable, UsersTable, MembershipsTable, SessionsTable,
  OrganizationStatus, UserStatus, MembershipStatus, MembershipRole,
  AuditEventsTable, IdempotencyRecordsTable, PermissionsTable, RolePermissionsTable, JsonValue
} from "./schema.js";

const POOL_MAX_CONNECTIONS = 10;
const CONNECTION_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface DatabaseTimeouts {
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
}

export function createDatabaseFromEnvironment<Database>(): Kysely<Database> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  return createDatabase<Database>(connectionString);
}

export async function checkDatabaseConnection<Database>(db: Kysely<Database>): Promise<void> {
  await sql`SELECT 1`.execute(db);
}

// Call once per process; the owner must await db.destroy() during shutdown.
// Consumers supply schema types; health-only callers can use an empty schema.
export function createDatabase<Database>(connectionString: string, timeouts: DatabaseTimeouts = {}): Kysely<Database> {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  const statementTimeoutMs = timeouts.statementTimeoutMs ?? QUERY_TIMEOUT_MS;
  const queryTimeoutMs = timeouts.queryTimeoutMs ?? QUERY_TIMEOUT_MS;
  if ([statementTimeoutMs, queryTimeoutMs].some((value) => !Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS)) {
    throw new Error("Database timeouts must be positive integers within the supported timer range.");
  }
  const pool = new pg.Pool({
    connectionString,
    max: POOL_MAX_CONNECTIONS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    query_timeout: queryTimeoutMs,
    statement_timeout: statementTimeoutMs,
    idleTimeoutMillis: IDLE_TIMEOUT_MS
  });
  // Idle connections can fail outside a query; never print connection details.
  pool.on("error", () => {
    process.stderr.write("PostgreSQL idle connection failed.\n");
  });
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool
    })
  });
}
