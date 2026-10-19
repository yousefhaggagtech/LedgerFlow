import type { NextConfig } from "next";
import { resolve } from "node:path";

// npm workspace scripts run with apps/web as their working directory.
process.loadEnvFile(resolve(process.cwd(), "../../.env"));

const publicApiUrl = process.env.NEXT_PUBLIC_API_URL;
if (!publicApiUrl) throw new Error("NEXT_PUBLIC_API_URL is required.");
const apiOrigin = new URL(publicApiUrl);
if (!["http:", "https:"].includes(apiOrigin.protocol) || apiOrigin.username || apiOrigin.password || apiOrigin.pathname !== "/" || apiOrigin.search || apiOrigin.hash) {
  throw new Error("NEXT_PUBLIC_API_URL must be an HTTP(S) origin without credentials or a path.");
}
const config: NextConfig = {};
export default config;
