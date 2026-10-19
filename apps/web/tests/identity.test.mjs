import "./source-loader.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
process.env.NEXT_PUBLIC_API_URL = "http://api.example";
const { apiRequest, ApiError } = await import("../src/lib/api.ts");
const { assignableRoles, canEditMember, isAccess, isPage, isSession } = await import("../src/lib/identity.ts");
const { ApiAlert } = await import("../src/components/identity/api-alert.tsx");
const userId = "10000000-0000-0000-0000-000000000001";
const orgId = "20000000-0000-0000-0000-000000000001";
const access = { id: orgId, name: "Organization", membership: { userId, organizationId: orgId, role: "ADMIN", status: "ACTIVE" }, capabilities: ["member:invite", "member:edit"] };
test("capabilities and structural assignment policy both constrain UI actions", () => {
  assert.deepEqual(assignableRoles("ADMIN"), ["ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"]);
  assert.deepEqual(assignableRoles("VIEWER"), []);
  assert.equal(canEditMember(access, { ...access.membership, role: "OWNER", userId: "other" }), false);
  assert.equal(canEditMember(access, { ...access.membership, role: "VIEWER", userId: "other" }), true);
  assert.equal(canEditMember({ ...access, capabilities: [] }, { ...access.membership, role: "VIEWER" }), false);
});
test("API response guards reject malformed sessions, cross-tenant discovery rows, and role/status values", () => {
  assert.equal(isAccess(access), true);
  assert.equal(isAccess({ ...access, membership: { ...access.membership, organizationId: userId } }), false);
  assert.equal(isAccess({ ...access, membership: { ...access.membership, role: "SUPERUSER" } }), false);
  assert.equal(isPage(isAccess)({ items: [access], nextCursor: null }), true);
  assert.equal(isSession({ user: { id: "bad", email: "email", fullName: "Name" } }), false);
});
test("API client sends cookie credentials, preserves shared errors and correlation, and rejects malformed success", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "http://api.example/organizations"); assert.equal(init.credentials, "include"); assert.equal(init.cache, "no-store");
    return new Response(JSON.stringify({ error: "Permission denied." }), { status: 403, headers: { "X-Request-Id": "request-reference" } });
  };
  await assert.rejects(apiRequest("/organizations", isPage(isAccess)), (error) => error instanceof ApiError && error.status === 403 && error.message === "Permission denied." && error.requestId === "request-reference");
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [null] }));
  await assert.rejects(apiRequest("/organizations", isPage(isAccess)), { status: 502 });
  globalThis.fetch = async () => { throw new TypeError("private infrastructure details"); };
  await assert.rejects(apiRequest("/organizations", isPage(isAccess)), (error) => error.status === 0 && !error.message.includes("private infrastructure"));
});
test("403 feedback is announced, clear, and renders server messages as escaped text", () => {
  const html = renderToStaticMarkup(createElement(ApiAlert, { error: new ApiError(403, "<script>unsafe</script>", "reference") }));
  assert.match(html, /role="alert"/); assert.match(html, /Permission Denied/); assert.match(html, /&lt;script&gt;/); assert.match(html, /Reference: reference/);
});
