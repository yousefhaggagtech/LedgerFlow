import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import { createDatabase, createDatabaseFromEnvironment } from "../dist/index.js";
import { createMigrationDatabaseFromEnvironment } from "../dist/migration-database.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL test database.");

test("runtime and migration pools keep independent statement deadlines", async () => {
  const runtime = createDatabase(connectionString);
  const migration = createMigrationDatabaseFromEnvironment({ DATABASE_URL: connectionString });
  try {
    assert.equal((await sql`SHOW statement_timeout`.execute(runtime)).rows[0].statement_timeout, "3s");
    assert.equal((await sql`SHOW statement_timeout`.execute(migration)).rows[0].statement_timeout, "10min");
    await assert.rejects(sql`SELECT pg_sleep(4)`.execute(runtime));
    await sql`SELECT pg_sleep(4)`.execute(migration);
    assert.equal((await sql`SHOW statement_timeout`.execute(runtime)).rows[0].statement_timeout, "3s");
  } finally { await Promise.all([runtime.destroy(), migration.destroy()]); }
});

test("custom deadlines are explicit and invalid/unbounded deadlines fail before connection", async () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 2 ** 31]) {
    for (const name of ["statementTimeoutMs", "queryTimeoutMs"]) {
      assert.throws(() => createDatabase(connectionString, { [name]: value }), /timeouts must be positive integers/);
    }
  }
  const custom = createDatabase(connectionString, { statementTimeoutMs: 12_000, queryTimeoutMs: 15_000 });
  try { assert.equal((await sql`SHOW statement_timeout`.execute(custom)).rows[0].statement_timeout, "12s"); }
  finally { await custom.destroy(); }
});

test("only the migration factory uses the optional migrations URL, with single-URL fallback", async () => {
  const preferred = createMigrationDatabaseFromEnvironment({ MIGRATIONS_DATABASE_URL: connectionString, DATABASE_URL: "invalid" });
  const fallback = createMigrationDatabaseFromEnvironment({ MIGRATIONS_DATABASE_URL: "", DATABASE_URL: connectionString });
  try {
    await sql`SELECT 1`.execute(preferred);
    await sql`SELECT 1`.execute(fallback);
    const previous = { database: process.env.DATABASE_URL, migrations: process.env.MIGRATIONS_DATABASE_URL };
    try {
      process.env.DATABASE_URL = "invalid";
      process.env.MIGRATIONS_DATABASE_URL = connectionString;
      assert.throws(() => createDatabaseFromEnvironment(), /valid PostgreSQL connection URL/);
    } finally {
      if (previous.database === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.database;
      if (previous.migrations === undefined) delete process.env.MIGRATIONS_DATABASE_URL; else process.env.MIGRATIONS_DATABASE_URL = previous.migrations;
    }
  } finally { await Promise.all([preferred.destroy(), fallback.destroy()]); }
});
