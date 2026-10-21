import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDatabase } from "@ledgerflow/db";
import { createMigrator } from "../../../../packages/db/dist/migrator.js";
import { PostgresOrganizationStore } from "../../dist/infrastructure/organization-store.js";
import { BaseTenantRepository } from "../../dist/infrastructure/tenant-repository.js";
import { OrganizationService } from "../../dist/modules/organizations/service.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL test database.");
const settings = { name: "Tenant", baseCurrency: "EGP", accountingTimezone: "Africa/Cairo" };

test("tenant repositories enforce authenticated scope on PostgreSQL", async (t) => {
  const schema = `tenant_repository_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(connectionString);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const db = createDatabase(url.toString());
  let created = false;
  try {
    await admin.schema.createSchema(schema).execute();
    created = true;
    const migrator = createMigrator(db, schema);
    // Exercise fail-closed replay even against historical, insufficiently constrained data.
    assert.equal((await migrator.migrateTo("004_rbac_permissions")).error, undefined);
    const store = new PostgresOrganizationStore(db);
    const service = new OrganizationService(store);
    const user = async () => {
      const row = await db.insertInto("users").values({ email: `${randomUUID()}@example.com`, full_name: "User", password_hash: "!" })
        .returning("id").executeTakeFirstOrThrow();
      return { userId: row.id, correlationId: randomUUID() };
    };
    const alice = await user();
    const bob = await user();
    const shared = await user();
    const key = randomUUID();
    const a = await service.create(alice, settings, key);
    const b = await service.create(bob, settings, randomUUID());

    await t.test("a foreign-tenant replay snapshot never leaves the service", async () => {
      for (const response of [b, { ...a, membership: { ...a.membership, userId: bob.userId } }]) {
        await db.updateTable("idempotency_records").set({ response_snapshot: JSON.stringify(response) })
          .where("organization_id", "=", a.organization.id).where("user_id", "=", alice.userId).where("idempotency_key", "=", key).execute();
        await assert.rejects(service.create(alice, settings, key), /Invalid stored creation scope/);
      }
      await db.updateTable("idempotency_records").set({ response_snapshot: JSON.stringify(a) })
        .where("organization_id", "=", a.organization.id).where("user_id", "=", alice.userId).where("idempotency_key", "=", key).execute();
    });
    assert.equal((await migrator.migrateToLatest()).error, undefined);

    await t.test("repository factories reject inaccessible tenants, missing tenants, and identity substitution", async () => {
      for (const organizationId of [b.organization.id, randomUUID()]) {
        await assert.rejects(store.transaction(alice, (transaction) => transaction.forOrganization(organizationId)),
          { code: "RESOURCE_NOT_FOUND", message: "Organization not found." });
      }
      await store.transaction(alice, async (transaction) => {
        assert.equal(await transaction.findAuthorization(b.organization.id, bob.userId), undefined);
        assert.deepEqual((await transaction.listForUser({ limit: 100 })).map((row) => row.id), [a.organization.id]);
      });
      await assert.rejects(store.transaction({ userId: " " }, async () => {}), { code: "UNAUTHENTICATED" });
      await assert.rejects(store.transaction(alice, (transaction) => transaction.createOrganization(settings)), { code: "UNAUTHENTICATED" });
    });

    await t.test("transaction identity is captured before asynchronous work", async () => {
      const context = { userId: alice.userId };
      const pending = store.transaction(context, async (transaction) => {
        assert.deepEqual((await transaction.listForUser({ limit: 100 })).map((row) => row.id), [a.organization.id]);
        await assert.rejects(transaction.forOrganization(b.organization.id), { code: "RESOURCE_NOT_FOUND" });
      });
      context.userId = bob.userId;
      await pending;
    });

    await t.test("concurrent tenants remain isolated while reusing the connection pool", async () => {
      await Promise.all(Array.from({ length: 20 }, async (_, index) => {
        const [actor, own, other] = index % 2 ? [alice, a, b] : [bob, b, a];
        await store.transaction(actor, async (transaction) => {
          const repository = await transaction.forOrganization(own.organization.id);
          assert.equal((await repository.organization("read")).id, own.organization.id);
          await assert.rejects(transaction.forOrganization(other.organization.id), { code: "RESOURCE_NOT_FOUND" });
        });
      }));
    });

    await t.test("foreign membership lookup and role mutation fail closed without changing the other tenant", async () => {
      await store.transaction(alice, async (transaction) => {
        const repository = await transaction.forOrganization(a.organization.id);
        assert.equal(await repository.findMembership(bob.userId), undefined);
        await repository.organization("write");
        await assert.rejects(repository.changeRole(bob.userId, "ADMIN"), { code: "RESOURCE_NOT_FOUND", message: "Membership not found." });
      });
      assert.equal((await db.selectFrom("memberships").select("role").where("organization_id", "=", b.organization.id)
        .where("user_id", "=", bob.userId).executeTakeFirstOrThrow()).role, "OWNER");
    });

    await t.test("shared identities have independent memberships and scoped inserts", async () => {
      await service.add(a.organization.id, alice, { userId: shared.userId, role: "VIEWER" });
      await service.add(b.organization.id, bob, { userId: shared.userId, role: "VIEWER" });
      await service.changeRole(a.organization.id, alice, shared.userId, "ACCOUNTANT");
      const memberships = await db.selectFrom("memberships").select(["organization_id", "role"]).where("user_id", "=", shared.userId).execute();
      assert.equal(memberships.find((row) => row.organization_id === a.organization.id).role, "ACCOUNTANT");
      assert.equal(memberships.find((row) => row.organization_id === b.organization.id).role, "VIEWER");
    });

    await t.test("audits cannot substitute another actor, even one with a valid membership", async () => {
      await store.transaction(alice, async (transaction) => {
        const repository = await transaction.forOrganization(a.organization.id);
        await repository.organization("write");
        const member = await repository.findMembership(shared.userId);
        await assert.rejects(repository.audit({ actor: member, correlationId: randomUUID(), action: "MEMBER_ADDED",
          targetType: "MEMBERSHIP", targetId: member.id, previousState: null, newState: {} }), /authenticated user/);
      });
    });

    await t.test("inactive membership cannot acquire a scoped repository", async () => {
      await db.updateTable("memberships").set({ status: "INACTIVE" }).where("organization_id", "=", a.organization.id)
        .where("user_id", "=", shared.userId).execute();
      await assert.rejects(store.transaction(shared, (transaction) => transaction.forOrganization(a.organization.id)), { code: "RESOURCE_NOT_FOUND" });
    });

    await t.test("base select/update/delete/insert helpers isolate real rows", async () => {
      await db.schema.createTable("tenant_resource_fixture").addColumn("id", "uuid", (c) => c.primaryKey())
        .addColumn("organization_id", "uuid", (c) => c.notNull()).addColumn("name", "text", (c) => c.notNull()).execute();
      class ResourceRepository extends BaseTenantRepository {
        constructor(trx, context) { super(context); this.trx = trx; }
        insert(input) { return this.trx.insertInto("tenant_resource_fixture").values(this.insertValues(input)).execute(); }
        get(id) { return this.find(this.trx.selectFrom("tenant_resource_fixture")).selectAll().where("id", "=", id).executeTakeFirst(); }
        rename(id) { return this.update(this.trx.updateTable("tenant_resource_fixture")).set({ name: "Updated" }).where("id", "=", id).executeTakeFirst(); }
        remove(id) { return this.delete(this.trx.deleteFrom("tenant_resource_fixture")).where("id", "=", id).executeTakeFirst(); }
      }
      const foreignId = randomUUID();
      await db.transaction().execute(async (trx) => {
        const foreign = new ResourceRepository(trx, { organizationId: b.organization.id, userId: bob.userId });
        const local = new ResourceRepository(trx, { organizationId: a.organization.id, userId: alice.userId });
        await foreign.insert({ id: foreignId, name: "Foreign" });
        assert.equal(await local.get(foreignId), undefined);
        assert.equal((await local.rename(foreignId)).numUpdatedRows, 0n);
        assert.equal((await local.remove(foreignId)).numDeletedRows, 0n);
        assert.throws(() => local.insert({ id: randomUUID(), name: "Injected", organization_id: b.organization.id }), /cannot be supplied/);
        const localId = randomUUID();
        await local.insert({ id: localId, name: "Local" });
        assert.equal((await local.get(localId)).organization_id, a.organization.id);
        assert.equal((await local.rename(localId)).numUpdatedRows, 1n);
        assert.equal((await local.remove(localId)).numDeletedRows, 1n);
      });
      assert.deepEqual(await db.selectFrom("tenant_resource_fixture").selectAll().execute(),
        [{ id: foreignId, organization_id: b.organization.id, name: "Foreign" }]);
    });
  } finally {
    await db.destroy();
    try { if (created) await admin.schema.dropSchema(schema).cascade().execute(); }
    finally { await admin.destroy(); }
  }
});
