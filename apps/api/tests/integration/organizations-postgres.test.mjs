import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { sql } from "kysely";
import { createDatabase } from "@ledgerflow/db";
import { createMigrator } from "../../../../packages/db/dist/migrator.js";
import { createApp } from "../../dist/app.js";
import { PostgresAuthStore } from "../../dist/infrastructure/auth-store.js";
import { PostgresOrganizationStore } from "../../dist/infrastructure/organization-store.js";
import { loadAuthConfig, SESSION_TTL_MS } from "../../dist/modules/auth/config.js";
import { newSessionToken, sessionKey } from "../../dist/modules/auth/session.js";
import { OrganizationService } from "../../dist/modules/organizations/service.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL test database.");
const settings = { name: "Organization Test", baseCurrency: "EGP", accountingTimezone: "Africa/Cairo" };

test("organization management on PostgreSQL", async (t) => {
  const schema = `organizations_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(connectionString);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const db = createDatabase(url.toString());
  const config = loadAuthConfig({ NODE_ENV: "test", WEB_ORIGIN: "http://localhost:3000" });
  const authStore = new PostgresAuthStore(db);
  const organizationStore = new PostgresOrganizationStore(db);
  let server;
  let created = false;
  try {
    await admin.schema.createSchema(schema).execute();
    created = true;
    const migrator = createMigrator(db, schema);
    await t.test("additive migration, rollback, and reapplication preserve existing identities and sessions", async () => {
      assert.equal((await migrator.migrateTo("002_sessions")).error, undefined);
      const user = await db.insertInto("users").values({ email: "migration@example.com", full_name: "Existing", password_hash: "!" })
        .returning("id").executeTakeFirstOrThrow();
      const session = sessionKey(newSessionToken());
      await authStore.createSession({ ...session, userId: user.id, createdAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS), userAgent: null, ipAddress: null });
      assert.equal((await migrator.migrateToLatest()).error, undefined);
      assert.deepEqual((await migrator.migrateToLatest()).results, []);
      assert.equal((await migrator.migrateDown()).error, undefined);
      assert.equal((await authStore.findSessionUser(session, new Date())).id, user.id);
      assert.equal((await migrator.migrateToLatest()).error, undefined);
      assert.equal((await authStore.findSessionUser(session, new Date())).id, user.id);
    });

    server = createApp({ authStore, organizationStore, authConfig: config, checkDatabase: async () => {} }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const request = (path, cookie, method = "GET", body, headers = {}) => fetch(`${endpoint}${path}`, {
      method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const user = async () => {
      const row = await db.insertInto("users").values({ email: `${randomUUID()}@example.com`, full_name: "Member", password_hash: "!" })
        .returning("id").executeTakeFirstOrThrow();
      const token = newSessionToken();
      await authStore.createSession({ ...sessionKey(token), userId: row.id, createdAt: new Date(),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS), userAgent: null, ipAddress: null });
      return { id: row.id, cookie: `${config.cookieName}=${token}` };
    };
    const create = (who, key = randomUUID(), body = settings) => request("/organizations", who.cookie, "POST", body, { "Idempotency-Key": key });
    const fixture = async () => {
      const owner = await user();
      const response = await create(owner);
      assert.equal(response.status, 201);
      const result = await response.json();
      const path = `/organizations/${result.organization.id}`;
      const add = (who, target, role) => request(`${path}/members`, who.cookie, "POST", { userId: target.id, role });
      const patch = (who, target, role) => request(`${path}/members/${target.id}`, who.cookie, "PATCH", { role });
      return { owner, result, path, add, patch };
    };
    const membership = (organizationId, userId) => db.selectFrom("memberships").selectAll()
      .where("organization_id", "=", organizationId).where("user_id", "=", userId).executeTakeFirst();
    const audits = (organizationId) => db.selectFrom("audit_events").selectAll().where("organization_id", "=", organizationId).execute();

    await t.test("all organization endpoints require authentication", async () => {
      const path = `/organizations/${randomUUID()}`;
      for (const [route, method, body] of [
        ["/organizations", "POST", settings], ["/organizations", "GET"], [path, "GET"], [`${path}/members`, "GET"],
        [`${path}/members`, "POST", { userId: randomUUID(), role: "VIEWER" }],
        [`${path}/members/${randomUUID()}`, "PATCH", { role: "VIEWER" }]
      ]) assert.equal((await request(route, undefined, method, body)).status, 401);
    });

    await t.test("discovery exposes only the authenticated user's active organizations, with bounded pagination and live grants", async () => {
      const owner = await user();
      const outsider = await user();
      const first = await (await create(owner)).json();
      const second = await (await create(owner)).json();
      const foreign = await (await create(outsider)).json();
      const response = await request("/organizations?limit=1", owner.cookie);
      assert.equal(response.status, 200);
      const page = await response.json();
      assert.equal(page.items.length, 1);
      const next = await (await request(`/organizations?limit=1&cursor=${page.nextCursor}`, owner.cookie)).json();
      const ids = [...page.items, ...next.items].map((item) => item.id).sort();
      assert.deepEqual(ids, [first.organization.id, second.organization.id].sort());
      assert.ok(!ids.includes(foreign.organization.id));
      assert.equal(next.nextCursor, null);
      for (const item of [...page.items, ...next.items]) {
        assert.equal(item.membership.userId, owner.id);
        assert.equal(item.membership.organizationId, item.id);
        assert.ok(item.capabilities.includes("member:invite"));
        assert.deepEqual(Object.keys(item).sort(), ["capabilities", "id", "membership", "name"]);
      }
      const viewer = await user();
      const added = await request(`/organizations/${first.organization.id}/members`, owner.cookie, "POST", { userId: viewer.id, role: "VIEWER" });
      assert.equal(added.status, 201);
      const access = await (await request("/organizations", viewer.cookie)).json();
      assert.deepEqual(access.items[0].capabilities, []);
      assert.equal((await request(`/organizations/${first.organization.id}`, viewer.cookie)).status, 403);
      const permission = await db.selectFrom("permissions").select("id").where("code", "=", "org:read").executeTakeFirstOrThrow();
      try {
        await db.insertInto("role_permissions").values({ role: "VIEWER", permission_id: permission.id }).execute();
        const refreshed = await (await request("/organizations", viewer.cookie)).json();
        assert.deepEqual(refreshed.items[0].capabilities, ["org:read"]);
      } finally {
        await db.deleteFrom("role_permissions").where("role", "=", "VIEWER").where("permission_id", "=", permission.id).execute();
      }
      await db.updateTable("memberships").set({ status: "INACTIVE" }).where("organization_id", "=", first.organization.id).where("user_id", "=", viewer.id).execute();
      assert.deepEqual(await (await request("/organizations", viewer.cookie)).json(), { items: [], nextCursor: null });
      for (const query of [`userId=${outsider.id}`, "limit=101", "cursor=invalid", "limit=1&limit=2"]) {
        assert.equal((await request(`/organizations?${query}`, owner.cookie)).status, 400);
      }
      await db.transaction().execute(async (trx) => {
        await sql`set local enable_seqscan = off`.execute(trx);
        const plan = await sql`explain select o.id from memberships m join organizations o on o.id = m.organization_id
          where m.user_id = ${owner.id} and m.status = 'ACTIVE' and o.status = 'ACTIVE' order by o.id limit 26`.execute(trx);
        assert.match(JSON.stringify(plan.rows), /memberships_user_id_index|memberships_organization_user_unique/);
      });
    });

    await t.test("creation commits organization, Owner, audit actor, correlation, and idempotency response", async () => {
      const owner = await user();
      const response = await create(owner);
      assert.equal(response.status, 201);
      const result = await response.json();
      assert.deepEqual(result.organization, { id: result.organization.id, ...settings, status: "ACTIVE" });
      assert.deepEqual(result.membership, { userId: owner.id, organizationId: result.organization.id, role: "OWNER", status: "ACTIVE" });
      assert.deepEqual(await (await request(`/organizations/${result.organization.id}`, owner.cookie)).json(), result.organization);
      const member = await membership(result.organization.id, owner.id);
      const events = await audits(result.organization.id);
      assert.equal(events.length, 1);
      assert.equal(events[0].action, "ORGANIZATION_CREATED");
      assert.equal(events[0].actor_membership_id, member.id);
      assert.equal(events[0].actor_user_id, owner.id);
      assert.equal(events[0].correlation_id, response.headers.get("x-request-id"));
      assert.deepEqual(events[0].new_state, result);
      assert.equal(events[0].previous_state, null);
      const record = await db.selectFrom("idempotency_records").selectAll().where("user_id", "=", owner.id).executeTakeFirstOrThrow();
      assert.deepEqual(record.response_snapshot, result);
      assert.equal(record.response_status, 201);
      assert.equal(record.status, "COMPLETED");
      assert.doesNotMatch(JSON.stringify({ result, events, record }), /password_hash|token_hash|ledgerflow_session/);
    });

    await t.test("concurrent creation retries replay one result; payload and user scopes are enforced", async () => {
      const owner = await user();
      const key = randomUUID();
      const responses = await Promise.all([create(owner, key), create(owner, key)]);
      for (const response of responses) assert.equal(response.status, 201);
      const [first, second] = await Promise.all(responses.map((response) => response.json()));
      assert.deepEqual(first, second);
      const replay = await create(owner, key, { accountingTimezone: settings.accountingTimezone, baseCurrency: settings.baseCurrency, name: ` ${settings.name} ` });
      assert.equal(replay.status, 201);
      assert.deepEqual(await replay.json(), first);
      assert.equal((await create(owner, key, { ...settings, name: "Different" })).status, 409);
      assert.equal((await audits(first.organization.id)).length, 1);
      const records = await db.selectFrom("idempotency_records").selectAll().where("user_id", "=", owner.id).execute();
      assert.equal(records.length, 1);
      const otherUser = await user();
      const other = await create(otherUser, key);
      assert.equal(other.status, 201);
      assert.notEqual((await other.json()).organization.id, first.organization.id);
      await db.updateTable("memberships").set({ status: "INACTIVE" }).where("organization_id", "=", first.organization.id)
        .where("user_id", "=", owner.id).execute();
      assert.equal((await create(owner, key)).status, 404);
    });

    await t.test("expired creation keys fail closed and cannot create a second organization", async () => {
      const owner = await user();
      const key = randomUUID();
      const response = await create(owner, key);
      assert.equal(response.status, 201);
      await db.updateTable("idempotency_records").set({ created_at: new Date(Date.now() - 10_000), expires_at: new Date(Date.now() - 1_000) })
        .where("user_id", "=", owner.id).where("command_type", "=", "organization:create").where("idempotency_key", "=", key).execute();
      assert.equal((await create(owner, key)).status, 409);
      const records = await db.selectFrom("idempotency_records").select("id").where("user_id", "=", owner.id).execute();
      assert.equal(records.length, 1);
    });

    await t.test("Tenant Leak: absent and inaccessible tenants match; mutations never reach another tenant", async () => {
      const a = await fixture();
      const b = await fixture();
      const target = await user();
      assert.equal((await b.add(b.owner, target, "VIEWER")).status, 201);
      for (const path of [b.path, `/organizations/${randomUUID()}`]) {
        for (const [suffix, method, body] of [["", "GET"], ["/members", "GET"],
          ["/members", "POST", { userId: target.id, role: "VIEWER" }],
          [`/members/${target.id}`, "PATCH", { role: "ADMIN" }]]) {
          const response = await request(`${path}${suffix}`, a.owner.cookie, method, body);
          assert.equal(response.status, 404);
          assert.deepEqual(await response.json(), { error: "Organization not found." });
        }
      }
      assert.equal((await a.patch(a.owner, target, "ADMIN")).status, 404);
      assert.equal((await membership(b.result.organization.id, target.id)).role, "VIEWER");
      assert.equal(await membership(a.result.organization.id, target.id), undefined);
      // A global user can legitimately join both tenants; only the path membership changes.
      assert.equal((await a.add(a.owner, target, "ACCOUNTANT")).status, 201);
      assert.equal((await a.patch(a.owner, target, "FINANCE_MEMBER")).status, 200);
      assert.equal((await membership(a.result.organization.id, target.id)).role, "FINANCE_MEMBER");
      assert.equal((await membership(b.result.organization.id, target.id)).role, "VIEWER");
      const rows = await (await request(`${a.path}/members`, a.owner.cookie)).json();
      assert.ok(rows.items.every((row) => row.organizationId === a.result.organization.id));
      assert.equal((await audits(b.result.organization.id)).length, 2);
    });

    await t.test("Direct Add is active, duplicate requests conflict, and unknown/inactive identities stay unavailable", async () => {
      const f = await fixture();
      const target = await user();
      const responses = await Promise.all([f.add(f.owner, target, "VIEWER"), f.add(f.owner, target, "VIEWER")]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
      assert.equal((await membership(f.result.organization.id, target.id)).status, "ACTIVE");
      assert.equal((await audits(f.result.organization.id)).length, 2);
      await db.updateTable("memberships").set({ status: "INACTIVE" }).where("organization_id", "=", f.result.organization.id)
        .where("user_id", "=", target.id).execute();
      assert.equal((await f.add(f.owner, target, "ACCOUNTANT")).status, 409);
      assert.equal((await f.add(f.owner, { id: randomUUID() }, "VIEWER")).status, 404);
      const inactive = await user();
      await db.updateTable("users").set({ status: "INACTIVE" }).where("id", "=", inactive.id).execute();
      assert.equal((await f.add(f.owner, inactive, "VIEWER")).status, 404);
    });

    await t.test("strict assignment boundary permits standard Admin management and denies escalation/protected targets", async () => {
      const f = await fixture();
      const administrator = await user();
      const otherAdmin = await user();
      const standard = await user();
      for (const target of [administrator, otherAdmin]) assert.equal((await f.add(f.owner, target, "ADMIN")).status, 201);
      for (const role of ["ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"]) {
        const target = await user();
        assert.equal((await f.add(administrator, target, role)).status, 201);
      }
      for (const role of ["OWNER", "ADMIN"]) assert.equal((await f.add(administrator, await user(), role)).status, 403);
      assert.equal((await f.add(administrator, standard, "VIEWER")).status, 201);
      for (const target of [administrator, otherAdmin, f.owner]) {
        assert.equal((await f.patch(administrator, target, "VIEWER")).status, 403);
      }
      for (const role of ["OWNER", "ADMIN"]) assert.equal((await f.patch(administrator, standard, role)).status, 403);
      assert.equal((await f.patch(administrator, standard, "ACCOUNTANT")).status, 200);
      for (const role of ["OWNER", "ADMIN", "ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"]) {
        assert.equal((await f.patch(f.owner, standard, role)).status, 200);
      }
      assert.equal((await f.patch(f.owner, administrator, "VIEWER")).status, 200);
      // The same valid session immediately loses management capabilities after demotion.
      assert.equal((await f.add(administrator, await user(), "VIEWER")).status, 403);
    });

    await t.test("capabilities deny lower roles; inactive memberships and inactive users cannot access tenants", async () => {
      const f = await fixture();
      for (const role of ["ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"]) {
        const target = await user();
        assert.equal((await f.add(f.owner, target, role)).status, 201);
        assert.equal((await request(f.path, target.cookie)).status, 403);
        assert.equal((await request(`${f.path}/members`, target.cookie)).status, 403);
        assert.equal((await f.add(target, await user(), "VIEWER")).status, 403);
        assert.equal((await f.patch(target, f.owner, "VIEWER")).status, 403);
      }
      const administrator = await user();
      assert.equal((await f.add(f.owner, administrator, "ADMIN")).status, 201);
      await db.updateTable("memberships").set({ status: "INACTIVE" }).where("organization_id", "=", f.result.organization.id)
        .where("user_id", "=", administrator.id).execute();
      assert.equal((await request(f.path, administrator.cookie)).status, 404);
      assert.equal((await f.patch(administrator, f.owner, "VIEWER")).status, 404);
      await db.updateTable("users").set({ status: "INACTIVE" }).where("id", "=", administrator.id).execute();
      assert.equal((await create(administrator)).status, 401);
    });

    await t.test("DB revocation/grant controls every tenant endpoint with the same live Admin session", async () => {
      const f = await fixture();
      const administrator = await user();
      const target = await user();
      assert.equal((await f.add(f.owner, administrator, "ADMIN")).status, 201);
      const checks = [
        ["org:read", 200, () => request(f.path, administrator.cookie)],
        ["member:read", 200, () => request(`${f.path}/members`, administrator.cookie)],
        ["member:invite", 201, () => f.add(administrator, target, "VIEWER")],
        ["member:edit", 200, () => f.patch(administrator, target, "ACCOUNTANT")]
      ];
      for (const [code, allowed, check] of checks) {
        const permission = await db.selectFrom("permissions").select("id").where("code", "=", code).executeTakeFirstOrThrow();
        const before = (await audits(f.result.organization.id)).length;
        await db.deleteFrom("role_permissions").where("role", "=", "ADMIN").where("permission_id", "=", permission.id).execute();
        try {
          const denied = await check();
          assert.equal(denied.status, 403, code);
          assert.deepEqual(await denied.json(), { error: "Permission denied." });
          assert.equal((await audits(f.result.organization.id)).length, before);
        } finally {
          await db.insertInto("role_permissions").values({ role: "ADMIN", permission_id: permission.id }).execute();
        }
        assert.equal((await check()).status, allowed, code);
      }
    });

    await t.test("Viewer DB grants allow reads without role changes and cannot bypass assignment invariants or tenant scope", async () => {
      const f = await fixture();
      const other = await fixture();
      const viewer = await user();
      assert.equal((await f.add(f.owner, viewer, "VIEWER")).status, 201);
      const permissions = await db.selectFrom("permissions").select(["id", "code"]).where("code", "!=", "org:create").execute();
      const before = (await audits(f.result.organization.id)).length;
      assert.equal((await request(f.path, viewer.cookie)).status, 403);
      await db.insertInto("role_permissions").values(permissions.map((permission) => ({ role: "VIEWER", permission_id: permission.id }))).execute();
      try {
        assert.equal((await request(f.path, viewer.cookie)).status, 200);
        assert.equal((await request(`${f.path}/members`, viewer.cookie)).status, 200);
        assert.equal((await request(other.path, viewer.cookie)).status, 404);
        assert.equal((await f.add(viewer, await user(), "VIEWER")).status, 403);
        assert.equal((await f.patch(viewer, f.owner, "VIEWER")).status, 403);
        assert.equal((await audits(f.result.organization.id)).length, before);
        await db.updateTable("memberships").set({ status: "INACTIVE" }).where("organization_id", "=", f.result.organization.id)
          .where("user_id", "=", viewer.id).execute();
        assert.equal((await request(f.path, viewer.cookie)).status, 404);
      } finally {
        await db.deleteFrom("role_permissions").where("role", "=", "VIEWER").execute();
      }
      await db.updateTable("memberships").set({ status: "ACTIVE" }).where("organization_id", "=", f.result.organization.id)
        .where("user_id", "=", viewer.id).execute();
      assert.equal((await request(f.path, viewer.cookie)).status, 403);
    });

    await t.test("an unmapped Admin role has zero tenant access while authenticated bootstrap remains available", async () => {
      const f = await fixture();
      const administrator = await user();
      assert.equal((await f.add(f.owner, administrator, "ADMIN")).status, 201);
      const mappings = await db.selectFrom("role_permissions").selectAll().where("role", "=", "ADMIN").execute();
      await db.deleteFrom("role_permissions").where("role", "=", "ADMIN").execute();
      try {
        assert.equal((await request(f.path, administrator.cookie)).status, 403);
        assert.equal((await request(`${f.path}/members`, administrator.cookie)).status, 403);
        assert.equal((await f.add(administrator, await user(), "VIEWER")).status, 403);
        assert.equal((await f.patch(administrator, f.owner, "VIEWER")).status, 403);
        assert.equal((await create(administrator)).status, 201);
        assert.equal((await create(await user())).status, 201);
      } finally {
        await db.insertInto("role_permissions").values(mappings).execute();
      }
    });

    await t.test("capability revocation during lock contention is rechecked before mutation", async () => {
      const f = await fixture();
      const administrator = await user();
      const target = await user();
      assert.equal((await f.add(f.owner, administrator, "ADMIN")).status, 201);
      const permission = await db.selectFrom("permissions").select("id").where("code", "=", "member:invite").executeTakeFirstOrThrow();
      let observed;
      const read = new Promise((resolve) => { observed = resolve; });
      const watchedStore = { transaction: (context, work) => organizationStore.transaction(context, (transaction) => work(new Proxy(transaction, {
        get(instance, key) {
          if (key === "findAuthorization") return async (organizationId, userId) => {
            const result = await instance.findAuthorization(organizationId, userId);
            observed();
            return result;
          };
          const value = Reflect.get(instance, key);
          return typeof value === "function" ? value.bind(instance) : value;
        }
      }))) };
      let attempt;
      try {
        await db.transaction().execute(async (trx) => {
          await trx.selectFrom("organizations").select("id").where("id", "=", f.result.organization.id).forUpdate().execute();
          attempt = new OrganizationService(watchedStore).add(f.result.organization.id,
            { userId: administrator.id, correlationId: randomUUID() }, { userId: target.id, role: "VIEWER" });
          attempt.catch(() => {});
          await read;
          await trx.deleteFrom("role_permissions").where("role", "=", "ADMIN").where("permission_id", "=", permission.id).execute();
        });
        await assert.rejects(attempt, { status: 403 });
        assert.equal(await membership(f.result.organization.id, target.id), undefined);
        assert.equal((await audits(f.result.organization.id)).length, 2);
      } finally {
        await db.insertInto("role_permissions").values({ role: "ADMIN", permission_id: permission.id }).onConflict((c) => c.doNothing()).execute();
      }
    });

    await t.test("Last Owner: sole active Owner cannot be demoted; inactive Owners do not count; unchanged role is a no-op", async () => {
      const f = await fixture();
      const inactiveOwner = await user();
      assert.equal((await f.add(f.owner, inactiveOwner, "OWNER")).status, 201);
      await db.updateTable("memberships").set({ status: "INACTIVE" }).where("organization_id", "=", f.result.organization.id)
        .where("user_id", "=", inactiveOwner.id).execute();
      const before = await membership(f.result.organization.id, f.owner.id);
      const eventCount = (await audits(f.result.organization.id)).length;
      const response = await f.patch(f.owner, f.owner, "ADMIN");
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /at least one active Owner/);
      assert.deepEqual(await membership(f.result.organization.id, f.owner.id), before);
      assert.equal((await f.patch(f.owner, f.owner, "OWNER")).status, 200);
      assert.equal((await audits(f.result.organization.id)).length, eventCount);
    });

    await t.test("Last Owner race: simultaneous self-demotions leave exactly one active Owner", async () => {
      const f = await fixture();
      const second = await user();
      assert.equal((await f.add(f.owner, second, "OWNER")).status, 201);
      const responses = await Promise.all([f.patch(f.owner, f.owner, "ADMIN"), f.patch(second, second, "ADMIN")]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
      const owners = await db.selectFrom("memberships").select("id").where("organization_id", "=", f.result.organization.id)
        .where("role", "=", "OWNER").where("status", "=", "ACTIVE").execute();
      assert.equal(owners.length, 1);
      assert.equal((await audits(f.result.organization.id)).filter((row) => row.action === "MEMBER_ROLE_CHANGED").length, 1);
    });

    await t.test("authorization is rechecked after waiting for the organization lock", async () => {
      const f = await fixture();
      const administrator = await user();
      const target = await user();
      assert.equal((await f.add(f.owner, administrator, "ADMIN")).status, 201);
      let observed;
      const read = new Promise((resolve) => { observed = resolve; });
      const watchedStore = { transaction: (context, work) => organizationStore.transaction(context, (transaction) => work(new Proxy(transaction, {
        get(instance, key) {
          if (key === "findAuthorization") return async (organizationId, id) => {
            const result = await instance.findAuthorization(organizationId, id);
            if (id === administrator.id) observed();
            return result;
          };
          const value = Reflect.get(instance, key);
          return typeof value === "function" ? value.bind(instance) : value;
        }
      }))) };
      const service = new OrganizationService(watchedStore);
      let attempt;
      await db.transaction().execute(async (trx) => {
        await trx.selectFrom("organizations").select("id").where("id", "=", f.result.organization.id).forUpdate().execute();
        attempt = service.add(f.result.organization.id, { userId: administrator.id, correlationId: randomUUID() }, { userId: target.id, role: "VIEWER" });
        // Attach a rejection handler immediately; the result is asserted after releasing the lock.
        attempt.catch(() => {});
        await read;
        await trx.updateTable("memberships").set({ role: "VIEWER" }).where("organization_id", "=", f.result.organization.id)
          .where("user_id", "=", administrator.id).execute();
      });
      await assert.rejects(attempt, { status: 403 });
      assert.equal(await membership(f.result.organization.id, target.id), undefined);
    });

    await t.test("each mutation rolls back fully when its audit insert fails", async () => {
      for (const action of ["ORGANIZATION_CREATED", "MEMBER_ADDED", "MEMBER_ROLE_CHANGED"]) {
        const f = await fixture();
        const target = await user();
        if (action === "MEMBER_ROLE_CHANGED") assert.equal((await f.add(f.owner, target, "VIEWER")).status, 201);
        const before = await membership(f.result.organization.id, target.id);
        const key = randomUUID();
        const orgCount = await db.selectFrom("organizations").select(db.fn.countAll().as("count")).executeTakeFirstOrThrow();
        const auditCount = (await audits(f.result.organization.id)).length;
        await sql`ALTER TABLE audit_events ADD CONSTRAINT test_audit_failure CHECK (action <> ${sql.lit(action)}) NOT VALID`.execute(db);
        try {
          const response = action === "ORGANIZATION_CREATED" ? await create(f.owner, key)
            : action === "MEMBER_ADDED" ? await f.add(f.owner, target, "VIEWER") : await f.patch(f.owner, target, "ACCOUNTANT");
          assert.equal(response.status, 503);
          assert.deepEqual(await response.json(), { error: "Service is unavailable." });
          assert.deepEqual(await membership(f.result.organization.id, target.id), before);
          assert.equal((await audits(f.result.organization.id)).length, auditCount);
          assert.deepEqual(await db.selectFrom("organizations").select(db.fn.countAll().as("count")).executeTakeFirstOrThrow(), orgCount);
          assert.equal(await db.selectFrom("idempotency_records").select("id").where("user_id", "=", f.owner.id)
            .where("idempotency_key", "=", key).executeTakeFirst(), undefined);
        } finally { await db.schema.alterTable("audit_events").dropConstraint("test_audit_failure").execute(); }
        if (action === "ORGANIZATION_CREATED") assert.equal((await create(f.owner, key)).status, 201);
      }
    });

    await t.test("role audit records contain the authenticated actor and scoped before/after states", async () => {
      const f = await fixture();
      const target = await user();
      assert.equal((await f.add(f.owner, target, "VIEWER")).status, 201);
      const response = await f.patch(f.owner, target, "ACCOUNTANT");
      assert.equal(response.status, 200);
      const events = await audits(f.result.organization.id);
      const event = events.find((row) => row.action === "MEMBER_ROLE_CHANGED");
      assert.equal(events.length, 3);
      assert.equal(event.actor_user_id, f.owner.id);
      assert.equal(event.target_id, (await membership(f.result.organization.id, target.id)).id);
      assert.equal(event.previous_state.role, "VIEWER");
      assert.equal(event.new_state.role, "ACCOUNTANT");
      assert.equal(event.correlation_id, response.headers.get("x-request-id"));
      assert.deepEqual(event.new_state, await response.json());
    });

    await t.test("bounded keyset pages are deterministic, tenant-bound, and expose only membership DTOs", async () => {
      const f = await fixture();
      const users = await db.insertInto("users").values(Array.from({ length: 105 }, () => ({
        email: `${randomUUID()}@example.com`, full_name: "Pagination", password_hash: "!"
      }))).returning("id").execute();
      await db.insertInto("memberships").values(users.map((row) => ({ organization_id: f.result.organization.id, user_id: row.id, role: "VIEWER" }))).execute();
      const defaultPage = await (await request(`${f.path}/members`, f.owner.cookie)).json();
      assert.equal(defaultPage.items.length, 25);
      const first = await (await request(`${f.path}/members?limit=100`, f.owner.cookie)).json();
      assert.equal(first.items.length, 100);
      assert.ok(first.nextCursor);
      const second = await (await request(`${f.path}/members?limit=100&cursor=${first.nextCursor}`, f.owner.cookie)).json();
      assert.equal(second.items.length, 6);
      assert.equal(second.nextCursor, null);
      const items = [...first.items, ...second.items];
      assert.deepEqual(items.map((row) => row.userId), items.map((row) => row.userId).sort());
      assert.equal(new Set(items.map((row) => row.userId)).size, 106);
      for (const item of items) assert.deepEqual(Object.keys(item).sort(), ["organizationId", "role", "status", "userId"]);
      const other = await fixture();
      assert.equal((await request(`${other.path}/members?cursor=${first.nextCursor}`, other.owner.cookie)).status, 400);
      const end = Buffer.from(`${f.result.organization.id}:ffffffff-ffff-ffff-ffff-ffffffffffff`).toString("base64url");
      assert.deepEqual(await (await request(`${f.path}/members?cursor=${end}`, f.owner.cookie)).json(), { items: [], nextCursor: null });
      const plans = await Promise.all([
        sql`explain (format json) select user_id, role, status from memberships where organization_id = ${f.result.organization.id}::uuid
          and user_id > ${first.items[99].userId}::uuid order by user_id limit 101`.execute(db),
        sql`explain (format json) select id from memberships where organization_id = ${f.result.organization.id}::uuid and user_id = ${f.owner.id}::uuid`.execute(db)
      ]);
      for (const plan of plans) assert.match(JSON.stringify(plan.rows), /memberships_organization_user_unique/);
    });

    await t.test("strict body, identifier, key, timezone, currency, and pagination validation", async () => {
      const f = await fixture();
      const target = await user();
      for (const body of [null, [], {}, { ...settings, status: "ACTIVE" }, { ...settings, name: " " },
        { ...settings, name: "a".repeat(201) }, { ...settings, baseCurrency: "ZZZ" }, { ...settings, baseCurrency: "egp" },
        { ...settings, accountingTimezone: "Mars/Olympus" }, { ...settings, accountingTimezone: "+01:00" }]) {
        assert.equal((await create(f.owner, randomUUID(), body)).status, 400);
      }
      for (const key of [undefined, "bad key", "a".repeat(129)]) {
        const response = await request("/organizations", f.owner.cookie, "POST", settings, key ? { "Idempotency-Key": key } : {});
        assert.equal(response.status, 400);
      }
      for (const body of [{ userId: target.id, role: "SUPERUSER" }, { userId: target.id, role: "VIEWER", organizationId: randomUUID() },
        { userId: { $ne: "" }, role: "VIEWER" }, { userId: target.id, role: "VIEWER", status: "ACTIVE" }]) {
        assert.equal((await request(`${f.path}/members`, f.owner.cookie, "POST", body)).status, 400);
      }
      assert.equal((await request(`${f.path}/members/${target.id}`, f.owner.cookie, "PATCH", { role: "VIEWER", userId: target.id })).status, 400);
      for (const path of ["/organizations/not-a-uuid", `${f.path}/members/not-a-uuid`]) {
        assert.equal((await request(path, f.owner.cookie, path.endsWith("members/not-a-uuid") ? "PATCH" : "GET", path.includes("members/") ? { role: "VIEWER" } : undefined)).status, 400);
      }
      for (const query of ["limit=0", "limit=101", "limit=-1", "limit=1.5", "limit=1&limit=2", "cursor=invalid", "cursor=", "unknown=1"]) {
        assert.equal((await request(`${f.path}/members?${query}`, f.owner.cookie)).status, 400, query);
      }
      for (const [body, status] of [["{", 400], [JSON.stringify({ value: "x".repeat(9_000) }), 413]]) {
        const response = await fetch(`${endpoint}/organizations`, { method: "POST", headers: {
          "Content-Type": "application/json", Cookie: f.owner.cookie
        }, body });
        assert.equal(response.status, status);
        assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
      }
      assert.equal((await audits(f.result.organization.id)).length, 1);
    });

    await t.test("CORS permits credentialed PATCH and Idempotency-Key while origin/CSRF guards remain enforced", async () => {
      const f = await fixture();
      const response = await request(`${f.path}/members/${f.owner.id}`, undefined, "OPTIONS", undefined, {
        Origin: config.webOrigin, "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "content-type,idempotency-key"
      });
      assert.equal(response.status, 204);
      assert.match(response.headers.get("access-control-allow-methods"), /PATCH/);
      assert.match(response.headers.get("access-control-allow-headers"), /Idempotency-Key/);
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
      assert.equal((await request(`${f.path}/members/${f.owner.id}`, f.owner.cookie, "PATCH", { role: "OWNER" }, { Origin: "https://evil.example" })).status, 403);
      assert.equal((await request("/organizations", f.owner.cookie, "POST", settings, { "Sec-Fetch-Site": "cross-site", "Idempotency-Key": randomUUID() })).status, 403);
    });

    await t.test("PostgreSQL enforces append-only audit, actor tenant/user consistency, and idempotency constraints", async () => {
      const a = await fixture();
      const b = await fixture();
      const event = (await audits(a.result.organization.id))[0];
      for (const operation of [
        () => db.updateTable("audit_events").set({ action: "MEMBER_ADDED" }).where("organization_id", "=", a.result.organization.id).execute(),
        () => db.deleteFrom("audit_events").where("organization_id", "=", a.result.organization.id).execute(),
        () => sql`truncate audit_events`.execute(db)
      ]) await assert.rejects(operation(), { code: "23514" });
      const actor = await membership(a.result.organization.id, a.owner.id);
      const auditBase = { organization_id: a.result.organization.id, actor_kind: "HUMAN", actor_user_id: a.owner.id,
        actor_membership_id: actor.id, action: "MEMBER_ADDED", target_type: "MEMBERSHIP", target_id: actor.id,
        correlation_id: randomUUID(), new_state: "{}" };
      for (const override of [{ organization_id: b.result.organization.id }, { actor_user_id: b.owner.id }]) {
        await assert.rejects(db.insertInto("audit_events").values({ ...auditBase, ...override }).execute(), { code: "23503" });
      }
      for (const override of [{ actor_membership_id: null }, { action: "UNCONTROLLED" }, { new_state: "[]" }]) {
        await assert.rejects(db.insertInto("audit_events").values({ ...auditBase, ...override }).execute(), { code: "23514" });
      }
      const record = { user_id: a.owner.id, organization_id: a.result.organization.id, command_type: "organization:create",
        idempotency_key: randomUUID(), request_hash: "a".repeat(64), response_status: 201,
        response_snapshot: JSON.stringify(a.result), expires_at: new Date(Date.now() + 1_000) };
      for (const override of [{ request_hash: "bad" }, { status: "IN_PROGRESS" }, { response_status: 500 }, { response_snapshot: "[]" },
        { idempotency_key: "bad key" }, { expires_at: new Date(0) }]) {
        await assert.rejects(db.insertInto("idempotency_records").values({ ...record, ...override }).execute(), { code: "23514" });
      }
      assert.equal((await audits(a.result.organization.id))[0].id, event.id);
    });
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.destroy();
    try {
      // Only this run's randomly named disposable schema is removed.
      if (created) await admin.schema.dropSchema(schema).cascade().execute();
    } finally { await admin.destroy(); }
  }
});
