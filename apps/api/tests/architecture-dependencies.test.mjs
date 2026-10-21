import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { architectureProgram, inspectArchitecture, packageCycles, root } from "./helpers/architecture.mjs";
import { resolve } from "node:path";

test("implemented source dependencies respect inward contracts and outer composition", () => {
  const allowed = {
    "apps/api/src/modules/auth/allowed-probe.ts": 'import type { AuthStore } from "./types.ts"; import type { MembershipRole } from "@ledgerflow/shared"; import { createHash } from "node:crypto"; export type Port = AuthStore; export type Role = MembershipRole; export const hash = createHash;',
    "apps/api/src/infrastructure/allowed-probe.ts": 'export type { AuthStore } from "../modules/auth/types.ts";',
    "apps/api/src/presentation/allowed-probe.ts": 'export type { Login } from "../modules/auth/login.ts";'
  };
  const checked = architectureProgram(allowed);
  const result = inspectArchitecture(checked);
  assert.ok(result.edges.length > 50, "The real source dependency graph must be analyzed");
  assert.deepEqual(result.violations, []);
  assert.ok(result.edges.some((edge) => edge.source === "apps/api/src/app.ts" && edge.target.endsWith("infrastructure/session-credentials.ts")));
  assert.ok(result.edges.some((edge) => edge.source === "packages/db/src/schema.ts" && edge.target === "packages/shared/src/index.ts"));
  for (const path of Object.keys(allowed)) {
    const source = checked.program.getSourceFile(resolve(root, path));
    assert.ok(source);
    assert.deepEqual(checked.program.getSemanticDiagnostics(source), []);
  }
});

test("negative fixtures prove imports, aliases, type queries, barrels, dynamic loading, and inward declarations are checked", () => {
  const probes = {
    "apps/api/src/modules/organizations/domain-probe.ts": 'import type { MembershipRole as Role } from "@ledgerflow/db"; export type Bad = Role;',
    "apps/api/src/modules/organizations/concrete-probe.ts": 'import type { PostgresOrganizationStore as Store } from "../../infrastructure/organization-store.ts"; export type Bad = Store;',
    "apps/api/src/modules/auth/express-probe.ts": 'import type { Request as Req } from "express"; export type Bad = Req;',
    "packages/db/src/outward-probe.ts": 'export { OrganizationService } from "../../../apps/api/src/modules/organizations/service.ts";',
    "apps/api/src/infrastructure/router-probe.ts": 'export { createAuthRouter } from "../modules/auth/routes.ts";',
    "apps/api/src/modules/auth/password-probe.ts": 'import { verifyPassword as verify } from "./password.ts"; export const bad = verify;',
    "apps/api/src/modules/auth/barrel-probe.ts": 'export type { MembershipRole } from "@ledgerflow/db";',
    "apps/api/src/modules/auth/transitive-probe.ts": 'export type { MembershipRole } from "./barrel-probe.ts";',
    "apps/api/src/modules/auth/type-query-probe.ts": 'export type Bad = import("@ledgerflow/db").Database;',
    "apps/api/src/modules/auth/dynamic-probe.ts": 'export const bad = () => import("../../infrastructure/organization-store.ts");',
    "apps/api/src/modules/auth/computed-probe.ts": 'export const bad = (name: string) => import(name);',
    "apps/api/src/modules/auth/require-probe.ts": 'import Pg = require("pg"); export type Bad = Pg.Pool;',
    "apps/api/src/modules/auth/alias-probe.ts": 'export type { Database } from "@persistence";',
    "apps/api/src/modules/auth/declaration-probe.ts": 'export {}; declare global { namespace Express { interface Request { bad?: string } } }',
    "apps/api/src/modules/auth/error-probe.ts": 'export class Bad extends Error { readonly status = 403; }',
    "apps/api/src/presentation/orchestration-probe.ts": 'import type { AuthStore } from "../modules/auth/types.ts"; export const bad = (store: AuthStore) => store.findUserByEmail("input");',
    "apps/api/src/presentation/construction-probe.ts": 'import { PostgresAuthStore as Store } from "../infrastructure/auth-store.ts"; export const bad = (db: ConstructorParameters<typeof Store>[0]) => new Store(db);',
    "packages/shared/src/outward-probe.ts": 'export type { Database } from "@ledgerflow/db";'
  };
  const checked = architectureProgram(probes, { "@persistence": ["packages/db/src/schema.ts"] });
  const result = inspectArchitecture(checked);
  for (const path of Object.keys(probes)) {
    const source = checked.program.getSourceFile(resolve(root, path));
    assert.ok(source, `${path} must participate in the actual program`);
    assert.deepEqual(checked.program.getSemanticDiagnostics(source).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), [], `${path} must be valid TypeScript`);
    assert.ok(result.violations.some((violation) => violation.startsWith(`${path}:`)), `Analyzer missed ${path}`);
  }
  assert.ok(result.edges.some((edge) => edge.form === "import-type"));
  assert.ok(result.edges.some((edge) => edge.form === "dynamic-or-require"));
  assert.ok(result.edges.some((edge) => edge.form === "import-equals"));
  assert.ok(result.violations.some((violation) => violation.includes("transitive-probe.ts:") && violation.includes("packages/db/src/index.ts")));
});

test("workspace dependency graph has no cycle or outward DB/shared edge", () => {
  const { graph, cycles } = packageCycles();
  assert.deepEqual(cycles, []);
  assert.deepEqual(graph["@ledgerflow/shared"], []);
  assert.deepEqual(graph["@ledgerflow/db"], ["@ledgerflow/shared"]);
});
