import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { createDatabase } from "@ledgerflow/db";
import { createMigrator } from "../../../../packages/db/dist/migrator.js";
import { expireCreationSnapshots, CREATION_CLEANUP_BATCH_SIZE, PostgresOrganizationStore } from "../../dist/infrastructure/organization-store.js";
import { OrganizationService } from "../../dist/modules/organizations/service.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL test database.");

test("idempotency migration and bounded concurrent compaction retain command keys permanently", async (t) => {
  const schema = `idempotency_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(connectionString);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const db = createDatabase(url.toString());
  let created = false;
  try {
    await admin.schema.createSchema(schema).execute(); created = true;
    const migrator = createMigrator(db, schema);
    assert.equal((await migrator.migrateTo("005_tenant_relationship_guards")).error, undefined);
    const user = await db.insertInto("users").values({ email: `${randomUUID()}@example.com`, full_name: "Owner", password_hash: "!" }).returning("id").executeTakeFirstOrThrow();
    const input = { name: "Retained", baseCurrency: "EGP", accountingTimezone: "Africa/Cairo" };
    const actor = { userId: user.id, correlationId: randomUUID() };
    const key = randomUUID();
    const service = new OrganizationService(new PostgresOrganizationStore(db));
    const result = await service.create(actor, input, key);
    const before = await db.selectFrom("idempotency_records").selectAll().executeTakeFirstOrThrow();
    assert.equal((await migrator.migrateToLatest()).error, undefined);
    await t.test("completed history survives expansion, down and reapplication", async () => {
      assert.deepEqual(await db.selectFrom("idempotency_records").selectAll().executeTakeFirstOrThrow(), before);
      assert.equal((await migrator.migrateDown()).error, undefined);
      assert.deepEqual(await db.selectFrom("idempotency_records").selectAll().executeTakeFirstOrThrow(), before);
      assert.equal((await migrator.migrateToLatest()).error, undefined);
      assert.deepEqual(await service.create(actor, input, key), result);
    });
    const record = { user_id: user.id, organization_id: result.organization.id, command_type: "organization:create",
      idempotency_key: "invalid", request_hash: before.request_hash, response_status: 201,
      response_snapshot: JSON.stringify(result), expires_at: new Date(Date.now() + 60_000) };
    await t.test("both states reject partial/null/malformed responses and invalid scope", async () => {
      for (const override of [
        { response_status: null }, { response_snapshot: null }, { response_snapshot: "null" },
        { status: "EXPIRED" }, { status: "EXPIRED", response_snapshot: null }, { status: "EXPIRED", response_status: null },
        { status: "OTHER", response_status: null, response_snapshot: null }, { response_snapshot: "{}" },
        { response_status: 500 }, { expires_at: new Date("2000-01-01") }
      ]) await assert.rejects(db.insertInto("idempotency_records").values({ ...record, ...override }).execute(), { code: "23514" });
    });
    const now = new Date();
    const expired = new Date(now.getTime() - 1_000);
    const createdAt = new Date(now.getTime() - 86_400_000);
    await db.updateTable("idempotency_records").set({ created_at: createdAt, expires_at: expired }).where("id", "=", before.id).execute();
    await db.insertInto("idempotency_records").values(Array.from({ length: CREATION_CLEANUP_BATCH_SIZE + 1 }, (_, index) => ({
      ...record, idempotency_key: `batch-${index}`, created_at: createdAt, expires_at: expired
    }))).execute();
    await db.insertInto("idempotency_records").values({ ...record, idempotency_key: "live" }).execute();
    const count = async (status) => Number((await db.selectFrom("idempotency_records").select((eb) => eb.fn.countAll().as("count")).where("status", "=", status).executeTakeFirstOrThrow()).count);
    await t.test("batch bounds and SKIP LOCKED preserve a held row and live snapshots", async () => {
      await db.transaction().execute(async (trx) => {
        await trx.selectFrom("idempotency_records").select("id").where("id", "=", before.id).forUpdate().execute();
        await expireCreationSnapshots(db, now);
        assert.equal(await count("EXPIRED"), CREATION_CLEANUP_BATCH_SIZE);
        assert.equal((await trx.selectFrom("idempotency_records").select("status").where("id", "=", before.id).executeTakeFirstOrThrow()).status, "COMPLETED");
      });
      await Promise.all([expireCreationSnapshots(db, now), expireCreationSnapshots(db, now)]);
      await expireCreationSnapshots(db, now);
      assert.equal(await count("EXPIRED"), CREATION_CLEANUP_BATCH_SIZE + 2);
      assert.equal(await count("COMPLETED"), 1);
      const tombstone = await db.selectFrom("idempotency_records").selectAll().where("id", "=", before.id).executeTakeFirstOrThrow();
      assert.deepEqual(tombstone, { ...before, created_at: createdAt, expires_at: expired, status: "EXPIRED", response_status: null, response_snapshot: null });
      await assert.rejects(service.create(actor, input, key), { code: "BUSINESS_CONFLICT", message: "Idempotency key has expired. Check the existing organization before retrying." });
      await assert.rejects(db.insertInto("idempotency_records").values({ ...record, idempotency_key: key }).execute(), { code: "23505" });
      assert.equal((await db.selectFrom("organizations").selectAll().execute()).length, 1);
      assert.equal((await db.selectFrom("audit_events").selectAll().execute()).length, 1);
    });
    await t.test("cleanup partial index excludes tombstones and rollback refuses them atomically", async () => {
      const indexes = await sql`SELECT indexdef FROM pg_indexes WHERE schemaname = ${schema} AND indexname = 'idempotency_records_completed_expiry_index'`.execute(db);
      assert.match(indexes.rows[0].indexdef, /expires_at, id/);
      assert.match(indexes.rows[0].indexdef, /COMPLETED/);
      const plan = await sql`EXPLAIN SELECT id FROM idempotency_records WHERE status = 'COMPLETED' AND expires_at <= ${now} ORDER BY expires_at, id LIMIT 1000 FOR UPDATE SKIP LOCKED`.execute(db);
      assert.ok(plan.rows.some((row) => row["QUERY PLAN"].includes("idempotency_records_completed_expiry_index")));
      const rollback = await migrator.migrateDown();
      assert.equal(rollback.error?.code, "55000");
      assert.equal(await count("EXPIRED"), CREATION_CLEANUP_BATCH_SIZE + 2);
      assert.deepEqual((await migrator.migrateToLatest()).results, []);
    });
  } finally {
    await db.destroy();
    try { if (created) await admin.schema.dropSchema(schema).cascade().execute(); }
    finally { await admin.destroy(); }
  }
});
