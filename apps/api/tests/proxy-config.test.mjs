import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { loadAuthConfig } from "../dist/modules/auth/config.js";
import { loadTrustProxy } from "../dist/presentation/proxy-config.js";

test("proxy trust defaults off and accepts only bounded hops or concrete CIDRs", () => {
  assert.equal(loadTrustProxy({}), false);
  assert.equal(loadTrustProxy({ TRUST_PROXY: "" }), false);
  assert.equal(loadTrustProxy({ TRUST_PROXY: "0" }), false);
  assert.equal(loadTrustProxy({ TRUST_PROXY: "2" }), 2);
  assert.deepEqual(loadTrustProxy({ TRUST_PROXY: "127.0.0.1/32, ::1/128" }), ["127.0.0.1/32", "::1/128"]);
  for (const value of ["true", "*", "all", "17", "-1", "1.5", "01", "Infinity", "loopback", "0.0.0.0/0", "::/0",
    "192.0.2.1/33", "::1/129", "127.0.0.1", "127.0.0.1/32,", "127.0.0.1/32/1"]) {
    assert.throws(() => loadTrustProxy({ TRUST_PROXY: value }), /TRUST_PROXY/);
  }
  const app = createApp({ authStore: {}, authConfig: loadAuthConfig({ WEB_ORIGIN: "http://localhost:3000" }), checkDatabase: async () => {} });
  assert.equal(app.get("trust proxy"), false);
});

test("invalid proxy trust fails the real API entrypoint before database startup", () => {
  const result = spawnSync(process.execPath, ["dist/index.js"], { cwd: new URL("../", import.meta.url), encoding: "utf8",
    env: { ...process.env, API_PORT: "4000", API_HOST: "127.0.0.1", WEB_ORIGIN: "http://localhost:3000", NODE_ENV: "test",
      TRUST_PROXY: "true", DATABASE_URL: "invalid" } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TRUST_PROXY must be/);
  assert.doesNotMatch(result.stderr, /DATABASE_URL must be/);
});
