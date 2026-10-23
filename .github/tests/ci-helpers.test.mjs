import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fixtureTargets } from "../scripts/ci-database.mjs";
import { createRedactor } from "../scripts/log-safety.mjs";
import { captureCommand, GATES } from "../scripts/run-gate.mjs";
import { qualitySummary } from "../scripts/summary.mjs";
import { createCiEnvironment } from "../scripts/create-ci-env.mjs";
import { parseEnv } from "node:util";

const env = { CI: "true", GITHUB_ACTIONS: "true", CI_DB_SERVER_ADDRESS: "172.18.0.2", CI_POSTGRES_PORT: "5432",
  DATABASE_URL: "postgresql://invalid:invalid@127.0.0.1:1/never_use_parent",
  TEST_DATABASE_URL: "postgresql://ci_test:CI_TEST_ONLY@127.0.0.1:5432/ledgerflow_ci",
  TEST_MIGRATOR_DATABASE_URL: "postgresql://ci_migrator:CI_OWNER_ONLY@127.0.0.1:5432/ledgerflow_ci",
  TEST_RUNTIME_DATABASE_URL: "postgresql://ci_runtime:CI_RUNTIME_ONLY@127.0.0.1:5432/ledgerflow_ci" };

test("database safety rejects wrong targets, roles, parameters and implicit runtime fallback before connecting", () => {
  assert.equal(fixtureTargets(env).port, 5432);
  for (const change of [
    { CI: "false" }, { GITHUB_ACTIONS: "false" }, { CI_DB_SERVER_ADDRESS: "" }, { CI_POSTGRES_PORT: "bad" },
    { DATABASE_URL: env.TEST_DATABASE_URL }, { MIGRATIONS_DATABASE_URL: env.TEST_DATABASE_URL },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace("127.0.0.1", "production.example") },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace("ledgerflow_ci", "development") },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace("ci_test:", "ci_bootstrap:") },
    { TEST_DATABASE_URL: `${env.TEST_DATABASE_URL}?options=unsafe` }, { TEST_DATABASE_URL: "" }
  ]) assert.throws(() => fixtureTargets({ ...env, ...change }));
});

test("CI build environment supplies required safe origins, never a database fallback or an overwritten file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ledgerflow-ci-env-test-"));
  const path = join(root, ".env");
  try {
    await assert.rejects(createCiEnvironment(path, {}), /explicit CI context/);
    await createCiEnvironment(path, { CI: "true", GITHUB_ACTIONS: "true" });
    const original = await readFile(path, "utf8");
    const values = parseEnv(original);
    assert.deepEqual(Object.keys(values).sort(), ["API_URL", "NEXT_PUBLIC_API_URL"]);
    for (const value of Object.values(values)) {
      const url = new URL(value);
      assert.equal(url.origin, "http://127.0.0.1:1");
      assert.equal(url.username, ""); assert.equal(url.password, "");
    }
    await assert.rejects(createCiEnvironment(path, { CI: "true", GITHUB_ACTIONS: "true" }), { code: "EEXIST" });
    assert.equal(await readFile(path, "utf8"), original);
  } finally { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true }); }
});

test("logs scrub configured and derived URLs/passwords, including separate stream chunks", async () => {
  const redactor = createRedactor({ ...env, OTHER_PASSWORD: "SECRET_LOG_MARKER" });
  const output = redactor(`${env.TEST_DATABASE_URL}?options=scope CI_TEST_ONLY SECRET_LOG_MARKER postgresql://other:unknown@host/db`);
  assert.doesNotMatch(output, /postgresql:\/\/|CI_TEST_ONLY|SECRET_LOG_MARKER|unknown@/);
  const root = await mkdtemp(join(tmpdir(), "ledgerflow-ci-log-test-"));
  try {
    const log = join(root, "failure.log");
    const code = await captureCommand(process.execPath, ["-e", "process.stdout.write(process.env.TEST_DATABASE_URL.slice(0, 10)); setImmediate(() => { process.stdout.write(process.env.TEST_DATABASE_URL.slice(10) + '\\n'); process.stderr.write('failing-test-name\\n'); process.exitCode = 7; });"], log, { ...process.env, ...env });
    assert.equal(code, 7);
    const content = await readFile(log, "utf8");
    assert.doesNotMatch(content, /postgresql:\/\/|CI_TEST_ONLY/);
    assert.match(content, /failing-test-name/);
    assert.match(content, /exit status: 7/);
  } finally { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true }); }
});

test("gate mapping uses actual scripts and summaries never convert failure/skips to pass", async () => {
  const root = JSON.parse(await readFile("package.json", "utf8"));
  const manifests = {};
  for (const path of ["apps/api", "apps/web", "packages/db"]) {
    const manifest = JSON.parse(await readFile(`${path}/package.json`, "utf8")); manifests[manifest.name] = manifest;
  }
  assert.deepEqual(GATES.install, ["ci"]);
  for (const args of Object.values(GATES).filter((args) => args[0] === "run")) {
    const workspace = args.find((arg) => arg.startsWith("--workspace="))?.slice("--workspace=".length);
    assert.ok((workspace ? manifests[workspace] : root).scripts[args[1]], args.join(" "));
  }
  const summary = qualitySummary({ GATE_BUILD: "success", GATE_DB: "failure", GATE_INTEGRATION: "skipped" });
  assert.match(summary, /DB Integration \| FAIL/);
  assert.match(summary, /API Integration \| NOT EXECUTED/);
  assert.match(summary, /Node NOT VERIFIED/);
});
