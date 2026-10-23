import assert from "node:assert/strict";
import test from "node:test";
import { createMigrationDatabaseFromEnvironment } from "../dist/migration-database.js";

// URL validation is eager; these tests never open a database connection.
const valid = "postgresql://fixture:local_only@127.0.0.1:1/disposable";

test("migration URL takes precedence over legacy and runtime URLs", async () => {
  const db = createMigrationDatabaseFromEnvironment({
    MIGRATION_DATABASE_URL: valid, MIGRATIONS_DATABASE_URL: "invalid", DATABASE_URL: "invalid"
  });
  await db.destroy();
  assert.throws(() => createMigrationDatabaseFromEnvironment({
    MIGRATION_DATABASE_URL: "invalid", MIGRATIONS_DATABASE_URL: valid, DATABASE_URL: valid
  }), /valid PostgreSQL connection URL/);
});

test("empty migration URL preserves legacy and single-URL fallbacks", async () => {
  for (const env of [
    { MIGRATION_DATABASE_URL: "", MIGRATIONS_DATABASE_URL: valid, DATABASE_URL: "invalid" },
    { MIGRATION_DATABASE_URL: "", MIGRATIONS_DATABASE_URL: "", DATABASE_URL: valid },
    { DATABASE_URL: valid }
  ]) {
    const db = createMigrationDatabaseFromEnvironment(env);
    await db.destroy();
  }
  assert.throws(() => createMigrationDatabaseFromEnvironment({}), /MIGRATION_DATABASE_URL or DATABASE_URL is required/);
});
