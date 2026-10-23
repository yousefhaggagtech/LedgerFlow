import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function createCiEnvironment(path = ".env", env = process.env) {
  if (env.CI !== "true" || env.GITHUB_ACTIONS !== "true") throw new Error("CI environment creation requires an explicit CI context.");
  // next.config.ts requires a public origin even for compilation. These origins
  // cannot reach a development API, and no database fallback is written here.
  await writeFile(path, "NEXT_PUBLIC_API_URL=http://127.0.0.1:1\nAPI_URL=http://127.0.0.1:1\n", { flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await createCiEnvironment();
