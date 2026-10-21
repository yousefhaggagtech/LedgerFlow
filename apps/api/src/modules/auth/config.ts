export { SESSION_TTL_MS, SESSION_CLEANUP_INTERVAL_MS } from "./session-policy.ts";
export const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
export const LOGIN_ATTEMPT_LIMIT = 10;

export interface AuthConfig {
  webOrigin: string;
  production: boolean;
  cookieName: string;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const mode = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(mode)) {
    throw new Error("NODE_ENV must be development, test, or production.");
  }
  const production = mode === "production";
  const value = env.WEB_ORIGIN;
  let origin: URL;
  try {
    origin = new URL(value ?? "");
  } catch {
    throw new Error("WEB_ORIGIN must be the exact web app origin.");
  }
  if (value !== origin.origin || !["http:", "https:"].includes(origin.protocol) ||
      (production && origin.protocol !== "https:")) {
    throw new Error("WEB_ORIGIN must be an exact HTTP(S) origin; production requires HTTPS.");
  }
  return { webOrigin: origin.origin, production,
    cookieName: production ? "__Host-ledgerflow_session" : "ledgerflow_session" };
}
