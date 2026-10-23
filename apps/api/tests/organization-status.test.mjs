import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OrganizationService } from "../dist/modules/organizations/service.js";

const input = { name: "Status test", baseCurrency: "EGP", accountingTimezone: "Africa/Cairo" };
const actor = { userId: "10000000-0000-4000-8000-000000000001", correlationId: "request" };
const member = { id: "membership", userId: actor.userId, organizationId: "20000000-0000-4000-8000-000000000001", role: "OWNER", status: "ACTIVE",
  capabilities: ["org:read", "member:read", "member:invite", "member:edit"] };

function fixture(status) {
  let mutations = 0;
  const organization = status ? { id: member.organizationId, ...input, status } : undefined;
  const repository = {
    async organization() { return organization; },
    async findMembership(userId) { return userId === actor.userId ? member : undefined; },
    async listMembers() { return [member]; },
    async addMember() { mutations++; return member; },
    async changeRole() { mutations++; return member; },
    async hasOtherActiveOwner() { return true; },
    async audit() { mutations++; }
  };
  const transaction = {
    async forOrganization() { return repository; },
    async findAuthorization() { return member; },
    async findActiveUser() { return true; },
    async lockCreator() { return true; },
    async findCreation() { return { organizationId: member.organizationId,
      requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      expiresAt: new Date("2030-01-01"), response: { organization, membership: member } }; }
  };
  return { service: new OrganizationService({ async transaction(_context, work) { return work(transaction); } }, () => new Date("2026-01-01")),
    mutations: () => mutations };
}

for (const operation of ["access", "get", "members", "add", "changeRole", "create"]) {
  test(`${operation} hides a suspended organization without writes or success audits`, async () => {
    const { service, mutations } = fixture("SUSPENDED");
    const run = {
      access: () => service.access(member.organizationId, actor.userId),
      get: () => service.get(member.organizationId, actor.userId),
      members: () => service.members(member.organizationId, actor.userId, { limit: 10 }),
      add: () => service.add(member.organizationId, actor, { userId: "target", role: "VIEWER" }),
      changeRole: () => service.changeRole(member.organizationId, actor, actor.userId, "ADMIN"),
      create: () => service.create(actor, input, "same-key")
    };
    await assert.rejects(run[operation], { code: "RESOURCE_NOT_FOUND", message: "Organization not found." });
    assert.equal(mutations(), 0);
  });
}

test("active organization access remains available", async () => {
  const { service } = fixture("ACTIVE");
  assert.equal((await service.get(member.organizationId, actor.userId)).status, "ACTIVE");
});

test("creation replay also hides a missing root returned by the store", async () => {
  const { service } = fixture(undefined);
  await assert.rejects(service.create(actor, input, "same-key"), { code: "RESOURCE_NOT_FOUND", message: "Organization not found." });
});
