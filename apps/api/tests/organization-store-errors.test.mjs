import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { PostgresOrganizationStore } from "../dist/infrastructure/organization-store.js";
import { OrganizationError } from "../dist/modules/organizations/types.js";
import { createApp } from "../dist/app.js";
import { loadAuthConfig } from "../dist/modules/auth/config.js";
import { newSessionToken } from "../dist/modules/auth/session.js";

// Deterministic adapter-boundary failures avoid manufacturing expensive deadlocks.
function failingStore(failure) {
  return new PostgresOrganizationStore({ transaction() { return {
    setIsolationLevel(level) { assert.equal(level, "read committed"); return this; },
    async execute() { throw failure; }
  }; } });
}
const conflicts = [
  [{ code: "23505", constraint: "memberships_organization_user_unique" }, "Membership already exists."],
  [{ code: "40001" }, "Concurrent update conflict. Retry the request."],
  [{ code: "40P01" }, "Concurrent update conflict. Retry the request."]
];
for (const [failure, message] of conflicts) {
  test(`organization store maps ${failure.code} ${failure.constraint ?? ""} to the documented conflict`, async () => {
    await assert.rejects(failingStore(failure).transaction({ userId: "actor" }, async () => {}),
      (error) => error instanceof OrganizationError && error.code === (failure.code === "23505" ? "BUSINESS_CONFLICT" : "CONCURRENT_CONFLICT") && error.message === message);
  });
}
for (const failure of [{ code: "23505", constraint: "users_email_unique" }, { code: "XX000", detail: "private database details" }, new Error("unknown failure")]) {
  test(`organization store propagates unrelated ${failure.constraint ?? failure.code ?? "unknown"} failures unchanged`, async () => {
    await assert.rejects(failingStore(failure).transaction({ userId: "actor" }, async () => {}), (error) => error === failure);
  });
}

test("HTTP preserves conflict messages and hides unrelated database failures", { timeout: 10_000 }, async () => {
  let failure;
  const config = loadAuthConfig({ NODE_ENV: "test", WEB_ORIGIN: "http://localhost:3000" });
  const actor = { id: randomUUID(), email: "actor@example.com", fullName: "Actor" };
  const store = { transaction: (context, work) => failingStore(failure).transaction(context, work) };
  const server = createApp({ authConfig: config, authStore: { async findSessionUser() { return actor; } },
    organizationStore: store, checkDatabase: async () => {} }).listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    for (const [cause, message] of [...conflicts,
      [{ code: "23505", constraint: "unrelated_unique", detail: "secret" }, undefined],
      [{ code: "XX000", detail: "secret" }, undefined]]) {
      failure = cause;
      const response = await fetch(`http://127.0.0.1:${server.address().port}/organizations/${randomUUID()}/members`, {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: `${config.cookieName}=${newSessionToken()}` },
        body: JSON.stringify({ userId: randomUUID(), role: "VIEWER" }), signal: AbortSignal.timeout(2_000)
      });
      assert.equal(response.status, message ? 409 : 503);
      assert.deepEqual(await response.json(), { error: message ?? "Service is unavailable." });
    }
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
