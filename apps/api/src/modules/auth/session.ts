import type { CookieOptions, RequestHandler } from "express";
import type { AuthStore } from "./types.ts";
import type { AuthConfig } from "./config.ts";
import { sessionKey } from "../../infrastructure/session-credentials.ts";
export { newSessionToken, sessionKey } from "../../infrastructure/session-credentials.ts";

export function cookieOptions(config: AuthConfig): CookieOptions {
  return { httpOnly: true, secure: config.production, sameSite: "lax", path: "/" };
}

export function authenticate(store: AuthStore, config: AuthConfig, now = () => new Date()): RequestHandler {
  return async (request, response, next) => {
    const cookies: Record<string, unknown> = request.cookies;
    const key = sessionKey(cookies[config.cookieName]);
    const user = key ? await store.findSessionUser(key, now()) : undefined;
    response.set("Cache-Control", "no-store");
    if (!user) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    request.user = user;
    request.userId = user.id;
    next();
  };
}
