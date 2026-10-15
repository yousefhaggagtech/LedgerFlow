import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));

// Exercise the actual TSX with Node's test runner, without a second bundler or test dependency.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const path = sourceRoot + specifier.slice(2);
      for (const extension of [".ts", ".tsx"]) {
        if (existsSync(path + extension)) {
          return { url: pathToFileURL(path + extension).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && /\.tsx?$/.test(url)) {
      const source = readFileSync(new URL(url), "utf8");
      return {
        format: "module",
        source: ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }
        }).outputText,
        shortCircuit: true
      };
    }
    return nextLoad(url, context);
  }
});
