import { isIP } from "node:net";
import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS, SESSION_TTL_MS, type AuthConfig } from "./config.ts";
import { authenticate, cookieOptions, newSessionToken, sessionKey } from "./session.ts";
import { verifyPassword } from "./password.ts";
import type { AuthStore } from "./types.ts";

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1_024;
const MAX_USER_AGENT_LENGTH = 512;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function credentials(body: unknown): { email: string; password: string } | undefined {
  if (typeof body !== "object" || body === null || !("email" in body) || !("password" in body)) return undefined;
  const { email, password } = body;
  if (typeof email !== "string" || typeof password !== "string") return undefined;
  // Preserve the existing case-sensitive unique-email contract; trim only whitespace.
  const trimmedEmail = email.trim();
  if (trimmedEmail.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(trimmedEmail) ||
      password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return undefined;
  return { email: trimmedEmail, password };
}

export function createAuthRouter(store: AuthStore, config: AuthConfig, now = () => new Date()): Router {
  const router = Router();
  router.use((_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  const limit = rateLimit({
    windowMs: LOGIN_WINDOW_MS, limit: LOGIN_ATTEMPT_LIMIT,
    standardHeaders: "draft-8", legacyHeaders: false,
    message: { error: "Too many login attempts. Try again later." }
  });

  const login: RequestHandler = async (request, response) => {
    const input = credentials(request.body);
    if (!input) {
      response.status(400).json({ error: "A valid email and password are required." });
      return;
    }
    const user = await store.findUserByEmail(input.email);
    const passwordMatches = await verifyPassword(user?.passwordHash, input.password);
    if (!user || !passwordMatches || user.status !== "ACTIVE") {
      response.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const token = newSessionToken();
    const key = sessionKey(token);
    if (!key) throw new Error("Session token generation failed.");
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
    const cookies: Record<string, unknown> = request.cookies;
    const ip = request.ip;
    await store.createSession({ ...key, userId: user.id, createdAt, expiresAt,
      userAgent: request.get("user-agent")?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      ipAddress: ip && isIP(ip) ? ip : null
    }, sessionKey(cookies[config.cookieName]));
    response.cookie(config.cookieName, token, { ...cookieOptions(config), maxAge: SESSION_TTL_MS, expires: expiresAt });
    response.status(200).json({ user: { id: user.id, email: user.email, fullName: user.fullName } });
  };
  router.post("/login", limit, login);
  router.post("/logout", async (request, response) => {
    const cookies: Record<string, unknown> = request.cookies;
    const key = sessionKey(cookies[config.cookieName]);
    if (key) await store.deleteSession(key);
    response.clearCookie(config.cookieName, cookieOptions(config));
    response.status(204).end();
  });
  router.get("/me", authenticate(store, config, now), (request, response) => {
    response.json({ user: request.user });
  });
  return router;
}
