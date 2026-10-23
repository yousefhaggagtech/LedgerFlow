import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { loadAuthConfig } from "../dist/modules/auth/config.js";
import { newSessionToken } from "../dist/modules/auth/session.js";
import { OrganizationError } from "../dist/modules/organizations/types.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const config = loadAuthConfig({ NODE_ENV: "test", WEB_ORIGIN: "http://localhost:3000" });
async function fixture(t, dependencies = {}) {
  const app = createApp({ authConfig: config, checkDatabase: async () => {},
    authStore: { async findSessionUser() {}, async findUserByEmail() {} }, ...dependencies });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { signal: AbortSignal.timeout(3_000), ...options });
}

test("canonical server IDs cover successful, auth, unmatched, CORS, and early rejection responses", async (t) => {
  const request = await fixture(t);
  const seen = new Set();
  for (const [path, options, status] of [
    ["/health", {}, 200], ["/auth/me", {}, 401],
    ["/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, 400],
    ["/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" } }, 204],
    ["/unknown/private?secret=value", {}, 404],
    ["/auth/login", { method: "OPTIONS", headers: { Origin: config.webOrigin, "Access-Control-Request-Method": "POST" } }, 204],
    ["/auth/me", { headers: { Origin: "https://evil.example" } }, 403],
    ["/auth/login", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "secret" }, 415],
    ["/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }, 400],
    ["/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret: "x".repeat(9_000) }) }, 413]
  ]) {
    const spoofed = randomUUID();
    const response = await request(path, { ...options, headers: { ...options.headers, "X-Request-Id": spoofed } });
    assert.equal(response.status, status, path);
    const id = response.headers.get("x-request-id");
    assert.match(id ?? "", uuid, path);
    assert.notEqual(id, spoofed);
    assert.ok(!seen.has(id));
    seen.add(id);
    if (options.headers?.Origin === config.webOrigin) assert.match(response.headers.get("access-control-expose-headers") ?? "", /X-Request-Id/i);
    await response.arrayBuffer();
  }
});

test("concurrent requests have separate server-generated correlation IDs", async (t) => {
  const request = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 20 }, () => request("/health", { headers: { "X-Request-Id": "attacker" } })));
  const ids = responses.map((response) => response.headers.get("x-request-id"));
  ids.forEach((id) => assert.match(id ?? "", uuid));
  assert.equal(new Set(ids).size, responses.length);
  await Promise.all(responses.map((response) => response.arrayBuffer()));
});

test("unmatched routes return the JSON error contract with a server request ID", async (t) => {
  const request = await fixture(t);
  for (const path of ["/does-not-exist?secret=private", "/auth/unknown"]) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    assert.deepEqual(await response.json(), { error: "Route not found." });
    assert.match(response.headers.get("x-request-id"), uuid);
  }
});

test("expected organization errors keep their status/body and correlation", async (t) => {
  const request = await fixture(t, { authStore: { async findSessionUser() { return { id: randomUUID() }; } },
    organizationStore: { async transaction() { throw new OrganizationError("RESOURCE_NOT_FOUND", "Organization not found."); } } });
  const response = await request(`/organizations/${randomUUID()}`, { headers: { Cookie: `${config.cookieName}=${newSessionToken()}` } });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Organization not found." });
  assert.match(response.headers.get("x-request-id") ?? "", uuid);
});

test("unexpected auth failure emits one correlated JSON event through stderr", async (t) => {
  const lines = [];
  t.mock.method(process.stderr, "write", (line, ...args) => { lines.push(String(line)); args.find((arg) => typeof arg === "function")?.(); return true; });
  const request = await fixture(t, { authStore: { async findSessionUser() { throw new Error("sensitive failure marker"); } } });
  const response = await request("/auth/me", { headers: { Cookie: `${config.cookieName}=${newSessionToken()}` } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Service is unavailable." });
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.requestId, response.headers.get("x-request-id"));
  assert.equal(event.event, "api_request_failed");
  assert.equal(event.route, "/auth/me");
  assert.equal(event.method, "GET");
  assert.equal(event.statusCode, 503);
  assert.equal(event.errorCategory, "INTERNAL_FAILURE");
  assert.equal(event.level, "error");
  assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
  assert.ok(!lines.join("").includes("sensitive failure marker"));
});
