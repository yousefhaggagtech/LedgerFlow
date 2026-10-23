import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sql } from "kysely";
import { createDatabase } from "../dist/index.js";
import { createMigrator } from "../dist/migrator.js";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) throw new Error("TEST_DATABASE_URL must point to a disposable PostgreSQL test database.");
const base = new URL(connectionString);
function fixtureUrl(name) {
  if (!process.env[name]) throw new Error(`${name} must identify a dedicated unprivileged fixture login in the same disposable test database.`);
  const value = new URL(process.env[name]);
  assert.ok(["postgres:", "postgresql:"].includes(value.protocol));
  for (const key of ["hostname", "port", "pathname"]) assert.equal(value[key], base[key], "Role fixtures must use the same isolated target.");
  assert.notEqual(value.username, base.username);
  return value;
}
const ownerUrl = fixtureUrl("TEST_MIGRATOR_DATABASE_URL");
const runtimeUrl = fixtureUrl("TEST_RUNTIME_DATABASE_URL");
assert.notEqual(ownerUrl.username, runtimeUrl.username);
const provisionSql = await readFile(new URL("../src/provision-roles.sql", import.meta.url), "utf8");
const grantsSql = await readFile(new URL("../src/runtime-grants.sql", import.meta.url), "utf8");

test("separate runtime login has read-only catalogs, append-only audit privileges and no DDL", async () => {
  const schema = `runtime_privileges_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase(connectionString);
  for (const url of [ownerUrl, runtimeUrl]) url.searchParams.set("options", `-c search_path=${schema},public`);
  const owner = createDatabase(ownerUrl.toString());
  const runtime = createDatabase(runtimeUrl.toString());
  let created = false;
  const configure = async (db, script) => db.connection().execute(async (connection) => {
    await sql`SELECT set_config('ledgerflow.owner_role', ${decodeURIComponent(ownerUrl.username)}, false),
      set_config('ledgerflow.runtime_role', ${decodeURIComponent(runtimeUrl.username)}, false),
      set_config('ledgerflow.schema', ${schema}, false)`.execute(connection);
    await sql.raw(script).execute(connection);
  });
  try {
    await configure(admin, provisionSql);
    created = true;
    await configure(admin, provisionSql);
    assert.equal((await createMigrator(owner, schema).migrateToLatest()).error, undefined);
    await configure(owner, grantsSql);
    await configure(owner, grantsSql);
    const identity = (await sql`SELECT current_user AS role, session_user AS login, rolsuper, rolcreatedb, rolcreaterole,
      rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user`.execute(runtime)).rows[0];
    assert.deepEqual(identity, { role: decodeURIComponent(runtimeUrl.username), login: decodeURIComponent(runtimeUrl.username),
      rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    assert.equal((await runtime.selectFrom("permissions").selectAll().execute()).length, 5);
    assert.ok((await runtime.selectFrom("role_permissions").selectAll().execute()).length > 0);
    for (const table of ["permissions", "role_permissions"]) {
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const result = await sql`SELECT has_table_privilege(current_user, ${`${schema}.${table}`}, ${privilege}) AS allowed`.execute(runtime);
        assert.equal(result.rows[0].allowed, false, `${table} ${privilege}`);
      }
    }
    const user = await owner.insertInto("users").values({ email: `${randomUUID()}@example.com`, full_name: "Fixture", password_hash: "!" }).returning("id").executeTakeFirstOrThrow();
    const organization = await runtime.insertInto("organizations").values({ name: "Fixture", base_currency: "EGP", accounting_timezone: "Africa/Cairo" }).returning("id").executeTakeFirstOrThrow();
    const member = await runtime.insertInto("memberships").values({ organization_id: organization.id, user_id: user.id, role: "OWNER" }).returning("id").executeTakeFirstOrThrow();
    await runtime.updateTable("memberships").set({ role: "OWNER", updated_at: new Date() }).where("id", "=", member.id).execute();
    const sessionId = randomUUID();
    await runtime.insertInto("sessions").values({ id: sessionId, user_id: user.id, token_hash: "a".repeat(64), expires_at: new Date(Date.now() + 60_000) }).execute();
    await runtime.deleteFrom("sessions").where("id", "=", sessionId).execute();
    await runtime.insertInto("audit_events").values({ organization_id: organization.id, actor_kind: "HUMAN",
      actor_membership_id: member.id, actor_user_id: user.id, action: "ORGANIZATION_CREATED", target_type: "ORGANIZATION",
      target_id: organization.id, correlation_id: randomUUID(), new_state: "{}" }).execute();
    assert.equal((await runtime.selectFrom("audit_events").selectAll().execute()).length, 1);
    assert.ok(await runtime.selectFrom("users").select("password_hash").where("id", "=", user.id).executeTakeFirst());
    await runtime.insertInto("idempotency_records").values({ user_id: user.id, organization_id: organization.id,
      command_type: "organization:create", idempotency_key: randomUUID(), request_hash: "b".repeat(64), response_status: 201,
      response_snapshot: JSON.stringify({ organization: { id: organization.id }, membership: { organizationId: organization.id, userId: user.id } }),
      expires_at: new Date(Date.now() + 60_000) }).execute();
    const forbidden = [
      sql`UPDATE role_permissions SET role = role`,
      sql`INSERT INTO role_permissions (role, permission_id) SELECT role, permission_id FROM role_permissions WHERE FALSE`,
      sql`DELETE FROM role_permissions`, sql`CREATE TABLE forbidden_table (id integer)`,
      sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only`,
      sql`DELETE FROM audit_events`, sql`TRUNCATE audit_events`, sql`UPDATE audit_events SET correlation_id = correlation_id`,
      sql`DELETE FROM idempotency_records`, sql`UPDATE idempotency_records SET idempotency_key = 'changed'`
    ];
    for (const statement of forbidden) await assert.rejects(statement.execute(runtime), { code: "42501" });
    assert.equal((await sql`SELECT has_schema_privilege(current_user, ${schema}, 'CREATE') AS allowed`.execute(runtime)).rows[0].allowed, false);
    assert.equal((await sql`SELECT has_database_privilege(current_user, current_database(), 'TEMPORARY') AS allowed`.execute(runtime)).rows[0].allowed, false);
  } finally {
    await runtime.destroy();
    try { if (created) await owner.schema.dropSchema(schema).cascade().execute(); }
    finally { await Promise.all([owner.destroy(), admin.destroy()]); }
  }
});
