import { createMigrationDatabaseFromEnvironment } from "./migration-database.js";
import { createMigrator } from "./migrator.js";
import type { Database } from "./schema.js";

const db = createMigrationDatabaseFromEnvironment<Database>();
try {
  const { error, results } = await createMigrator(db).migrateToLatest();
  for (const result of results ?? []) {
    process.stdout.write(`${result.migrationName}: ${result.status}\n`);
  }
  if (error) {
    // Driver errors can contain credentials or row contents.
    process.stderr.write("Database migration failed. Check database connectivity and schema state.\n");
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}
