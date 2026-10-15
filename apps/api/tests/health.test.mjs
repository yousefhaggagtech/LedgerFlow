import assert from "node:assert/strict";
import test from "node:test";
import { getHealth } from "../dist/infrastructure/health.js";
import { isHealthResponse } from "@ledgerflow/shared";

test("validates health responses received across the network", () => {
  assert.equal(isHealthResponse({ api: "UP", database: "UP" }), true);
  assert.equal(isHealthResponse({ api: "UP", database: "DOWN", error: "Unavailable" }), true);
  for (const invalid of [null, {}, "ok", { api: "UP", database: "DOWN" },
    { api: "DOWN", database: "UP" }, { api: "UP", database: "DOWN", error: 42 }]) {
    assert.equal(isHealthResponse(invalid), false);
  }
});

test("reports API and database UP after a successful query", async () => {
  let called = false;
  const health = await getHealth(async () => { called = true; });
  assert.equal(called, true);
  assert.deepEqual(health, { api: "UP", database: "UP" });
});

test("reports database DOWN without leaking driver errors", async () => {
  const health = await getHealth(async () => { throw new Error("secret connection details"); });
  assert.deepEqual(health, {
    api: "UP", database: "DOWN", error: "Database is unavailable."
  });
});
