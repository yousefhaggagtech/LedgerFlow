import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { createDatabase } from "../dist/index.js";
import { createMigrator } from "../dist/migrator.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL test database.");

async function fixture(work) {
  const schema = `tenant_guards_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(connectionString);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const db = createDatabase(url.toString());
  let created = false;
  try {
    await admin.schema.createSchema(schema).execute();
    created = true;
    const migrator = createMigrator(db, schema);
    assert.equal((await migrator.migrateTo("004_rbac_permissions")).error, undefined);
    const tenants = [];
    for (const name of ["A", "B"]) {
      const organization = await db.insertInto("organizations").values({ name, base_currency: "EGP", accounting_timezone: "Africa/Cairo" })
        .returningAll().executeTakeFirstOrThrow();
      const user = await db.insertInto("users").values({ email: `${name}@example.com`, password_hash: "!", full_name: name })
        .returning("id").executeTakeFirstOrThrow();
      const member = await db.insertInto("memberships").values({ organization_id: organization.id, user_id: user.id, role: "OWNER" })
        .returningAll().executeTakeFirstOrThrow();
      tenants.push({ organization, user, member });
    }
    const [a, b] = tenants;
    const audit = { organization_id: a.organization.id, actor_kind: "HUMAN", actor_membership_id: a.member.id,
      actor_user_id: a.user.id, action: "MEMBER_ADDED", target_type: "MEMBERSHIP", target_id: a.member.id,
      correlation_id: randomUUID(), new_state: "{}" };
    const snapshot = { organization: a.organization, membership: { organizationId: a.organization.id, userId: a.user.id, role: "OWNER", status: "ACTIVE" } };
    const record = { organization_id: a.organization.id, user_id: a.user.id, command_type: "organization:create",
      idempotency_key: randomUUID(), request_hash: "a".repeat(64), response_status: 201,
      response_snapshot: JSON.stringify(snapshot), expires_at: new Date(Date.now() + 60_000) };
    await work({ db, migrator, schema, a, b, audit, record, snapshot });
  } finally {
    await db.destroy();
    try { if (created) await admin.schema.dropSchema(schema).cascade().execute(); }
    finally { await admin.destroy(); }
  }
}

test("tenant relationship migration preserves history and enforces composite references", async (t) => {
  await fixture(async ({ db, migrator, schema, a, b, audit, record, snapshot }) => {
    const oldAudit = await db.insertInto("audit_events").values(audit).returningAll().executeTakeFirstOrThrow();
    const oldRecord = await db.insertInto("idempotency_records").values(record).returningAll().executeTakeFirstOrThrow();
    assert.equal((await migrator.migrateToLatest()).error, undefined);
    assert.deepEqual((await migrator.migrateToLatest()).results, []);

    await t.test("upgrade and rollback preserve original data and recompute generated targets", async () => {
      const upgraded = await db.selectFrom("audit_events").selectAll().where("id", "=", oldAudit.id).executeTakeFirstOrThrow();
      assert.deepEqual(upgraded, { ...oldAudit, target_membership_id: a.member.id });
      assert.deepEqual(await db.selectFrom("idempotency_records").selectAll().where("id", "=", oldRecord.id).executeTakeFirstOrThrow(), oldRecord);
      assert.equal((await migrator.migrateTo("004_rbac_permissions")).error, undefined);
      assert.deepEqual(await db.selectFrom("audit_events").selectAll().where("id", "=", oldAudit.id).executeTakeFirstOrThrow(), oldAudit);
      assert.deepEqual(await db.selectFrom("idempotency_records").selectAll().where("id", "=", oldRecord.id).executeTakeFirstOrThrow(), oldRecord);
      assert.equal((await migrator.migrateToLatest()).error, undefined);
    });

    await t.test("membership and organization audit targets cannot reference another tenant or nonexistent resources", async () => {
      for (const target_id of [b.member.id, randomUUID()]) {
        await assert.rejects(db.insertInto("audit_events").values({ ...audit, target_id }).execute(),
          { code: "23503", constraint: "audit_events_target_membership_fk" });
      }
      await assert.rejects(db.insertInto("audit_events").values({ ...audit, action: "ORGANIZATION_CREATED",
        target_type: "ORGANIZATION", target_id: b.organization.id }).execute(),
      { code: "23514", constraint: "audit_events_target_organization_scope" });
      const root = await db.insertInto("audit_events").values({ ...audit, action: "ORGANIZATION_CREATED",
        target_type: "ORGANIZATION", target_id: a.organization.id }).returning("target_membership_id").executeTakeFirstOrThrow();
      assert.equal(root.target_membership_id, null);
      await assert.rejects(db.insertInto("audit_events").values({ ...audit, target_membership_id: null }).execute(), { code: "428C9" });
    });

    await t.test("idempotency records require same-tenant creator membership", async () => {
      await assert.rejects(db.insertInto("idempotency_records").values({ ...record, user_id: b.user.id,
        idempotency_key: randomUUID(), response_snapshot: JSON.stringify({ ...snapshot,
          membership: { ...snapshot.membership, userId: b.user.id } }) }).execute(),
      { code: "23503", constraint: "idempotency_records_membership_fk" });
    });

    await t.test("creation snapshots cannot contain a foreign tenant, user, or absent scope", async () => {
      for (const response of [{}, { ...snapshot, organization: b.organization },
        { ...snapshot, membership: { ...snapshot.membership, organizationId: b.organization.id } },
        { ...snapshot, membership: { ...snapshot.membership, userId: b.user.id } }]) {
        await assert.rejects(db.insertInto("idempotency_records").values({ ...record, idempotency_key: randomUUID(),
          response_snapshot: JSON.stringify(response) }).execute(), { code: "23514", constraint: "idempotency_records_creation_scope" });
      }
    });

    await t.test("all foreign keys to tenant-owned parents include matching tenant columns", async () => {
      const keys = await sql`SELECT c.conname,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(num, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS child_columns,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(num, ord)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS parent_columns
        FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.contype = 'f' AND n.nspname = ${schema}
          AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'organization_id')`.execute(db);
      assert.ok(keys.rows.length >= 3);
      for (const key of keys.rows) {
        const position = key.parent_columns.indexOf("organization_id");
        assert.ok(position >= 0, key.conname);
        assert.equal(key.child_columns[position], "organization_id", key.conname);
      }
    });

    await t.test("new foreign-key checks have eligible child indexes", async () => {
      await db.transaction().execute(async (trx) => {
        await sql`SET LOCAL enable_seqscan = off`.execute(trx);
        const auditPlan = await sql`EXPLAIN (FORMAT JSON) SELECT 1 FROM audit_events
          WHERE organization_id = ${a.organization.id}::uuid AND target_membership_id = ${a.member.id}::uuid`.execute(trx);
        const creationPlan = await sql`EXPLAIN (FORMAT JSON) SELECT 1 FROM idempotency_records
          WHERE organization_id = ${a.organization.id}::uuid AND user_id = ${a.user.id}::uuid`.execute(trx);
        assert.match(JSON.stringify(auditPlan.rows), /audit_events_target_membership_index/);
        assert.match(JSON.stringify(creationPlan.rows), /idempotency_records_membership_index/);
      });
    });
  });
});

for (const invalid of ["audit target", "creator membership", "response snapshot"]) {
  test(`tenant migration fails atomically on a historical invalid ${invalid}`, async () => {
    await fixture(async ({ db, migrator, schema, b, audit, record }) => {
      if (invalid === "audit target") await db.insertInto("audit_events").values({ ...audit, target_id: b.member.id }).execute();
      if (invalid === "creator membership") await db.insertInto("idempotency_records").values({ ...record, organization_id: b.organization.id }).execute();
      if (invalid === "response snapshot") await db.insertInto("idempotency_records").values({ ...record, response_snapshot: "{}" }).execute();
      const before = await db.selectFrom("audit_events").selectAll().execute();
      const records = await db.selectFrom("idempotency_records").selectAll().execute();
      const result = await migrator.migrateToLatest();
      assert.ok(result.error);
      assert.deepEqual(await db.selectFrom("audit_events").selectAll().execute(), before);
      assert.deepEqual(await db.selectFrom("idempotency_records").selectAll().execute(), records);
      const columns = await sql`SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'audit_events' AND column_name = 'target_membership_id'`.execute(db);
      assert.deepEqual(columns.rows, []);
    });
  });
}
