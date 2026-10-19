import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CookieOptions, RequestHandler } from "express";
import type { AuthStore, SessionKey } from "./types.ts";
import type { AuthConfig } from "./config.ts";

const SESSION_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})$/;

export function sessionKey(cookie: unknown): SessionKey | undefined {
  if (typeof cookie !== "string") return undefined;
  const parts = SESSION_PATTERN.exec(cookie);
  if (!parts?.[1] || !parts[2]) return undefined;
  return { id: parts[1], tokenHash: createHash("sha256").update(parts[2]).digest("hex") };
}

export function newSessionToken(): string {
  return `${randomUUID()}.${randomBytes(32).toString("hex")}`;
}

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
