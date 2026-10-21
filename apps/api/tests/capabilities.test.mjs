import assert from "node:assert/strict";
import test from "node:test";
import { RequestCapabilityResolver, requireCapability } from "../dist/modules/organizations/capabilities.js";
import { requireAssignment } from "../dist/modules/organizations/policy.js";

const member = { id: "membership", userId: "user", organizationId: "organization", role: "VIEWER", status: "ACTIVE" };

test("resolver shares concurrent/repeated lookups and returns an immutable request snapshot", async () => {
  let calls = 0;
  const granted = ["org:read", "member:read"];
  const resolver = new RequestCapabilityResolver({ async findAuthorization() {
    calls++;
    return { ...member, capabilities: granted };
  } });
  const [first, second] = await Promise.all([resolver.resolve("organization", "user"), resolver.resolve("organization", "user")]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  requireCapability("org:read", first);
  requireCapability("member:read", second);
  granted.length = 0;
  assert.deepEqual(first.capabilities, ["org:read", "member:read"]);
  assert.throws(() => first.capabilities.push("member:edit"), TypeError);
  assert.throws(() => { first.role = "OWNER"; }, TypeError);
  assert.equal(await resolver.resolve("organization", "user"), first);
  assert.equal(calls, 1);
});

test("cache keys include both organization and user; a new request reloads grants", async () => {
  const calls = [];
  const source = { async findAuthorization(organizationId, userId) {
    calls.push([organizationId, userId]);
    return { ...member, organizationId, userId, capabilities: [] };
  } };
  const resolver = new RequestCapabilityResolver(source);
  await resolver.resolve("a", "user");
  await resolver.resolve("b", "user");
  await resolver.resolve("a", "other");
  await new RequestCapabilityResolver(source).resolve("a", "user");
  assert.deepEqual(calls, [["a", "user"], ["b", "user"], ["a", "other"], ["a", "user"]]);
});

test("explicit invalidation reloads permissions after the organization lock", async () => {
  let capabilities = ["member:invite"];
  const resolver = new RequestCapabilityResolver({ async findAuthorization() { return { ...member, capabilities }; } });
  const first = await resolver.resolve("organization", "user");
  capabilities = [];
  requireCapability("member:invite", await resolver.resolve("organization", "user"));
  resolver.invalidate("organization", "user");
  const refreshed = await resolver.resolve("organization", "user");
  assert.notEqual(first, refreshed);
  assert.throws(() => requireCapability("member:invite", refreshed), { code: "PERMISSION_DENIED" });
});

test("missing/inactive memberships and absent grants fail closed; grants work regardless of role name", async () => {
  const resolver = new RequestCapabilityResolver({ async findAuthorization() { return undefined; } });
  assert.throws(() => requireCapability("org:read", undefined), { code: "RESOURCE_NOT_FOUND" });
  assert.throws(() => requireCapability("org:read", { ...member, status: "INACTIVE", capabilities: ["org:read"] }), { code: "RESOURCE_NOT_FOUND" });
  assert.throws(() => requireCapability("org:read", { ...member, role: "OWNER", capabilities: [] }), { code: "PERMISSION_DENIED" });
  requireCapability("org:read", { ...member, capabilities: ["org:read"] });
  assert.equal(await resolver.resolve("organization", "user"), undefined);
});

test("database failures propagate and never become a permission grant", async () => {
  const failure = new Error("lookup failed");
  const resolver = new RequestCapabilityResolver({ async findAuthorization() { throw failure; } });
  await assert.rejects(resolver.resolve("organization", "user"), failure);
  await assert.rejects(resolver.resolve("organization", "user"), failure);
});

test("authorization rejects a source returning another tenant or user's membership", async () => {
  for (const override of [{ organizationId: "other" }, { userId: "other" }]) {
    const resolver = new RequestCapabilityResolver({ async findAuthorization() {
      return { ...member, ...override, capabilities: ["org:read"] };
    } });
    await assert.rejects(resolver.resolve("organization", "user"), /invalid scope/);
  }
});

test("capability grants do not override structural Option A assignment limits", () => {
  const administrator = { ...member, role: "ADMIN", capabilities: ["member:invite", "member:edit"] };
  requireAssignment(administrator, "VIEWER");
  assert.throws(() => requireAssignment(administrator, "OWNER"), { code: "PERMISSION_DENIED" });
  assert.throws(() => requireAssignment(administrator, "ADMIN"), { code: "PERMISSION_DENIED" });
  for (const role of ["OWNER", "ADMIN"]) {
    assert.throws(() => requireAssignment(administrator, "VIEWER", { ...member, userId: "target", role }), { code: "PERMISSION_DENIED" });
  }
  assert.throws(() => requireAssignment(member, "VIEWER"), { code: "PERMISSION_DENIED" });
});
