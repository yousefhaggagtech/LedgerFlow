import { isIP } from "node:net";
import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS, SESSION_TTL_MS, type AuthConfig } from "./config.ts";
import { authenticate, cookieOptions, sessionKey } from "./session.ts";
import type { Login } from "./login.ts";
import type { AuthStore } from "./types.ts";
import { logger as defaultLogger, type StructuredLogger } from "../../infrastructure/logger.ts";
import { identifyRoute, logRequestFailure } from "../../presentation/request-diagnostics.ts";

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

export function createAuthRouter(store: AuthStore, config: AuthConfig, executeLogin: Login,
  now = () => new Date(), logger: StructuredLogger = defaultLogger): Router {
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
    const cookies: Record<string, unknown> = request.cookies;
    const ip = request.ip;
    const result = await executeLogin(input, { previousSession: sessionKey(cookies[config.cookieName]),
      userAgent: request.get("user-agent")?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      ipAddress: ip && isIP(ip) ? ip : null }, () =>
      logRequestFailure(request, response, 401, "INTERNAL_FAILURE", logger, "password_hash_verification_failed"));
    if (!result) {
      response.status(401).json({ error: "Invalid email or password" });
      return;
    }
    response.cookie(config.cookieName, result.session.token, {
      ...cookieOptions(config), maxAge: SESSION_TTL_MS, expires: result.session.expiresAt });
    response.status(200).json({ user: result.user });
  };
  router.post("/login", identifyRoute("/auth/login"), limit, login);
  router.post("/logout", identifyRoute("/auth/logout"), async (request, response) => {
    const cookies: Record<string, unknown> = request.cookies;
    const key = sessionKey(cookies[config.cookieName]);
    if (key) await store.deleteSession(key);
    response.clearCookie(config.cookieName, cookieOptions(config));
    response.status(204).end();
  });
  router.get("/me", identifyRoute("/auth/me"), authenticate(store, config, now), (request, response) => {
    response.json({ user: request.user });
  });
  return router;
}
