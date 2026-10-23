import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { startIdempotencyCleanup, IDEMPOTENCY_CLEANUP_INTERVAL_MS } from "../dist/infrastructure/idempotency-cleanup.js";
import { createLogger } from "../dist/infrastructure/logger.js";
import { OrganizationService } from "../dist/modules/organizations/service.js";

const yieldTurn = () => new Promise(setImmediate);
function timer(t) {
  let run;
  const handle = { unref() {} };
  t.mock.method(globalThis, "setInterval", (callback, delay) => { assert.equal(delay, IDEMPOTENCY_CLEANUP_INTERVAL_MS); run = callback; return handle; });
  t.mock.method(globalThis, "clearInterval", (value) => { assert.equal(value, handle); });
  return () => run();
}

test("cleanup starts immediately, avoids overlap and waits for pending work on shutdown", async (t) => {
  const tick = timer(t);
  const work = Promise.withResolvers();
  let calls = 0;
  const stop = startIdempotencyCleanup(async (now) => { calls++; assert.ok(now instanceof Date); await work.promise; });
  await yieldTurn();
  tick(); tick();
  assert.equal(calls, 1);
  let stopped = false;
  const pending = stop().then(() => { stopped = true; });
  await yieldTurn();
  assert.equal(stopped, false);
  work.resolve();
  await pending;
  assert.equal(stopped, true);
});

test("cleanup failures are sanitized and retry on the next interval", async (t) => {
  const tick = timer(t);
  const lines = [];
  let calls = 0;
  const stop = startIdempotencyCleanup(async () => { if (++calls === 1) throw new Error("private cleanup details"); },
    createLogger({ stderr: (line) => lines.push(line) }));
  await yieldTurn();
  assert.equal(JSON.parse(lines[0]).event, "idempotency_cleanup_failed");
  assert.ok(!lines.join("").includes("private cleanup details"));
  tick();
  await stop();
  assert.equal(calls, 2);
});

test("EXPIRED tombstones reject replay before touching a null response or tenant repository", async () => {
  const input = { name: "Test", baseCurrency: "EGP", accountingTimezone: "Africa/Cairo" };
  const service = new OrganizationService({ async transaction(_context, work) { return work({
    async lockCreator() { return true; },
    async findCreation() { return { status: "EXPIRED", response: null, expiresAt: new Date("2030-01-01"),
      requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex") }; },
    async forOrganization() { assert.fail("Expired replay must not load a tenant."); }
  }); } });
  await assert.rejects(service.create({ userId: "user", correlationId: "request" }, input, "key"), {
    code: "BUSINESS_CONFLICT", message: "Idempotency key has expired. Check the existing organization before retrying."
  });
});
