import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createRedactor } from "./log-safety.mjs";

export const GATES = Object.freeze({
  install: ["ci"], build: ["run", "build", "--", "--force"],
  db: ["run", "test", "--workspace=@ledgerflow/db"],
  integration: ["run", "test:integration", "--workspace=@ledgerflow/api"],
  api: ["run", "test", "--workspace=@ledgerflow/api"], web: ["run", "test", "--workspace=@ledgerflow/web"],
  lint: ["run", "lint", "--", "--force"], typecheck: ["run", "typecheck", "--", "--force"],
  browser: ["run", "test:identity-browser", "--workspace=@ledgerflow/web"]
});

export function npmInvocation(args) {
  return process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...args] }
    : { command: "npm", args };
}

export async function captureCommand(command, args, destination, env = process.env) {
  await mkdir(dirname(destination), { recursive: true });
  const log = createWriteStream(destination, { flags: "w" });
  const redact = createRedactor(env);
  const write = (line) => { const safe = redact(line) + "\n"; process.stdout.write(safe); log.write(safe); };
  const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  log.on("error", () => child.kill());
  const exit = new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code) => accept(code ?? 1));
  });
  const drain = async (stream) => { for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) write(line); };
  try {
    const [code] = await Promise.all([exit, drain(child.stdout), drain(child.stderr)]);
    write(`Command exit status: ${code}`);
    return code;
  } finally { log.end(); await finished(log); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gate = process.argv[2];
  if (!Object.hasOwn(GATES, gate)) {
    process.stderr.write("Unknown CI gate.\n"); process.exitCode = 1;
  } else {
    process.stdout.write(`Gate ${gate}: npm ${GATES[gate].join(" ")}\n`);
    const invocation = npmInvocation(GATES[gate]);
    try {
      process.exitCode = await captureCommand(invocation.command, invocation.args,
        join(process.env.CI_LOG_DIR ?? resolve("tmp/ci-logs"), `${gate}.log`));
    } catch (error) {
      process.stderr.write(createRedactor()(error instanceof Error ? error.message : "CI command could not start.") + "\n");
      process.exitCode = 1;
    }
  }
}
