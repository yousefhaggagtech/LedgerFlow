import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const config = ts.readConfigFile(configPath, ts.sys.readFile);
assert.equal(config.error, undefined);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
assert.deepEqual(parsed.errors, []);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const pathOf = (file) => relative(root, file.fileName).replaceAll("\\", "/");
const service = "src/modules/organizations/service.ts";
const contracts = "src/modules/organizations/types.ts";
const adapter = "src/infrastructure/organization-store.ts";
const ports = new Set(["OrganizationStore", "OrganizationTransaction", "OrganizationRepository"]);
const wiring = new Set([service, contracts, adapter, "src/app.ts", "src/index.ts"]);

function inspectBoundary(program) {
  const checker = program.getTypeChecker();
  const violations = [];
  let resolvedPortCalls = 0;
  for (const source of program.getSourceFiles().filter((file) => pathOf(file).startsWith("src/"))) {
    const path = pathOf(source);
    function visit(node) {
      // Resolved signatures catch aliases, destructuring, and bracket calls as well as dot calls.
      if (ts.isCallExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration && pathOf(declaration.getSourceFile()) === contracts && ports.has(declaration.parent.name?.text)) {
          resolvedPortCalls++;
          if (path !== service) violations.push(`${path}: direct ${declaration.parent.name.text}.${declaration.name.getText()} call`);
        }
        if (path !== service && declaration && pathOf(declaration.getSourceFile()) === adapter && declaration.parent.name?.text === "PostgresOrganizationStore") {
          violations.push(`${path}: concrete store transaction call`);
        }
        if (path !== adapter && ts.isPropertyAccessExpression(node.expression) &&
            ["insertInto", "updateTable", "deleteFrom"].includes(node.expression.name.text) &&
            node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
            ["organizations", "memberships", "audit_events", "idempotency_records"].includes(node.arguments[0].text)) {
          violations.push(`${path}: direct organization table write`);
        }
      }
      // Non-service consumers receive service methods/DTOs, not access to persistence wiring.
      if (ts.isIdentifier(node) && !wiring.has(path)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (symbol?.declarations?.some((declaration) =>
          (pathOf(declaration.getSourceFile()) === contracts && ports.has(symbol.name)) ||
          (pathOf(declaration.getSourceFile()) === adapter && symbol.name === "PostgresOrganizationStore"))) {
          violations.push(`${path}: organization persistence capability ${symbol.name}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { violations, resolvedPortCalls };
}

test("organization transaction/repository capabilities are consumed only by the application service", () => {
  const { violations, resolvedPortCalls } = inspectBoundary(program);
  assert.ok(resolvedPortCalls > 0, "The boundary check must resolve the real service's port calls.");
  assert.deepEqual(violations, [], "Keep organization write orchestration in OrganizationService; new writers require review.");
});

test("boundary check rejects aliased ports, destructured calls, and bracket mutation calls", () => {
  const probePath = fileURLToPath(new URL("../src/boundary-probe.ts", import.meta.url));
  const probe = `import type { OrganizationStore as Store } from './modules/organizations/types.ts';
    export async function bypass(store: Store, db: { updateTable(table: string): unknown }) {
      db.updateTable('memberships');
      const { transaction } = store;
      return transaction({ userId: 'actor' }, async tx => {
        const repo = await tx.forOrganization('tenant');
        return repo['changeRole']('target', 'ADMIN');
      });
    }`;
  const host = ts.createCompilerHost(parsed.options);
  const originalGetSource = host.getSourceFile.bind(host);
  host.getSourceFile = (path, ...args) => path.replaceAll("\\", "/") === probePath.replaceAll("\\", "/")
    ? ts.createSourceFile(path, probe, parsed.options.target, true) : originalGetSource(path, ...args);
  const checked = ts.createProgram([...parsed.fileNames, probePath], parsed.options, host);
  const source = checked.getSourceFile(probePath);
  assert.ok(source, "The synthetic bypass must be included in the checked program.");
  assert.deepEqual(checked.getSemanticDiagnostics(source), []);
  const { violations } = inspectBoundary(checked);
  for (const method of ["OrganizationStore.transaction", "OrganizationTransaction.forOrganization", "OrganizationRepository.changeRole"]) {
    assert.ok(violations.some((violation) => violation.includes(method)), method);
  }
  assert.ok(violations.some((violation) => violation.includes("direct organization table write")));
});
