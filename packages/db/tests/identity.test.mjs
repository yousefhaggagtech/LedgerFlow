import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NO_MIGRATIONS, sql } from "kysely";
import { createDatabase } from "../dist/index.js";
import { createMigrator } from "../dist/migrator.js";
import { DEVELOPMENT_USER_EMAIL, seedDevelopment } from "../dist/seeds/development.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL 16 test database.");

test("identity and tenancy constraints on PostgreSQL", async (t) => {
  const schema = `identity_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(connectionString);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const db = createDatabase(url.toString());
  const migrator = createMigrator(db, schema);
  let created = false;
  try {
    await admin.schema.createSchema(schema).execute();
    created = true;
    const result = await migrator.migrateToLatest();
    assert.equal(result.error, undefined);
    assert.equal(result.results?.[0]?.status, "Success");
    assert.deepEqual((await migrator.migrateToLatest()).results, []);

    let seed;
    await t.test("seed creates a generated UUID chain with active defaults and timestamps", async () => {
      seed = await seedDevelopment(db);
      const row = await db.selectFrom("memberships as m")
        .innerJoin("organizations as o", "o.id", "m.organization_id")
        .innerJoin("users as u", "u.id", "m.user_id")
        .select(["o.base_currency", "o.accounting_timezone", "o.status as org_status",
          "u.email", "u.status as user_status", "m.role", "m.status", "m.created_at", "m.updated_at"])
        .where("m.organization_id", "=", seed.organizationId)
        .where("m.id", "=", seed.membershipId).executeTakeFirstOrThrow();
      for (const id of Object.values(seed)) {
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
      assert.equal(row.email, DEVELOPMENT_USER_EMAIL);
      assert.equal(row.role, "OWNER");
      assert.equal(row.status, "ACTIVE");
      assert.equal(row.user_status, "ACTIVE");
      assert.equal(row.org_status, "ACTIVE");
      assert.equal(row.base_currency, "EGP");
      assert.equal(row.accounting_timezone, "Africa/Cairo");
      assert.ok(row.created_at instanceof Date);
      assert.deepEqual(row.updated_at, row.created_at);
    });

    await t.test("duplicate seed fails atomically without orphan organizations", async () => {
      const before = await db.selectFrom("organizations").select(db.fn.countAll().as("count")).executeTakeFirstOrThrow();
      await assert.rejects(seedDevelopment(db), { code: "23505", constraint: "users_email_unique" });
      const after = await db.selectFrom("organizations").select(db.fn.countAll().as("count")).executeTakeFirstOrThrow();
      assert.deepEqual(after, before);
    });

    await t.test("membership uniqueness also covers inactive duplicates", async () => {
      await assert.rejects(db.insertInto("memberships").values({
        organization_id: seed.organizationId, user_id: seed.userId, role: "VIEWER", status: "INACTIVE"
      }).execute(), { code: "23505", constraint: "memberships_organization_user_unique" });
    });

    await t.test("global users can participate in another organization", async () => {
      const other = await db.insertInto("organizations").values({
        name: "Other tenant", base_currency: "USD", accounting_timezone: "UTC", status: "SUSPENDED"
      }).returning("id").executeTakeFirstOrThrow();
      await db.insertInto("memberships").values({
        organization_id: other.id, user_id: seed.userId, role: "ACCOUNTANT"
      }).execute();
    });

    await t.test("foreign keys reject nonexistent organizations and users", async () => {
      for (const values of [
        { organization_id: randomUUID(), user_id: seed.userId },
        { organization_id: seed.organizationId, user_id: randomUUID() }
      ]) {
        await assert.rejects(db.insertInto("memberships").values({ ...values, role: "VIEWER" }).execute(), { code: "23503" });
      }
    });

    await t.test("enum types reject invalid statuses and roles", async () => {
      for (const [table, column, id, invalid] of [
        ["organizations", "status", seed.organizationId, "INACTIVE"],
        ["users", "status", seed.userId, "SUSPENDED"],
        ["memberships", "status", seed.membershipId, "SUSPENDED"],
        ["memberships", "role", seed.membershipId, "SUPERUSER"]
      ]) {
        await assert.rejects(db.updateTable(table).set({ [column]: invalid }).where("id", "=", id).execute(), { code: "22P02" });
      }
      const { rows } = await sql`
        select t.typname, e.enumlabel from pg_type t
        join pg_enum e on e.enumtypid = t.oid
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = ${schema} order by t.typname, e.enumsortorder
      `.execute(db);
      const enums = Object.groupBy(rows, (row) => row.typname);
      assert.deepEqual(enums.membership_role.map((row) => row.enumlabel),
        ["OWNER", "ADMIN", "ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"]);
      assert.deepEqual(enums.organization_status.map((row) => row.enumlabel), ["ACTIVE", "SUSPENDED"]);
      for (const name of ["user_status", "membership_status"]) {
        assert.deepEqual(enums[name].map((row) => row.enumlabel), ["ACTIVE", "INACTIVE"]);
      }
    });

    await t.test("required fields and blank configuration are rejected", async () => {
      await assert.rejects(db.insertInto("organizations").values({ name: "Missing config" }).execute(), { code: "23502" });
      for (const values of [
        { name: " ", base_currency: "EGP", accounting_timezone: "UTC" },
        { name: "Test", base_currency: "egp", accounting_timezone: "UTC" },
        { name: "Test", base_currency: "EGP", accounting_timezone: " " }
      ]) {
        await assert.rejects(db.insertInto("organizations").values(values).execute(), { code: "23514" });
      }
    });

    await t.test("parent deletion cannot orphan a membership", async () => {
      await assert.rejects(db.deleteFrom("organizations").where("id", "=", seed.organizationId).execute(), { code: "23503" });
      await assert.rejects(db.deleteFrom("users").where("id", "=", seed.userId).execute(), { code: "23503" });
    });

    await t.test("composite actor references reject a membership from another tenant", async () => {
      // A fixture demonstrates the reference contract for future business tables.
      await db.schema.createTable("actor_reference_fixture")
        .addColumn("organization_id", "uuid", (c) => c.notNull())
        .addColumn("actor_membership_id", "uuid", (c) => c.notNull())
        .addForeignKeyConstraint("fixture_actor_fk", ["organization_id", "actor_membership_id"],
          "memberships", ["organization_id", "id"]).execute();
      await sql`insert into actor_reference_fixture values (${seed.organizationId}, ${seed.membershipId})`.execute(db);
      await assert.rejects(sql`insert into actor_reference_fixture
        select organization_id, ${seed.membershipId}::uuid from memberships
        where user_id = ${seed.userId} and organization_id <> ${seed.organizationId}`.execute(db), { code: "23503" });
      await db.schema.dropTable("actor_reference_fixture").execute();
    });

    await t.test("concurrent duplicate memberships commit only once", async () => {
      const user = await db.insertInto("users").values({ email: "race@ledgerflow.example", full_name: "Race", password_hash: "!" })
        .returning("id").executeTakeFirstOrThrow();
      const insert = () => db.insertInto("memberships").values({
        organization_id: seed.organizationId, user_id: user.id, role: "VIEWER"
      }).execute();
      const outcomes = await Promise.allSettled([insert(), insert()]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
      const failed = outcomes.find((outcome) => outcome.status === "rejected");
      assert.equal(failed.reason.code, "23505");
    });

    await t.test("migration rolls back and reapplies in a disposable schema", async () => {
      assert.equal((await migrator.migrateTo(NO_MIGRATIONS)).error, undefined);
      assert.equal((await migrator.migrateToLatest()).error, undefined);
      assert.equal((await db.selectFrom("memberships").selectAll().execute()).length, 0);
    });
  } finally {
    await db.destroy();
    // Only this run's randomly named test schema and its fixtures are removed.
    try {
      if (created) await admin.schema.dropSchema(schema).cascade().execute();
    } finally {
      await admin.destroy();
    }
  }
});
