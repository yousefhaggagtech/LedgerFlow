import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function qualitySummary(env = process.env) {
  const gates = [["Build", "BUILD"], ["DB Integration", "DB"], ["API Integration", "INTEGRATION"],
    ["API Unit + Architecture", "API"], ["Web Tests", "WEB"], ["Lint", "LINT"], ["Typecheck", "TYPECHECK"]];
  const outcomes = { success: "PASS", failure: "FAIL", cancelled: "CANCELLED", skipped: "NOT EXECUTED" };
  const version = (value) => /^\d+\.\d+(?:\.\d+)?$/.test(value ?? "") ? value : "NOT VERIFIED";
  const lines = ["## CI quality gates", "", "| Gate | Status |", "| --- | --- |",
    ...gates.map(([label, key]) => `| ${label} | ${outcomes[env[`GATE_${key}`]] ?? "NOT EXECUTED"} |`), "",
    `Node ${version(env.CI_NODE_VERSION)}; npm ${version(env.CI_NPM_VERSION)}; PostgreSQL ${version(env.CI_POSTGRES_VERSION)}.`,
    "", "Counts are reported by the test runners above; no totals are inferred from exit codes.",
    "A failed or unexecuted mandatory gate is not a passing merge check.", ""];
  return lines.join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, qualitySummary());
}
