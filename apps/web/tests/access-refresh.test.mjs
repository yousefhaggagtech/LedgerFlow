import "./source-loader.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const { createAccessRefresh } = await import("../src/lib/access-refresh.ts");
const { ApiError } = await import("../src/lib/api.ts");
const { isAccessHints, canEditMember } = await import("../src/lib/identity.ts");
const { AddMemberDrawer } = await import("../src/components/organizations/add-member-drawer.tsx");

const userId = "10000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000001";
const access = { id: organizationId, name: "Test", membership: { userId, organizationId, role: "ADMIN", status: "ACTIVE" }, capabilities: ["member:invite", "member:edit"] };
const target = { ...access.membership, userId: "30000000-0000-4000-8000-000000000001", role: "VIEWER" };

test("a mutation denial refreshes once, removes revoked hints and does not replay the mutation", async () => {
  let selected;
  const calls = [];
  const denied = new ApiError(403, "Permission denied.");
  const controller = createAccessRefresh(async (path, guard, init) => {
    calls.push([path, init?.method ?? "GET"]);
    if (init?.method === "PATCH") throw denied;
    const result = { membership: access.membership, capabilities: [] };
    assert.ok(guard(result));
    return result;
  }, (next) => { selected = next; }, () => assert.fail("Not an authentication failure."));
  controller.select(access);
  assert.equal(canEditMember(selected, target), true);
  await assert.rejects(controller.request(`/organizations/${organizationId}/members/${target.userId}`, () => true, { method: "PATCH" }), denied);
  assert.deepEqual(calls.map((call) => call[1]), ["PATCH", "GET"]);
  assert.equal(calls[1][0], `/organizations/${organizationId}/access`);
  assert.equal(canEditMember(selected, target), false);
  const drawer = renderToStaticMarkup(createElement(AddMemberDrawer, { access: selected, disabled: false, onAdd: async () => {} }));
  assert.doesNotMatch(drawer, /Add member/);
});

test("explicit refresh makes newly granted actions visible without polling", async () => {
  let selected;
  let calls = 0;
  const controller = createAccessRefresh(async (_path, guard) => { calls++; const result = { membership: access.membership, capabilities: access.capabilities }; assert.ok(guard(result)); return result; },
    (next) => { selected = next; }, () => {});
  controller.select({ ...access, capabilities: [] });
  await controller.refresh();
  assert.equal(calls, 1);
  assert.equal(canEditMember(selected, target), true);
  assert.match(renderToStaticMarkup(createElement(AddMemberDrawer, { access: selected, disabled: false, onAdd: async () => {} })), /Add member/);
});

test("older selection and refresh replies cannot restore stale access", async () => {
  let selected;
  const pending = [];
  const controller = createAccessRefresh(() => { const request = Promise.withResolvers(); pending.push(request); return request.promise; }, (next) => { selected = next; }, () => {});
  controller.select(access);
  const old = controller.refresh();
  const other = { ...access, id: target.userId, membership: { ...access.membership, organizationId: target.userId } };
  controller.select(other);
  pending[0].resolve({ membership: access.membership, capabilities: [] });
  await old;
  assert.equal(selected.id, other.id);
  controller.select(access);
  const first = controller.refresh();
  const second = controller.refresh();
  pending[2].resolve({ membership: access.membership, capabilities: [] });
  await second;
  pending[1].resolve({ membership: access.membership, capabilities: access.capabilities });
  await first;
  assert.deepEqual(selected.capabilities, []);
});

test("failed/foreign refresh clears stale hints, GET denials do not loop, and 401 clears identity", async () => {
  let selected;
  let unauthenticated = 0;
  let calls = 0;
  let failure = new ApiError(403, "Permission denied.");
  const controller = createAccessRefresh(async () => { calls++; throw failure; }, (next) => { selected = next; }, () => { unauthenticated++; });
  controller.select(access);
  await assert.rejects(controller.request("/organizations", () => true), failure);
  assert.equal(calls, 1);
  assert.equal(selected, access);
  await assert.rejects(controller.request("/organizations", () => true, { method: "POST" }), failure);
  assert.equal(calls, 3);
  assert.equal(selected, null);
  controller.select(access); failure = new ApiError(401, "Unauthorized");
  await assert.rejects(controller.refresh(), failure);
  assert.equal(unauthenticated, 1);
  assert.equal(selected, null);
  const foreign = createAccessRefresh(async () => ({ membership: { ...access.membership, userId: target.userId }, capabilities: [] }), (next) => { selected = next; }, () => {});
  foreign.select(access);
  await assert.rejects(foreign.refresh(), { status: 502 });
  assert.equal(selected, null);
  assert.equal(isAccessHints({ membership: access.membership, capabilities: [42] }), false);
});
