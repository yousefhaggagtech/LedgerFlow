import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES, ORGANIZATION_STATUSES } from "@ledgerflow/shared";
import { isRole, isCreationResult } from "../dist/modules/organizations/validation.js";
import { architectureProgram, root } from "./helpers/architecture.mjs";

test("shared vocabulary preserves five-role/status values and existing validation", () => {
  assert.deepEqual(MEMBERSHIP_ROLES, ["OWNER", "ADMIN", "ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"]);
  assert.deepEqual(MEMBERSHIP_STATUSES, ["ACTIVE", "INACTIVE"]);
  assert.deepEqual(ORGANIZATION_STATUSES, ["ACTIVE", "SUSPENDED"]);
  for (const values of [MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES, ORGANIZATION_STATUSES]) {
    assert.equal(Object.isFrozen(values), true);
    assert.throws(() => values.push("UNSUPPORTED"), TypeError);
  }
  for (const role of MEMBERSHIP_ROLES) assert.equal(isRole(role), true);
  for (const role of ["owner", "SUPER_ADMIN", null, {}, 1]) assert.equal(isRole(role), false);
  const id = "00000000-0000-4000-8000-000000000001";
  for (const status of ORGANIZATION_STATUSES) for (const membershipStatus of MEMBERSHIP_STATUSES) {
    const result = { organization: { id, name: "Organization", baseCurrency: "EGP", accountingTimezone: "UTC", status },
      membership: { organizationId: id, userId: id, role: "OWNER", status: membershipStatus } };
    assert.equal(isCreationResult(result), true);
    assert.equal(isCreationResult({ ...result, organization: { ...result.organization, status: "UNKNOWN" } }), false);
  }
});

test("DB compatibility exports and schema columns retain exactly the independent vocabulary types", () => {
  const path = "packages/db/src/vocabulary-probe.ts";
  const checked = architectureProgram({ [path]: `
    import type { MembershipRole as Role, MembershipStatus as MemberStatus, OrganizationStatus as OrgStatus } from '@ledgerflow/shared';
    import type { MembershipRole as OldRole, MembershipStatus as OldMemberStatus, OrganizationStatus as OldOrgStatus, Database } from '@ledgerflow/db';
    import type { Selectable } from 'kysely';
    type Same<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Assert<T extends true> = T;
    type RoleCompatibility = Assert<Same<Role, OldRole>>;
    type MemberCompatibility = Assert<Same<MemberStatus, OldMemberStatus>>;
    type OrgCompatibility = Assert<Same<OrgStatus, OldOrgStatus>>;
    type RoleColumn = Assert<Same<Selectable<Database['memberships']>['role'], Role>>;
    type MemberStatusColumn = Assert<Same<Selectable<Database['memberships']>['status'], MemberStatus>>;
    type OrgStatusColumn = Assert<Same<Selectable<Database['organizations']>['status'], OrgStatus>>;
  ` });
  const source = checked.program.getSourceFile(resolve(root, path));
  assert.ok(source);
  assert.deepEqual(checked.program.getSemanticDiagnostics(source), []);
});
