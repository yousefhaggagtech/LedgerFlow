import { createMigrationDatabaseFromEnvironment } from "./migration-database.js";
import type { Database } from "./schema.js";
import { seedDevelopment } from "./seeds/development.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("Development seed cannot run in production.");
}

const db = createMigrationDatabaseFromEnvironment<Database>();
try {
  await seedDevelopment(db);
  process.stdout.write("Development organization, user, and Owner membership created.\n");
} catch {
  process.stderr.write("Development seed failed; no partial seed was committed. Check migrations and whether the seed user already exists.\n");
  process.exitCode = 1;
} finally {
  await db.destroy();
}
