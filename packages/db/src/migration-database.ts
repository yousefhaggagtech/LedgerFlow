import { createDatabase } from "./index.js";

export const MIGRATION_TIMEOUT_MS = 10 * 60 * 1_000;

// DDL has its own pool/deadlines; request queries retain the runtime defaults.
export function createMigrationDatabaseFromEnvironment<Database>(env: NodeJS.ProcessEnv = process.env) {
  const connectionString = env.MIGRATION_DATABASE_URL || env.MIGRATIONS_DATABASE_URL || env.DATABASE_URL;
  if (!connectionString) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL is required.");
  return createDatabase<Database>(connectionString, {
    statementTimeoutMs: MIGRATION_TIMEOUT_MS, queryTimeoutMs: MIGRATION_TIMEOUT_MS
  });
}
