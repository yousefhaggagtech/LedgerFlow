import assert from "node:assert/strict";
import test from "node:test";
import { OrganizationError } from "../dist/modules/organizations/types.js";
import { organizationErrorHttp } from "../dist/presentation/organization-errors.js";
import { classifyFailure } from "../dist/presentation/request-diagnostics.js";
import { createApp } from "../dist/app.js";
import { loadAuthConfig } from "../dist/modules/auth/config.js";
import { newSessionToken } from "../dist/modules/auth/session.js";
import { createLogger } from "../dist/infrastructure/logger.js";
import { once } from "node:events";

test("organization application errors expose reasons without HTTP status policy", () => {
  const error = new OrganizationError("PERMISSION_DENIED", "Permission denied.");
  assert.equal(error.code, "PERMISSION_DENIED");
  assert.equal(error.message, "Permission denied.");
  assert.equal("status" in error, false);
});

test("presentation preserves all existing organization status/body/category mappings and quiet expected errors", async (t) => {
  const cases = [
    ["VALIDATION_FAILED", 400, "Invalid identifier.", "VALIDATION_FAILURE"],
    ["UNAUTHENTICATED", 401, "Unauthorized", "AUTHENTICATION_FAILURE"],
    ["PERMISSION_DENIED", 403, "Permission denied.", "AUTHORIZATION_FAILURE"],
    ["RESOURCE_NOT_FOUND", 404, "Organization not found.", "RESOURCE_NOT_FOUND"],
    ["BUSINESS_CONFLICT", 409, "Organization must retain at least one active Owner.", "BUSINESS_CONFLICT"],
    ["CONCURRENT_CONFLICT", 409, "Concurrent update conflict. Retry the request.", "BUSINESS_CONFLICT"]
  ];
  let failure;
  const lines = [];
  const config = loadAuthConfig({ NODE_ENV: "test", WEB_ORIGIN: "http://localhost:3000" });
  const server = createApp({ authStore: { async findSessionUser() { return { id: "actor" }; } }, authConfig: config,
    organizationStore: { async transaction() { throw failure; } }, checkDatabase: async () => {},
    logger: createLogger({ stderr: (line) => { lines.push(line); } }) }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  for (const [code, status, message, category] of cases) {
    failure = new OrganizationError(code, message);
    assert.deepEqual(organizationErrorHttp(failure), { status, message, category });
    assert.equal(classifyFailure(failure), category);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/organizations`, {
      headers: { Cookie: `${config.cookieName}=${newSessionToken()}` }, signal: AbortSignal.timeout(3_000)
    });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: message });
    assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  }
  assert.deepEqual(lines, []);
  assert.equal(organizationErrorHttp(new Error("private")), undefined);
  assert.equal(organizationErrorHttp(new OrganizationError("UNKNOWN_REASON", "private")), undefined);
  assert.equal(classifyFailure(new OrganizationError("UNKNOWN_REASON", "private")), "INTERNAL_FAILURE");
});
