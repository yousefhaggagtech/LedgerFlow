import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, Request, RequestHandler, Response } from "express";
import { logger as defaultLogger, SAFE_ROUTES, type ErrorCategory, type SafeRoute, type StructuredLogger } from "../infrastructure/logger.ts";
import { organizationErrorHttp } from "./organization-errors.ts";

const DATABASE_FAILURE_CODES = new Set(["23502", "23503", "23505", "23514", "22P02", "42P01", "42703",
  "53300", "57P01", "08000", "08003", "08006", "XX000"]);
const MAX_ERROR_PROTOTYPE_DEPTH = 16;

export const correlateRequest: RequestHandler = (_request, response, next) => {
  const requestId = randomUUID();
  Object.defineProperty(response.locals, "requestId", { value: requestId });
  response.set("X-Request-Id", requestId);
  next();
};

export function requestId(response: Response): string {
  const value: unknown = response.locals.requestId;
  if (typeof value !== "string") throw new Error("Request correlation is missing.");
  return value;
}

export function identifyRoute(route: SafeRoute): RequestHandler {
  return (_request, response, next) => { response.locals.diagnosticRoute = route; next(); };
}

function field(error: unknown, name: string): unknown {
  try {
    // HTTP parser errors can inherit status from their error prototype. Read
    // data descriptors only, without invoking arbitrary exception getters.
    let current = error;
    for (let depth = 0; depth < MAX_ERROR_PROTOTYPE_DEPTH && typeof current === "object" && current !== null; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) return descriptor.value;
      current = Object.getPrototypeOf(current) as unknown;
    }
    return undefined;
  } catch { return undefined; }
}

export function classifyFailure(error: unknown): ErrorCategory {
  const organization = organizationErrorHttp(error);
  if (organization) return organization.category;
  const status = field(error, "status");
  if (status === 400 || status === 413) return "VALIDATION_FAILURE";
  const code = field(error, "code");
  if (code === "40001" || code === "40P01") return "DATABASE_CONFLICT";
  return typeof code === "string" && DATABASE_FAILURE_CODES.has(code) ? "DATABASE_FAILURE" : "INTERNAL_FAILURE";
}

export function logRequestFailure(request: Request, response: Response, statusCode: number,
  errorCategory: ErrorCategory, log: StructuredLogger = defaultLogger,
  event: "api_request_failed" | "password_hash_verification_failed" = "api_request_failed"): void {
  try {
    const value: unknown = response.locals.diagnosticRoute;
    const route = SAFE_ROUTES.find((candidate) => candidate === value) ?? "unmatched";
    log.log({ event, requestId: requestId(response), method: request.method, route, statusCode, errorCategory,
      ...(response.headersSent ? { headersSent: true } : {}) });
  } catch {
    // An injected logger or unavailable context must not replace the real failure.
  }
}

export function createErrorHandler(log: StructuredLogger = defaultLogger): ErrorRequestHandler {
  return (error: unknown, request, response, _next) => {
    if (response.headersSent) {
      logRequestFailure(request, response, response.statusCode, classifyFailure(error), log);
      // Match Express's partial-response close behavior without handing the raw
      // exception to its default stack-printing handler or writing a second body.
      response.destroy();
      return;
    }
    const organization = organizationErrorHttp(error);
    if (organization) {
      response.status(organization.status).json({ error: organization.message });
      return;
    }
    const status = field(error, "status");
    response.set("Cache-Control", "no-store");
    if (status === 400 || status === 413) {
      response.status(status).json({ error: status === 413 ? "Request body is too large." : "Invalid JSON body." });
      return;
    }
    logRequestFailure(request, response, 503, classifyFailure(error), log);
    response.status(503).json({ error: "Service is unavailable." });
  };
}
