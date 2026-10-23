import { appendFileSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const DATABASE = "ledgerflow_ci";
const MARKER = "ledgerflow-ci-disposable-only";
const PARENT = "postgresql://invalid:invalid@127.0.0.1:1/never_use_parent";
class SafetyError extends Error {}
const ensure = (condition, message) => { if (!condition) throw new SafetyError(message); };

export function fixtureTargets(env = process.env) {
  ensure(env.CI === "true" && env.GITHUB_ACTIONS === "true", "CI database checks require an explicit CI context.");
  ensure(env.DATABASE_URL === PARENT && !env.MIGRATIONS_DATABASE_URL, "The parent database must be invalid; no migration override is allowed.");
  const port = Number(env.CI_POSTGRES_PORT ?? "5432");
  ensure(Number.isInteger(port) && port > 0 && port <= 65535, "Invalid CI service port.");
  ensure(isIP(env.CI_DB_SERVER_ADDRESS ?? "") === 4, "CI service address must come from the service container inspection.");
  const targets = {};
  for (const [name, role] of [["TEST_DATABASE_URL", "ci_test"], ["TEST_MIGRATOR_DATABASE_URL", "ci_migrator"], ["TEST_RUNTIME_DATABASE_URL", "ci_runtime"]]) {
    let url;
    try { url = new URL(env[name] ?? ""); } catch { throw new SafetyError("All three isolated CI fixture URLs are required."); }
    ensure(["postgres:", "postgresql:"].includes(url.protocol) && url.hostname === "127.0.0.1" && Number(url.port) === port &&
      url.pathname === `/${DATABASE}` && decodeURIComponent(url.username) === role && url.password && !url.search && !url.hash,
    "Fixture URLs must match the loopback CI service, dedicated database and expected distinct logins.");
    targets[role] = url;
  }
  return { targets, port, address: env.CI_DB_SERVER_ADDRESS };
}

async function identity(client, expected, database, role) {
  const { rows: [row] } = await client.query(`SELECT current_setting('server_version_num')::int AS version,
    host(inet_server_addr()) AS address, inet_server_port() AS port, current_database() AS database,
    current_user AS role, session_user AS login`);
  ensure(Math.floor(row.version / 10000) === 16, "PostgreSQL major version must be 16.");
  ensure(row.address === expected.address && row.port === expected.port, "The connected server does not match the CI service.");
  ensure(row.database === database && row.role === role && row.login === role, "Unexpected CI database or login.");
  return `16.${row.version % 10000}`;
}

async function emptyFixtures(client) {
  const { rows: [counts] } = await client.query(`SELECT
    (SELECT count(*)::int FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_') AS schemas,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS relations,
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') AS functions,
    (SELECT count(*)::int FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public') AS types`);
  ensure(Object.values(counts).every((count) => count === 0), "Unexpected application objects exist in the CI target; no destructive fixture was started.");
}

export async function checkDatabase(env = process.env, provision = true) {
  const expected = fixtureTargets(env);
  if (provision) {
    ensure(Boolean(env.CI_BOOTSTRAP_PASSWORD), "CI-only bootstrap credentials are required for service provisioning.");
    const admin = new pg.Client({ host: "127.0.0.1", port: expected.port, database: "postgres", user: "ci_bootstrap", password: env.CI_BOOTSTRAP_PASSWORD, connectionTimeoutMillis: 5_000 });
    await admin.connect();
    try {
      await identity(admin, expected, "postgres", "ci_bootstrap");
      for (const [role, url] of Object.entries(expected.targets)) {
        const { rows: [ddl] } = await admin.query(`SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS statement`, [role, decodeURIComponent(url.password)]);
        await admin.query(ddl.statement);
      }
      await admin.query("CREATE DATABASE ledgerflow_ci OWNER ci_test");
      await admin.query("COMMENT ON DATABASE ledgerflow_ci IS 'ledgerflow-ci-disposable-only'");
      await admin.query("GRANT ci_migrator TO ci_test WITH INHERIT FALSE");
    } finally { await admin.end(); }
  }
  let version;
  for (const [role, url] of Object.entries(expected.targets)) {
    const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, query_timeout: 5_000, statement_timeout: 5_000 });
    await client.connect();
    try {
      version = await identity(client, expected, DATABASE, role);
      const { rows: [privileges] } = await client.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
      ensure(Object.values(privileges).every((value) => value === false), "CI fixture logins must not have administrative role privileges.");
      const { rows: memberships } = await client.query(`SELECT r.rolname, m.admin_option, m.inherit_option, m.set_option
        FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`);
      if (role === "ci_test") {
        ensure(memberships.length === 1 && memberships[0].rolname === "ci_migrator" && !memberships[0].admin_option &&
          !memberships[0].inherit_option && memberships[0].set_option, "The test login must have only non-inherited fixture-owner membership.");
        const { rows: [database] } = await client.query(`SELECT pg_get_userbyid(datdba) AS owner,
          shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = current_database()`);
        ensure(database.owner === "ci_test" && database.marker === MARKER, "The target is not the marked disposable CI database.");
        ensure((await client.query("SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS allowed")).rows[0].allowed,
          "The test login needs isolated schema creation permission.");
        await emptyFixtures(client);
      } else ensure(memberships.length === 0, "Runtime/migrator fixture logins must not assume other roles.");
    } finally { await client.end(); }
  }
  process.stdout.write(`PostgreSQL ${version}: disposable service identity, logins, privileges and empty fixture catalog verified.\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `postgres=${version}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkDatabase(process.env, process.argv[2] !== "cleanup"); }
  catch (error) {
    const code = typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? ` (${error.code})` : "";
    process.stderr.write(error instanceof SafetyError ? `${error.message}\n` : `CI database connection/provisioning check failed${code}; connection details withheld.\n`);
    process.exitCode = 1;
  }
}
