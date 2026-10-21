import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import * as argon2 from "argon2";
import { sql } from "kysely";
import { createDatabase } from "@ledgerflow/db";
import { createMigrator } from "../../../../packages/db/dist/migrator.js";
import { createApp } from "../../dist/app.js";
import { PostgresAuthStore } from "../../dist/infrastructure/auth-store.js";
import { loadAuthConfig, SESSION_TTL_MS } from "../../dist/modules/auth/config.js";
import { newSessionToken, sessionKey } from "../../dist/modules/auth/session.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL test database.");

test("PostgreSQL auth schema, persistence, and HTTP lifecycle", async (t) => {
  const schema = `auth_test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(connectionString);
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  const db = createDatabase(url.toString());
  const store = new PostgresAuthStore(db);
  let created = false;
  let server;
  try {
    await admin.schema.createSchema(schema).execute();
    created = true;
    const migrator = createMigrator(db, schema);
    // Verify the additive migration preserves an existing Task 1.1 identity.
    assert.equal((await migrator.migrateTo("001_identity_and_tenancy")).error, undefined);
    const password = "integration-test-password";
    const user = await db.insertInto("users").values({ email: "postgres-auth@example.com", full_name: "Database Test",
      password_hash: await argon2.hash(password, { type: argon2.argon2id }) }).returning("id").executeTakeFirstOrThrow();
    assert.equal((await migrator.migrateToLatest()).error, undefined);
    assert.deepEqual((await migrator.migrateToLatest()).results, []);
    assert.equal((await store.findUserByEmail("postgres-auth@example.com")).id, user.id);
    let clock = new Date();
    const config = loadAuthConfig({ NODE_ENV: "test", WEB_ORIGIN: "http://localhost:3000" });
    const app = createApp({ authStore: store, authConfig: config, checkDatabase: async () => {}, now: () => new Date(clock) });
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const request = (path, options) => fetch(`${endpoint}${path}`, options);
    const login = () => request("/auth/login", { method: "POST", headers: {
      "Content-Type": "application/json", Origin: config.webOrigin, "User-Agent": "LedgerFlow integration test"
    }, body: JSON.stringify({ email: "postgres-auth@example.com", password }) });
    let key;
    let cookie;

    await t.test("login persists only the hash and audit metadata, authenticates across requests, and enforces expiry", async () => {
      assert.equal((await request("/auth/me")).status, 401);
      const response = await login();
      assert.equal(response.status, 200);
      cookie = response.headers.get("set-cookie").split(";")[0];
      const token = cookie.slice(cookie.indexOf("=") + 1);
      key = sessionKey(token);
      const row = await db.selectFrom("sessions").selectAll().where("id", "=", key.id).executeTakeFirstOrThrow();
      assert.equal(row.user_id, user.id);
      assert.equal(row.token_hash, key.tokenHash);
      assert.equal(row.user_agent, "LedgerFlow integration test");
      assert.equal(row.ip_address, "127.0.0.1");
      assert.equal(row.expires_at - row.created_at, SESSION_TTL_MS);
      assert.ok(!JSON.stringify(row).includes(token.split(".")[1]));
      assert.equal((await request("/auth/me", { headers: { Cookie: cookie } })).status, 200);
      assert.equal(await store.findSessionUser({ ...key, tokenHash: "0".repeat(64) }, clock), undefined);
      clock = new Date(row.expires_at);
      assert.equal((await request("/auth/me", { headers: { Cookie: cookie } })).status, 401);
      await store.deleteExpiredSessions(clock);
      assert.equal((await db.selectFrom("sessions").selectAll().execute()).length, 0);
    });

    await t.test("logout revokes the persisted session, and inactive identities fail closed", async () => {
      clock = new Date();
      const response = await login();
      cookie = response.headers.get("set-cookie").split(";")[0];
      await db.updateTable("users").set({ status: "INACTIVE", updated_at: new Date() }).where("id", "=", user.id).execute();
      assert.equal((await request("/auth/me", { headers: { Cookie: cookie } })).status, 401);
      assert.equal((await login()).status, 401);
      await db.updateTable("users").set({ status: "ACTIVE", updated_at: new Date() }).where("id", "=", user.id).execute();
      const logout = await request("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie } });
      assert.equal(logout.status, 204);
      assert.equal((await request("/auth/me", { headers: { Cookie: cookie } })).status, 401);
      assert.equal((await db.selectFrom("sessions").selectAll().execute()).length, 0);
    });

    const session = () => ({ ...sessionKey(newSessionToken()), userId: user.id,
      createdAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS), userAgent: null, ipAddress: null });
    await t.test("FKs, required fields, hash format, inet format, audit bounds, and expiry are enforced by PostgreSQL", async () => {
      const base = session();
      const insert = (override) => db.insertInto("sessions").values({ id: base.id, user_id: user.id,
        token_hash: base.tokenHash, created_at: base.createdAt, expires_at: base.expiresAt, ...override }).execute();
      for (const [override, code] of [
        [{ user_id: randomUUID() }, "23503"], [{ user_id: null }, "23502"],
        [{ token_hash: "raw-secret" }, "23514"], [{ expires_at: base.createdAt }, "23514"],
        [{ ip_address: "untrusted-header" }, "22P02"], [{ user_agent: "x".repeat(513) }, "22001"]
      ]) await assert.rejects(insert(override), { code });
    });

    await t.test("rotation is transactional and scoped to the full session credential", async () => {
      const first = session();
      await store.createSession(first);
      await assert.rejects(store.createSession({ ...session(), userId: randomUUID() }, first), { code: "23503" });
      assert.ok(await store.findSessionUser(first, new Date()));
      const second = session();
      await store.createSession(second, { ...first, tokenHash: "0".repeat(64) });
      assert.ok(await store.findSessionUser(first, new Date()));
      const third = session();
      await store.createSession(third, first);
      assert.equal(await store.findSessionUser(first, new Date()), undefined);
      assert.ok(await store.findSessionUser(third, new Date()));
      await store.deleteSession(second);
      await store.deleteSession(third);
    });

    await t.test("bounded concurrent cleanup removes expired sessions and preserves live sessions", async () => {
      const now = new Date();
      const expired = Array.from({ length: 1_001 }, () => ({
        id: randomUUID(), user_id: user.id, token_hash: "a".repeat(64),
        created_at: new Date(now.getTime() - 2_000), expires_at: new Date(now.getTime() - 1_000)
      }));
      await db.insertInto("sessions").values(expired).execute();
      const live = session();
      await store.createSession(live);
      await store.deleteExpiredSessions(now);
      let count = await db.selectFrom("sessions").select(db.fn.countAll().as("count")).executeTakeFirstOrThrow();
      assert.equal(Number(count.count), 2);
      await Promise.all([store.deleteExpiredSessions(now), store.deleteExpiredSessions(now)]);
      count = await db.selectFrom("sessions").select(db.fn.countAll().as("count")).executeTakeFirstOrThrow();
      assert.equal(Number(count.count), 1);
      assert.ok(await store.findSessionUser(live, now));
      const plan = await sql`explain (format json) select id from sessions where id = ${live.id}::uuid`.execute(db);
      assert.ok(JSON.stringify(plan.rows).includes("sessions_pkey"));
      await store.deleteSession(live);
    });

    await t.test("session rollback and reapplication preserve existing identities", async () => {
      assert.equal((await migrator.migrateTo("001_identity_and_tenancy")).error, undefined);
      assert.equal((await store.findUserByEmail("postgres-auth@example.com")).id, user.id);
      assert.equal((await migrator.migrateToLatest()).error, undefined);
    });

    await t.test("source and compiled entrypoints start and shut down cleanly", async () => {
      for (const entrypoint of ["../../src/index.ts", "../../dist/index.js"]) {
        const portProbe = createServer().listen(0, "127.0.0.1");
        await once(portProbe, "listening");
        const port = portProbe.address().port;
        await new Promise((resolve) => portProbe.close(resolve));
        // Windows child.kill terminates abruptly; IPC invokes the real shutdown handler.
        const preload = 'process.on("message", m => { if (m === "shutdown") { process.emit("SIGTERM"); process.disconnect(); } });';
        const child = fork(new URL(entrypoint, import.meta.url), [], {
          execArgv: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`],
          env: { ...process.env, DATABASE_URL: url.toString(), WEB_ORIGIN: config.webOrigin,
            NODE_ENV: "test", API_HOST: "127.0.0.1", API_PORT: String(port) }, silent: true
        });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        const exited = once(child, "exit");
        try {
          let ready = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            assert.equal(child.exitCode, null, output);
            try {
              const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
              if (health.status === 200) { ready = true; break; }
            } catch { /* Startup readiness is retried within the bounded deadline. */ }
            await delay(100);
          }
          assert.ok(ready, output);
          child.send("shutdown");
          const result = await Promise.race([exited, delay(12_000, undefined, { ref: false }).then(() => { throw new Error("API shutdown timed out"); })]);
          assert.equal(result[0], 0, output);
          assert.doesNotMatch(output, /session_cleanup_failed|could not shut down|api_request_failed/);
          assert.doesNotMatch(output, /api_start_failed|api_shutdown_failed|database_shutdown_failed/);
          const events = output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
          assert.deepEqual(events.map((event) => event.event).sort(), ["api_started", "api_stopped"]);
          for (const event of events) {
            assert.equal(event.level, "info");
            assert.ok(Number.isFinite(Date.parse(event.timestamp)));
            assert.deepEqual(Object.keys(event).sort(), ["event", "level", "timestamp"]);
          }
          assert.ok(!output.includes(url.toString()));
        } finally {
          if (child.exitCode === null) { child.kill(); await exited; }
        }
      }
    });
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await db.destroy();
    try {
      if (created) await admin.schema.dropSchema(schema).cascade().execute();
    } finally { await admin.destroy(); }
  }
});
