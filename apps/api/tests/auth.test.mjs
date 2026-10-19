import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import * as argon2 from "argon2";
import { createApp } from "../dist/app.js";
import { loadAuthConfig, SESSION_TTL_MS } from "../dist/modules/auth/config.js";
import { authenticate } from "../dist/modules/auth/session.js";

const password = "test-password-with-spaces  ";
const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
const config = loadAuthConfig({ NODE_ENV: "test", WEB_ORIGIN: "http://localhost:3000" });

class MemoryAuthStore {
  sessions = new Map();
  user = { id: randomUUID(), email: "auth@example.com", fullName: "Test User", passwordHash, status: "ACTIVE" };
  async findUserByEmail(email) { return email === this.user.email ? this.user : undefined; }
  async createSession(session, previous) {
    if (previous) await this.deleteSession(previous);
    this.sessions.set(session.id, session);
  }
  async findSessionUser(key, now) {
    const session = this.sessions.get(key.id);
    if (!session || session.tokenHash !== key.tokenHash || session.expiresAt <= now || this.user.status !== "ACTIVE") return;
    return { id: this.user.id, email: this.user.email, fullName: this.user.fullName };
  }
  async deleteSession(key) {
    if (this.sessions.get(key.id)?.tokenHash === key.tokenHash) this.sessions.delete(key.id);
  }
  async deleteExpiredSessions(now) {
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
  }
}

async function fixture(t, authConfig = config) {
  const store = new MemoryAuthStore();
  let clock = new Date();
  const now = () => new Date(clock);
  const app = createApp({ authStore: store, authConfig, checkDatabase: async () => {}, now });
  app.get("/protected", authenticate(store, authConfig, now), (request, response) => {
    response.json({ userId: request.userId, user: request.user });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(`${url}${path}`, options);
  const login = (body = { email: store.user.email, password }, cookie) => request("/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
  return { store, request, login, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}
const cookieFrom = (response) => response.headers.get("set-cookie")?.split(";")[0];

test("login creates a hashed server-side session and middleware attaches safe user context", async (t) => {
  const { store, request, login } = await fixture(t);
  assert.equal((await request("/protected")).status, 401);
  const response = await login();
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=86400/);
  assert.doesNotMatch(cookie, /Secure|Domain=/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body.user).sort(), ["email", "fullName", "id"]);
  const row = [...store.sessions.values()][0];
  assert.equal(row.userId, store.user.id);
  assert.match(row.tokenHash, /^[0-9a-f]{64}$/);
  assert.ok(!cookie.includes(row.tokenHash));
  assert.equal(row.expiresAt - row.createdAt, SESSION_TTL_MS);
  const identified = await request("/protected", { headers: { Cookie: cookieFrom(response) } });
  assert.deepEqual(await identified.json(), { userId: store.user.id, user: body.user });
  assert.equal((await request("/auth/me", { headers: { Cookie: cookieFrom(response) } })).status, 200);
});

test("production cookies are Secure, host-only, and use the __Host prefix", async (t) => {
  const production = loadAuthConfig({ NODE_ENV: "production", WEB_ORIGIN: "https://app.example.com" });
  const { login, request } = await fixture(t, production);
  const response = await login();
  assert.match(response.headers.get("set-cookie"), /^__Host-ledgerflow_session=/);
  assert.match(response.headers.get("set-cookie"), /; Secure/);
  assert.ok((await request("/health")).headers.has("strict-transport-security"));
});

test("unknown, wrong-password, inactive, and unusable seed credentials have the same failure", async (t) => {
  const { store, login } = await fixture(t);
  for (const input of [
    { email: store.user.email, password: "wrong" },
    { email: "unknown@example.com", password },
    { email: "AUTH@example.com", password }
  ]) {
    const response = await login(input);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Invalid email or password" });
    assert.equal(response.headers.get("set-cookie"), null);
  }
  store.user.status = "INACTIVE";
  assert.equal((await login()).status, 401);
  store.user.status = "ACTIVE";
  store.user.passwordHash = "!";
  assert.equal((await login()).status, 401);
  store.user.passwordHash = "$argon2id$malformed";
  assert.equal((await login()).status, 401);
  assert.equal(store.sessions.size, 0);
});

test("rotating login and repeated logout revoke old credentials and clear matching cookie attributes", async (t) => {
  const { login, request, store } = await fixture(t);
  const first = cookieFrom(await login());
  const second = cookieFrom(await login(undefined, first));
  assert.notEqual(first, second);
  assert.equal(store.sessions.size, 1);
  assert.equal((await request("/auth/me", { headers: { Cookie: first } })).status, 401);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request("/auth/logout", { method: "POST",
      headers: { "Content-Type": "application/json", Cookie: second } });
    assert.equal(response.status, 204);
    assert.match(response.headers.get("set-cookie"), /Expires=Thu, 01 Jan 1970/);
    assert.match(response.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  }
  assert.equal(store.sessions.size, 0);
  assert.equal((await request("/auth/me", { headers: { Cookie: second } })).status, 401);
});

test("expiry is enforced at exactly 24 hours without waiting for cleanup", async (t) => {
  const { login, request, advance, store } = await fixture(t);
  const cookie = cookieFrom(await login());
  advance(SESSION_TTL_MS - 1);
  assert.equal((await request("/auth/me", { headers: { Cookie: cookie } })).status, 200);
  advance(1);
  assert.equal((await request("/auth/me", { headers: { Cookie: cookie } })).status, 401);
  assert.equal(store.sessions.size, 1);
});

test("forged, missing, malformed, and JSON cookies cannot authenticate or revoke someone else's session", async (t) => {
  const { login, request, store } = await fixture(t);
  const cookie = cookieFrom(await login());
  const row = [...store.sessions.values()][0];
  for (const invalid of ["", "ledgerflow_session=invalid", `ledgerflow_session=${row.id}`,
    `ledgerflow_session=${row.id}.${"0".repeat(64)}`, 'ledgerflow_session=j:%7B%22id%22%3A1%7D']) {
    assert.equal((await request("/auth/me", { headers: { Cookie: invalid } })).status, 401);
    assert.equal((await request("/auth/logout", { method: "POST",
      headers: { "Content-Type": "application/json", Cookie: invalid } })).status, 204);
  }
  assert.equal((await request("/auth/me", { headers: { Cookie: cookie } })).status, 200);
  store.user.status = "INACTIVE";
  assert.equal((await request("/auth/me", { headers: { Cookie: cookie } })).status, 401);
});

test("credentialed CORS permits the web origin and rejects cross-site mutations and simple form posts", async (t) => {
  const { request } = await fixture(t);
  const preflight = await request("/auth/login", { method: "OPTIONS", headers: {
    Origin: config.webOrigin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), config.webOrigin);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), "true");
  const evilPreflight = await request("/auth/login", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
  assert.equal(evilPreflight.headers.get("access-control-allow-origin"), null);
  for (const path of ["/auth/login", "/auth/logout"]) {
    assert.equal((await request(path, { method: "POST", headers: {
      Origin: "http://evil.localhost:3000", "Content-Type": "application/json"
    } })).status, 403);
    assert.equal((await request(path, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await request(path, { method: "POST", headers: {
      "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site"
    } })).status, 403);
  }
});

test("invalid input and oversized JSON are bounded without leaking internals", async (t) => {
  const { login, request } = await fixture(t);
  for (const body of [null, {}, [], { email: { $ne: "" }, password },
    { email: "bad", password }, { email: "auth@example.com", password: "" },
    { email: "auth@example.com", password: "x".repeat(1_025) }]) {
    assert.equal((await login(body)).status, 400);
  }
  const malformed = await request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Invalid JSON body." });
  const large = await request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "x".repeat(9_000) }) });
  assert.equal(large.status, 413);
});

test("login attempts are rate-limited", async (t) => {
  const { login } = await fixture(t);
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await login({})).status, 400);
  const response = await login({});
  assert.equal(response.status, 429);
  assert.ok(response.headers.has("retry-after"));
});

test("store outages fail closed and do not report successful login or logout", async (t) => {
  const { store, login, request } = await fixture(t);
  const cookie = cookieFrom(await login());
  const unavailable = async () => { throw new Error("private database connection details"); };
  store.createSession = unavailable;
  store.findSessionUser = unavailable;
  store.deleteSession = unavailable;
  for (const response of [await login(), await request("/auth/me", { headers: { Cookie: cookie } }),
    await request("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie } })]) {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await response.json(), { error: "Service is unavailable." });
  }
});

test("auth configuration rejects unsafe and missing origins", () => {
  for (const env of [{}, { WEB_ORIGIN: "*" }, { WEB_ORIGIN: "http://localhost:3000/" },
    { WEB_ORIGIN: "https://user:password@example.com" }, { WEB_ORIGIN: "https://app.example/path" },
    { NODE_ENV: "production", WEB_ORIGIN: "http://localhost:3000" },
    { NODE_ENV: "prod", WEB_ORIGIN: "https://app.example" }]) assert.throws(() => loadAuthConfig(env));
});
