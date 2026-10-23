import assert from "node:assert/strict";
import test from "node:test";
import { OrganizationService } from "../dist/modules/organizations/service.js";

test("access hints return post-lock current membership and grants even when org:read is revoked", async () => {
  const member = { id: "member", userId: "user", organizationId: "organization", role: "VIEWER", status: "ACTIVE", capabilities: ["member:read"] };
  let calls = 0;
  const service = new OrganizationService({ async transaction(context, work) {
    assert.deepEqual(context, { userId: member.userId });
    return work({
      async forOrganization(organizationId) { assert.equal(organizationId, member.organizationId); return { async organization(lock) { assert.equal(lock, "read"); return { id: organizationId, status: "ACTIVE" }; } }; },
      async findAuthorization(organizationId, userId) { assert.equal(organizationId, member.organizationId); assert.equal(userId, member.userId); return { ...member, capabilities: ++calls === 1 ? ["member:read"] : [] }; }
    });
  } });
  assert.deepEqual(await service.access(member.organizationId, member.userId), {
    membership: { userId: member.userId, organizationId: member.organizationId, role: "VIEWER", status: "ACTIVE" }, capabilities: []
  });
  assert.equal(calls, 2);
});
