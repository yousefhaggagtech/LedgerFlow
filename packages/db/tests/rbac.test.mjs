import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { createDatabase } from "../dist/index.js";
import { createMigrator } from "../dist/migrator.js";
import { seedDevelopment } from "../dist/seeds/development.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL test database.");

test("dynamic RBAC schema and deployment seed on PostgreSQL", async (t) => {
  const schema = `rbac_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(connectionString);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const db = createDatabase(url.toString());
  let created = false;
  try {
    await admin.schema.createSchema(schema).execute();
    created = true;
    const migrator = createMigrator(db, schema);
    assert.equal((await migrator.migrateTo("003_organization_management")).error, undefined);
    const fixture = await seedDevelopment(db);
    const sessionId = randomUUID();
    await db.insertInto("sessions").values({ id: sessionId, user_id: fixture.userId,
      token_hash: "a".repeat(64), expires_at: new Date(Date.now() + 60_000) }).execute();
    assert.equal((await migrator.migrateToLatest()).error, undefined);

    await t.test("migration seeds exactly S1 codes and the Option A access grants", async () => {
      const codes = ["member:edit", "member:invite", "member:read", "org:create", "org:read"];
      const permissions = await db.selectFrom("permissions").selectAll().orderBy("code").execute();
      assert.deepEqual(permissions.map((row) => row.code), codes);
      for (const permission of permissions) {
        assert.match(permission.id, /^[0-9a-f-]{36}$/);
        assert.ok(permission.description.length > 0);
      }
      const grants = await db.selectFrom("role_permissions as rp").innerJoin("permissions as p", "p.id", "rp.permission_id")
        .select(["rp.role", "p.code"]).orderBy("rp.role").orderBy("p.code").execute();
      assert.deepEqual(grants, ["OWNER", "ADMIN"].flatMap((role) => codes.filter((code) => code !== "org:create")
        .map((code) => ({ role, code }))));
      const column = await sql`SELECT udt_name FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'role_permissions' AND column_name = 'role'`.execute(db);
      assert.equal(column.rows[0].udt_name, "membership_role");
    });

    await t.test("constraints reject invalid roles, duplicate grants, missing permissions, and invalid catalog entries", async () => {
      const permission = await db.selectFrom("permissions").select("id").where("code", "=", "org:read").executeTakeFirstOrThrow();
      await assert.rejects(sql`INSERT INTO role_permissions (role, permission_id) VALUES ('SUPERADMIN', ${permission.id})`.execute(db), { code: "22P02" });
      await assert.rejects(db.insertInto("role_permissions").values({ role: "OWNER", permission_id: permission.id }).execute(), { code: "23505" });
      await assert.rejects(db.insertInto("role_permissions").values({ role: "VIEWER", permission_id: randomUUID() }).execute(), { code: "23503" });
      await assert.rejects(sql`INSERT INTO role_permissions (role, permission_id) VALUES (NULL, ${permission.id})`.execute(db), { code: "23502" });
      await assert.rejects(db.deleteFrom("permissions").where("id", "=", permission.id).execute(), { code: "23503" });
      await assert.rejects(db.insertInto("permissions").values({ code: "org:read", description: "Duplicate" }).execute(), { code: "23505" });
      await assert.rejects(db.insertInto("permissions").values({ code: "invalid", description: "Invalid" }).execute(), { code: "23514" });
      await assert.rejects(db.insertInto("permissions").values({ code: "test:valid", description: " " }).execute(), { code: "23514" });
      await assert.rejects(sql`INSERT INTO permissions (code) VALUES ('test:valid')`.execute(db), { code: "23502" });
    });

    await t.test("migration reruns do not restore revoked access", async () => {
      const revoked = await db.deleteFrom("role_permissions").where("role", "=", "ADMIN").returningAll().execute();
      try {
        assert.deepEqual((await migrator.migrateToLatest()).results, []);
        assert.deepEqual(await db.selectFrom("role_permissions").selectAll().where("role", "=", "ADMIN").execute(), []);
      } finally { await db.insertInto("role_permissions").values(revoked).execute(); }
    });

    await t.test("authorization join has indexed membership and role lookups", async () => {
      await db.transaction().execute(async (trx) => {
        // A tiny fixture prefers scans; disable them locally to verify index eligibility.
        await sql`SET LOCAL enable_seqscan = off`.execute(trx);
        const plan = await sql`EXPLAIN (FORMAT JSON) SELECT m.id, p.code FROM memberships m
          LEFT JOIN role_permissions rp ON rp.role = m.role LEFT JOIN permissions p ON p.id = rp.permission_id
          WHERE m.organization_id = ${fixture.organizationId}::uuid AND m.user_id = ${fixture.userId}::uuid AND m.status = 'ACTIVE'`.execute(trx);
        const details = JSON.stringify(plan.rows);
        assert.match(details, /memberships_organization_user_unique/);
        assert.match(details, /role_permissions_pkey/);
        assert.match(details, /permissions_pkey/);
      });
    });

    await t.test("RBAC rollback/reapplication preserve identity, membership, and session rows", async () => {
      assert.equal((await migrator.migrateTo("003_organization_management")).error, undefined);
      const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = ${schema}
        AND tablename IN ('permissions', 'role_permissions')`.execute(db);
      assert.deepEqual(tables.rows, []);
      assert.equal((await db.selectFrom("users").select("id").where("id", "=", fixture.userId).executeTakeFirstOrThrow()).id, fixture.userId);
      assert.equal((await db.selectFrom("memberships").select("id").where("id", "=", fixture.membershipId).executeTakeFirstOrThrow()).id, fixture.membershipId);
      assert.equal((await db.selectFrom("sessions").select("id").where("id", "=", sessionId).executeTakeFirstOrThrow()).id, sessionId);
      assert.equal((await migrator.migrateToLatest()).error, undefined);
      assert.equal((await db.selectFrom("role_permissions").selectAll().execute()).length, 8);
    });
  } finally {
    await db.destroy();
    try {
      if (created) await admin.schema.dropSchema(schema).cascade().execute();
    } finally { await admin.destroy(); }
  }
});
