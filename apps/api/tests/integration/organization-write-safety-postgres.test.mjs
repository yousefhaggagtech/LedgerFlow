import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "kysely";
import { createDatabase } from "@ledgerflow/db";
import { createMigrator } from "../../../../packages/db/dist/migrator.js";
import { PostgresOrganizationStore } from "../../dist/infrastructure/organization-store.js";
import { OrganizationService } from "../../dist/modules/organizations/service.js";
import { membershipDto } from "../../dist/modules/organizations/types.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL test database.");
const settings = { name: "Write safety", baseCurrency: "EGP", accountingTimezone: "Africa/Cairo" };

test("organization write preconditions and rollback on PostgreSQL", { timeout: 30_000 }, async (t) => {
  const schema = `organization_safety_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(connectionString);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const db = createDatabase(url.toString());
  let created = false;
  try {
    await admin.schema.createSchema(schema).execute();
    created = true;
    assert.equal((await createMigrator(db, schema).migrateToLatest()).error, undefined);
    const store = new PostgresOrganizationStore(db);
    const service = new OrganizationService(store);
    const user = async () => {
      const row = await db.insertInto("users").values({ email: `${randomUUID()}@example.com`, full_name: "Safety", password_hash: "!" })
        .returning("id").executeTakeFirstOrThrow();
      return { userId: row.id, correlationId: randomUUID() };
    };
    const counts = async () => {
      const result = {};
      for (const table of ["organizations", "memberships", "audit_events", "idempotency_records"]) {
        result[table] = Number((await db.selectFrom(table).select(db.fn.countAll().as("count")).executeTakeFirstOrThrow()).count);
      }
      return result;
    };

    await t.test("existing tenant writes and Owner checks require an acquired write lock on that repository", async () => {
      const actor = await user();
      const target = await user();
      const root = await service.create(actor, settings, randomUUID());
      const before = await counts();
      for (const lock of [undefined, "read"]) {
        await store.transaction(actor, async (transaction) => {
          const repository = await transaction.forOrganization(root.organization.id);
          if (lock) await repository.organization(lock);
          const member = await repository.findMembership(actor.userId);
          for (const operation of [
            () => repository.addMember(target.userId, "VIEWER"),
            () => repository.changeRole(actor.userId, "ADMIN"),
            () => repository.hasOtherActiveOwner(actor.userId),
            () => repository.audit({ actor: member, correlationId: actor.correlationId, action: "MEMBER_ROLE_CHANGED",
              targetType: "MEMBERSHIP", targetId: member.id, previousState: membershipDto(member), newState: membershipDto(member) })
          ]) await assert.rejects(operation(), /Organization write lock is required/);
        });
      }
      await store.transaction(actor, async (transaction) => {
        const repository = await transaction.forOrganization(root.organization.id);
        const locking = repository.organization("write");
        await assert.rejects(repository.changeRole(actor.userId, "ADMIN"), /Organization write lock is required/);
        await locking;
        assert.equal(await repository.hasOtherActiveOwner(actor.userId), false);
        const another = await transaction.forOrganization(root.organization.id);
        await assert.rejects(another.changeRole(actor.userId, "ADMIN"), /Organization write lock is required/);
      });
      // A completed transaction must not confer lock authority on a later one.
      await store.transaction(actor, async (transaction) => {
        const repository = await transaction.forOrganization(root.organization.id);
        await assert.rejects(repository.changeRole(actor.userId, "ADMIN"), /Organization write lock is required/);
      });
      assert.deepEqual(await counts(), before);
    });

    await t.test("a thrown application callback after a successful write propagates and rolls back", async () => {
      const actor = await user();
      const before = await counts();
      const failure = new Error("injected callback failure");
      await assert.rejects(store.transaction(actor, async (transaction) => {
        assert.equal(await transaction.lockCreator(), true);
        await transaction.createOrganization(settings);
        throw failure;
      }), (error) => error === failure);
      assert.deepEqual(await counts(), before);
    });

    for (const stage of ["owner", "audit", "idempotency"]) {
      await t.test(`failed ${stage} persistence rolls back every creation write and permits same-key retry`, async () => {
        const actor = await user();
        const key = randomUUID();
        const before = await counts();
        const table = { owner: "memberships", audit: "audit_events", idempotency: "idempotency_records" }[stage];
        const constraint = `test_${stage}_failure`;
        const condition = stage === "owner" ? sql`role <> 'OWNER'`
          : stage === "audit" ? sql`action <> 'ORGANIZATION_CREATED'` : sql`idempotency_key <> ${sql.lit(key)}`;
        await sql`ALTER TABLE ${sql.table(table)} ADD CONSTRAINT ${sql.id(constraint)} CHECK (${condition}) NOT VALID`.execute(db);
        try {
          await assert.rejects(service.create(actor, settings, key), { code: "23514", constraint });
          assert.deepEqual(await counts(), before);
        } finally { await db.schema.alterTable(table).dropConstraint(constraint).execute(); }
        const result = await service.create(actor, settings, key);
        assert.equal(result.membership.role, "OWNER");
        const after = Object.fromEntries(Object.entries(before).map(([name, count]) => [name, count + 1]));
        assert.deepEqual(await counts(), after);
        assert.deepEqual(await service.create(actor, settings, key), result);
        assert.deepEqual(await counts(), after);
      });
    }
  } finally {
    await db.destroy();
    try { if (created) await admin.schema.dropSchema(schema).cascade().execute(); }
    finally { await admin.destroy(); }
  }
});
