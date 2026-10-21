import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { setImmediate as yieldTurn } from "node:timers/promises";
import test from "node:test";
import express from "express";
import * as argon2 from "argon2";
import { createApp } from "../dist/app.js";
import { createLogger, ERROR_CATEGORIES, SAFE_ROUTES } from "../dist/infrastructure/logger.js";
import { classifyFailure, correlateRequest, createErrorHandler } from "../dist/presentation/request-diagnostics.js";
import { OrganizationError } from "../dist/modules/organizations/types.js";
import { loadAuthConfig } from "../dist/modules/auth/config.js";
import { newSessionToken } from "../dist/modules/auth/session.js";
import { startSessionCleanup } from "../dist/infrastructure/session-cleanup.js";

const config = loadAuthConfig({ NODE_ENV: "test", WEB_ORIGIN: "http://localhost:3000" });
const fixedTime = new Date("2026-10-21T12:34:56.000Z");
const password = "OBS_PASSWORD_MARKER";
const hash = await argon2.hash(password, { type: argon2.argon2id });
const user = { id: randomUUID(), email: "OBS_EMAIL_MARKER@example.com", fullName: "OBS_NAME_MARKER", status: "ACTIVE", passwordHash: hash };
const cookie = `${config.cookieName}=${newSessionToken()}`;
const secrets = [password, hash, cookie, "OBS_BEARER_MARKER", user.email, user.fullName, user.id,
  "OBS_KEY_MARKER", "OBS_BODY_MARKER", "OBS_SQL_MARKER", "OBS_DB_PASSWORD_MARKER", "OBS_PATH_MARKER", "OBS_QUERY_MARKER", "OBS_ERROR_MARKER"];
const headers = { "Content-Type": "application/json", Cookie: cookie, Authorization: "Bearer OBS_BEARER_MARKER",
  "Idempotency-Key": "OBS_KEY_MARKER", "X-Request-Id": "OBS_SPOOF_MARKER" };
const organizationReasons = { 400: "VALIDATION_FAILED", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED",
  404: "RESOURCE_NOT_FOUND", 409: "BUSINESS_CONFLICT" };

function capture() {
  const lines = [];
  return { lines, logger: createLogger({ stderr: (line) => { lines.push(line); }, now: () => fixedTime }) };
}
async function listen(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { signal: AbortSignal.timeout(3_000), ...options });
}
async function fixture(t, overrides = {}) {
  const output = capture();
  const store = { async findUserByEmail() { return user; }, async createSession() {},
    async findSessionUser() { return user; }, async deleteSession() {} };
  const app = createApp({ authConfig: config, authStore: store, checkDatabase: async () => {}, logger: output.logger,
    organizationStore: { async transaction() { throw new Error("Unused store"); } }, ...overrides });
  return { ...output, store, request: await listen(t, app) };
}
function eventFor(lines, response, route, category, method = "POST", event = "api_request_failed") {
  assert.equal(lines.length, 1, "One event per failure");
  assert.ok(lines[0].endsWith("\n"));
  const record = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(record).sort(), ["timestamp", "level", "event", "requestId", "method", "route", "statusCode", "errorCategory"].sort());
  assert.equal(record.timestamp, fixedTime.toISOString());
  assert.equal(record.level, event === "password_hash_verification_failed" ? "warn" : "error");
  assert.equal(record.event, event);
  assert.equal(record.requestId, response.headers.get("x-request-id"));
  assert.match(record.requestId, /^[0-9a-f-]{36}$/);
  assert.notEqual(record.requestId, headers["X-Request-Id"]);
  assert.equal(record.method, method);
  assert.equal(record.route, route);
  assert.equal(record.statusCode, response.status);
  assert.equal(record.errorCategory, category);
  assert.ok(ERROR_CATEGORIES.includes(record.errorCategory));
  assert.ok(SAFE_ROUTES.includes(record.route));
  for (const secret of [...secrets, headers["X-Request-Id"]]) assert.ok(!lines.join("").includes(secret), secret);
  return record;
}
function privateError(code) {
  const error = Object.assign(new Error("OBS_ERROR_MARKER"), {
    code, detail: "OBS_BODY_MARKER", query: "SELECT OBS_SQL_MARKER", parameters: secrets,
    connectionString: "postgresql://private:OBS_DB_PASSWORD_MARKER@invalid/secret", toJSON() { throw new Error("Must not serialize exceptions"); }
  });
  error.cause = error;
  return error;
}

test("classification adapts existing business/parser contracts and explicit SQLSTATE codes", () => {
  for (const [status, category] of [[400, "VALIDATION_FAILURE"], [401, "AUTHENTICATION_FAILURE"], [403, "AUTHORIZATION_FAILURE"],
    [404, "RESOURCE_NOT_FOUND"], [409, "BUSINESS_CONFLICT"]]) {
    assert.equal(classifyFailure(new OrganizationError(organizationReasons[status], "private")), category);
  }
  for (const code of ["23514", "23505", "XX000"]) assert.equal(classifyFailure(privateError(code)), "DATABASE_FAILURE");
  for (const code of ["40001", "40P01"]) assert.equal(classifyFailure(privateError(code)), "DATABASE_CONFLICT");
  for (const error of [new Error("database message is not metadata"), { code: "ECONNRESET" }, { code: "unrecognized" }, null]) {
    assert.equal(classifyFailure(error), "INTERNAL_FAILURE");
  }
  assert.equal(classifyFailure({ status: 413 }), "VALIDATION_FAILURE");
  assert.equal(classifyFailure(Object.create({ status: 413 })), "VALIDATION_FAILURE");
  assert.equal(classifyFailure(Object.defineProperty({}, "code", { get() { throw new Error("private"); } })), "INTERNAL_FAILURE");
});

test("organization failure logs only allowlisted fields and templates, never raw errors or request secrets", async (t) => {
  const cause = privateError("23514");
  const { request, lines } = await fixture(t, { organizationStore: { async transaction() { throw cause; } } });
  for (const [method, path, body, route] of [
    ["POST", "/organizations", { name: "OBS_BODY_MARKER", baseCurrency: "EGP", accountingTimezone: "UTC" }, "/organizations"],
    ["POST", `/organizations/${randomUUID()}/members`, { userId: randomUUID(), role: "VIEWER" }, "/organizations/:id/members"],
    ["PATCH", `/organizations/${randomUUID()}/members/${randomUUID()}`, { role: "VIEWER" }, "/organizations/:id/members/:userId"]
  ]) {
    lines.length = 0;
    const response = await request(`${path}?secret=OBS_QUERY_MARKER`, { method, headers, body: JSON.stringify(body) });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Service is unavailable." });
    eventFor(lines, response, route, "DATABASE_FAILURE", method);
  }
});

test("unknown callback errors remain INTERNAL_FAILURE; concurrent failure contexts never mix", async (t) => {
  const { request, lines } = await fixture(t, { organizationStore: { async transaction() { await yieldTurn(); throw privateError("unrecognized"); } } });
  const responses = await Promise.all(Array.from({ length: 8 }, () => request(`/organizations/${randomUUID()}?q=OBS_QUERY_MARKER`, { headers })));
  assert.equal(lines.length, responses.length);
  const ids = new Set();
  for (const response of responses) {
    const selected = lines.filter((line) => JSON.parse(line).requestId === response.headers.get("x-request-id"));
    eventFor(selected, response, "/organizations/:id", "INTERNAL_FAILURE", "GET");
    assert.deepEqual(await response.json(), { error: "Service is unavailable." });
    ids.add(response.headers.get("x-request-id"));
  }
  assert.equal(ids.size, responses.length);
});

test("login lookup, session creation/rotation, logout, and authentication-store failures are correlated", async (t) => {
  for (const [operation, path, method, route] of [
    ["findUserByEmail", "/auth/login", "POST", "/auth/login"],
    ["createSession", "/auth/login", "POST", "/auth/login"],
    ["deleteSession", "/auth/logout", "POST", "/auth/logout"],
    ["findSessionUser", "/auth/me", "GET", "/auth/me"],
    ["findSessionUser", `/organizations/${randomUUID()}`, "GET", "organizations_authentication"]
  ]) {
    const { request, lines, store } = await fixture(t);
    store[operation] = async () => { throw privateError("23514"); };
    const response = await request(`${path}?q=OBS_QUERY_MARKER`, { method, headers,
      ...(method === "POST" ? { body: JSON.stringify({ email: user.email, password }) } : {}) });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Service is unavailable." });
    eventFor(lines, response, route, "DATABASE_FAILURE", method);
  }
});

test("unexpected malformed Argon2 hash reports one correlated warning and keeps generic 401", async (t) => {
  const { request, lines, store } = await fixture(t);
  store.findUserByEmail = async () => ({ ...user, passwordHash: "$argon2id$OBS_PASSWORD_HASH_MARKER" });
  const response = await request("/auth/login", { method: "POST", headers, body: JSON.stringify({ email: user.email, password }) });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid email or password" });
  eventFor(lines, response, "/auth/login", "INTERNAL_FAILURE", "POST", "password_hash_verification_failed");
  assert.ok(!lines.join("").includes("OBS_PASSWORD_HASH_MARKER"));
});

test("expected client, business, and rate-limit failures stay quiet and keep existing bodies", async (t) => {
  let failure;
  const { request, lines } = await fixture(t, { organizationStore: { async transaction() { throw failure; } } });
  for (const [status, message] of [[400, "Invalid identifier."], [401, "Unauthorized"], [403, "Permission denied."],
    [404, "Organization not found."], [409, "Organization must retain at least one active Owner."]]) {
    failure = new OrganizationError(organizationReasons[status], message);
    const response = await request(`/organizations/${randomUUID()}`, { headers });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: message });
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await request("/auth/login", { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  const limited = await request("/auth/login", { method: "POST", headers, body: "{}" });
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "Too many login attempts. Try again later." });
  assert.match(limited.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.deepEqual(lines, []);
});

test("health outage is a correlated dependency failure without changing the health contract", async (t) => {
  const { request, lines } = await fixture(t, { checkDatabase: async () => { throw privateError("unrecognized"); } });
  const response = await request("/health?secret=OBS_QUERY_MARKER", { headers });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { api: "UP", database: "DOWN", error: "Database is unavailable." });
  eventFor(lines, response, "/health", "DATABASE_FAILURE", "GET");
});

test("pre-route exceptions use unmatched without reflecting attacker paths", async (t) => {
  const { lines, logger } = capture();
  const app = express().use(correlateRequest).use(() => { throw privateError("unrecognized"); }).use(createErrorHandler(logger));
  const request = await listen(t, app);
  const response = await request("/OBS_PATH_MARKER?query=OBS_QUERY_MARKER", { headers });
  assert.deepEqual(await response.json(), { error: "Service is unavailable." });
  eventFor(lines, response, "unmatched", "INTERNAL_FAILURE", "GET");
});

test("partial-response errors close the connection with one safe event and no second response", async (t) => {
  const { lines, logger } = capture();
  const release = Promise.withResolvers();
  const app = express().use(correlateRequest);
  app.get("/partial", async (_request, response) => { response.write("prefix"); response.flushHeaders(); await release.promise; throw privateError("unrecognized"); });
  app.use(createErrorHandler(logger));
  const request = await listen(t, app);
  try {
    const response = await request("/partial", { headers });
    const body = response.text();
    release.resolve();
    await assert.rejects(body);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.headersSent, true);
    assert.equal(event.statusCode, 200);
    assert.equal(event.requestId, response.headers.get("x-request-id"));
    assert.equal(event.route, "unmatched");
    assert.ok(!lines[0].includes("OBS_ERROR_MARKER"));
  } finally { release.resolve(); }
});

test("logger reconstructs a bounded payload and ignores extra fields and unsafe identifiers", () => {
  const { lines, logger } = capture();
  logger.log({ event: "api_request_failed", requestId: "OBS_SPOOF_MARKER", method: "OBS_METHOD_MARKER", route: "/OBS_PATH_MARKER",
    statusCode: 900, errorCategory: "OBS_CATEGORY_MARKER", error: privateError("23514"), body: secrets, headers, toJSON() { throw new Error("must not call"); } });
  const record = JSON.parse(lines[0]);
  assert.equal(record.requestId, "unavailable");
  assert.equal(record.method, "OTHER");
  assert.equal(record.route, "unmatched");
  assert.equal(record.statusCode, 500);
  assert.equal(record.errorCategory, "INTERNAL_FAILURE");
  assert.ok(Buffer.byteLength(lines[0]) < 2_048);
  for (const secret of [...secrets, "OBS_SPOOF_MARKER", "OBS_METHOD_MARKER", "OBS_CATEGORY_MARKER"]) assert.ok(!lines[0].includes(secret));
  logger.log({ event: "api_request_failed", requestId: { secret: "OBS_BODY_MARKER", toString() { return randomUUID(); } },
    method: "GET", route: "/health", statusCode: 503, errorCategory: "INTERNAL_FAILURE" });
  assert.equal(JSON.parse(lines[1]).requestId, "unavailable");
  assert.ok(!lines[1].includes("OBS_BODY_MARKER"));
});

test("default logger writes info to stdout and operational failures to stderr without recursive stream errors", () => {
  // A child keeps the test runner's own output protocol untouched.
  const script = `import { logger } from ${JSON.stringify(new URL("../dist/infrastructure/logger.js", import.meta.url).href)};
    logger.log({ event: "api_started" });
    logger.log({ event: "session_cleanup_failed", errorCategory: "DATABASE_FAILURE" });
    process.stderr.emit("error", new Error("OBS_ERROR_MARKER"));
    process.stdout.emit("error", new Error("OBS_ERROR_MARKER"));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  const err = result.stderr.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(out.length, 1);
  assert.equal(out[0].level, "info");
  assert.equal(err.length, 1);
  assert.equal(err[0].level, "error");
  assert.equal(err[0].event, "session_cleanup_failed");
  assert.ok(!JSON.stringify(result).includes("OBS_ERROR_MARKER"));
});

test("serialization, clock, synchronous, and asynchronous output failures are isolated", async () => {
  const entry = { event: "session_cleanup_failed", errorCategory: "DATABASE_FAILURE" };
  for (const logger of [createLogger({ now: () => new Date(NaN) }), createLogger({ now: () => { throw privateError(); } }),
    createLogger({ stderr: () => { throw privateError(); } }), createLogger({ stderr: async () => { throw privateError(); } })]) {
    assert.doesNotThrow(() => logger.log(entry));
  }
  const { logger, lines } = capture();
  assert.doesNotThrow(() => logger.log(Object.defineProperty({}, "event", { get() { throw privateError(); } })));
  assert.deepEqual(lines, []);
  await yieldTurn();
});

test("broken diagnostic output preserves auth/health responses and cleanup completion", async (t) => {
  let outputAttempts = 0;
  const failOutput = () => { outputAttempts++; throw privateError(); };
  const logger = createLogger({ stderr: failOutput, stdout: failOutput });
  const { request, store } = await fixture(t, { logger, checkDatabase: async () => { throw privateError(); } });
  logger.log({ event: "api_started" });
  const success = await request("/auth/login", { method: "POST", headers, body: JSON.stringify({ email: user.email, password }) });
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { user: { id: user.id, email: user.email, fullName: user.fullName } });
  assert.ok(success.headers.get("set-cookie"));
  const health = await request("/health");
  assert.equal(health.status, 503);
  await health.arrayBuffer();
  store.findUserByEmail = async () => ({ ...user, passwordHash: "$argon2id$OBS_PASSWORD_HASH_MARKER" });
  const response = await request("/auth/login", { method: "POST", headers, body: JSON.stringify({ email: user.email, password }) });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid email or password" });
  const stop = startSessionCleanup({ async deleteExpiredSessions() { throw privateError(); } }, logger);
  await assert.doesNotReject(stop());
  assert.equal(outputAttempts, 4);
});
