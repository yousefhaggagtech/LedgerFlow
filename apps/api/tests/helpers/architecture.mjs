import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const root = fileURLToPath(new URL("../../../../", import.meta.url));
const pathOf = (file) => relative(root, file).replaceAll("\\", "/");
const outerAuth = new Set(["routes.ts", "session.ts", "config.ts"]);
function layer(path) {
  if (path.startsWith("packages/shared/src/")) return "shared";
  if (path.startsWith("packages/db/src/")) return "infrastructure";
  if (!path.startsWith("apps/api/src/")) return "external";
  if (["apps/api/src/app.ts", "apps/api/src/index.ts"].includes(path)) return "composition";
  if (path.startsWith("apps/api/src/presentation/") || /\/routes\.ts$/.test(path) ||
      (path.startsWith("apps/api/src/modules/auth/") && outerAuth.has(path.split("/").at(-1)))) return "presentation";
  // Existing feature-local Argon2 adapter is wired only by the composition root.
  if (path.startsWith("apps/api/src/infrastructure/") || path === "apps/api/src/modules/auth/password.ts") return "infrastructure";
  return "inner";
}
const allowedPlatform = new Set(["node:crypto", "node:buffer"]);
function forbidden(source, target) {
  const from = layer(source);
  const to = layer(target);
  if (source.startsWith("packages/db/src/") && target.startsWith("apps/")) return true;
  if (from === "shared") return to !== "shared" && !allowedPlatform.has(target);
  if (from === "inner") return !["inner", "shared"].includes(to) && !allowedPlatform.has(target);
  if (from === "infrastructure") return ["presentation", "composition"].includes(to) || /^(express|express-rate-limit|cors|helmet|cookie-parser)(\/|$)/.test(target);
  return false;
}

export function architectureProgram(fixtures = {}, paths = {}) {
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options = { ...parsed.options, noEmit: true, rewriteRelativeImportExtensions: true, baseUrl: root, paths };
  const virtual = new Map(Object.entries(fixtures).map(([path, text]) => [resolve(root, path).replaceAll("\\", "/"), text]));
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (path) => virtual.has(path.replaceAll("\\", "/")) || fileExists(path);
  host.readFile = (path) => virtual.get(path.replaceAll("\\", "/")) ?? readFile(path);
  host.getSourceFile = (path, ...args) => virtual.has(path.replaceAll("\\", "/"))
    ? ts.createSourceFile(path, host.readFile(path), options.target, true) : getSourceFile(path, ...args);
  const files = ["apps/api/src", "packages/db/src", "packages/shared/src"].flatMap((path) =>
    ts.sys.readDirectory(resolve(root, path), [".ts"], undefined, ["**/*.ts"]));
  return { program: ts.createProgram([...files, ...virtual.keys()], options, host), host, options };
}

export function inspectArchitecture({ program, host, options }) {
  const checker = program.getTypeChecker();
  const edges = [];
  const violations = [];
  const sources = program.getSourceFiles().filter((file) => layer(pathOf(file.fileName)) !== "external" && !pathOf(file.fileName).includes("/dist/"));
  function add(source, node, specifier, form) {
    const path = pathOf(source.fileName);
    const resolved = ts.resolveModuleName(specifier, source.fileName, options, host).resolvedModule;
    // Workspace exports resolve to built .d.ts; follow the corresponding source
    // so type-only imports and re-export barrels participate in the same graph.
    let target = resolved ? pathOf(resolved.resolvedFileName) : specifier;
    if (/^packages\/(db|shared)\/dist\//.test(target)) target = target.replace("/dist/", "/src/").replace(/\.d\.ts$/, ".ts");
    if (target.includes("node_modules/") || (!resolved && !specifier.startsWith("node:"))) target = specifier;
    edges.push({ source: path, target, specifier, form, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    if (!resolved && !specifier.startsWith("node:")) violations.push(`${path}: unresolved dependency ${specifier}`);
  }
  for (const source of sources) {
    const path = pathOf(source.fileName);
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        add(source, node, node.moduleSpecifier.text, ts.isImportDeclaration(node) ? "import" : "re-export");
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        add(source, node, node.argument.literal.text, "import-type");
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
        add(source, node, node.moduleReference.expression.text, "import-equals");
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) add(source, node, arg.text, "dynamic-or-require");
        else if (["inner", "shared"].includes(layer(path))) violations.push(`${path}: computed module loading in inner code`);
      }
      if (layer(path) === "inner") {
        if (ts.isModuleDeclaration(node) && node.name.getText() === "Express") violations.push(`${path}: inner Express augmentation`);
        if (ts.isClassDeclaration(node) && node.heritageClauses?.some((clause) => clause.types.some((type) => type.expression.getText() === "Error")) &&
            node.members.some((member) => member.name && ["status", "statusCode"].includes(member.name.getText()))) violations.push(`${path}: HTTP-coded inner error`);
      }
      if (ts.isCallExpression(node) && layer(path) === "presentation") {
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (declaration && pathOf(declaration.getSourceFile().fileName) === "apps/api/src/modules/auth/types.ts" &&
            ["findUserByEmail", "createSession"].includes(declaration.name?.getText())) violations.push(`${path}: login orchestration bypasses use case`);
      }
      if (ts.isNewExpression(node) && layer(path) === "presentation") {
        let symbol = checker.getSymbolAtLocation(node.expression);
        if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (symbol?.declarations?.some((declaration) => layer(pathOf(declaration.getSourceFile().fileName)) === "infrastructure")) {
          violations.push(`${path}: concrete infrastructure construction outside composition`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const outgoing = Map.groupBy(edges, (edge) => edge.source);
  for (const source of sources) {
    const start = pathOf(source.fileName);
    const seen = new Set([start]);
    const pending = [...(outgoing.get(start) ?? [])];
    for (const edge of pending) {
      if (forbidden(start, edge.target)) violations.push(`${start}: forbidden dependency on ${edge.target} via ${edge.source}:${edge.line} (${edge.form})`);
      if (/\/routes\.ts$/.test(start) && edge.target === "apps/api/src/modules/auth/password.ts") violations.push(`${start}: router binds concrete password adapter`);
      if (!seen.has(edge.target)) { seen.add(edge.target); pending.push(...(outgoing.get(edge.target) ?? [])); }
    }
  }
  return { edges, violations: [...new Set(violations)] };
}

export function packageCycles() {
  const packages = ["apps/api", "apps/web", "packages/db", "packages/shared"].map((path) => JSON.parse(readFileSync(resolve(root, path, "package.json"), "utf8")));
  const graph = new Map(packages.map((pkg) => [pkg.name, Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => packages.some((item) => item.name === name))]));
  const cycles = [];
  function walk(name, trail) {
    if (trail.includes(name)) { cycles.push([...trail, name]); return; }
    for (const dependency of graph.get(name) ?? []) walk(dependency, [...trail, name]);
  }
  for (const name of graph.keys()) walk(name, []);
  return { graph: Object.fromEntries(graph), cycles };
}
