import type { NextConfig } from "next";
import { resolve } from "node:path";

// npm workspace scripts run with apps/web as their working directory.
process.loadEnvFile(resolve(process.cwd(), "../../.env"));

const config: NextConfig = {};
export default config;
