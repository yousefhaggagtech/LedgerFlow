import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { npmInvocation } from "./run-gate.mjs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const target = /^npm@(11\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
const invocation = npmInvocation(["--version"]);
const npm = execFileSync(invocation.command, invocation.args, { encoding: "utf8", windowsHide: true }).trim();
if (!target || process.versions.node.split(".")[0] !== "24" || npm !== target) {
  throw new Error("CI requires Node 24 and the exact npm 11 version recorded in packageManager.");
}
process.stdout.write(`Node ${process.versions.node}; npm ${npm}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `node=${process.versions.node}\nnpm=${npm}\n`);
