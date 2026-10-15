import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";

const POOL_MAX_CONNECTIONS = 10;
const CONNECTION_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;

// Call once per process; the owner must await db.destroy() during shutdown.
// Consumers supply their schema types when schemas are introduced.
export function createDatabase<Database>(connectionString: string): Kysely<Database> {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  const pool = new pg.Pool({
    connectionString,
    max: POOL_MAX_CONNECTIONS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
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
