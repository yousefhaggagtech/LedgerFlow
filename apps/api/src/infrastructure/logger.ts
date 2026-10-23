export const ERROR_CATEGORIES = ["VALIDATION_FAILURE", "AUTHENTICATION_FAILURE", "AUTHORIZATION_FAILURE",
  "RESOURCE_NOT_FOUND", "BUSINESS_CONFLICT", "DATABASE_CONFLICT", "DATABASE_FAILURE", "INTERNAL_FAILURE"] as const;
export type ErrorCategory = typeof ERROR_CATEGORIES[number];
export const SAFE_ROUTES = ["unmatched", "organizations_authentication", "/health", "/auth/login", "/auth/logout", "/auth/me",
  "/organizations", "/organizations/:id", "/organizations/:id/access", "/organizations/:id/members", "/organizations/:id/members/:userId"] as const;
export type SafeRoute = typeof SAFE_ROUTES[number];

const LEVELS = {
  api_request_failed: "error", password_hash_verification_failed: "warn", session_cleanup_failed: "error", idempotency_cleanup_failed: "error",
  api_start_failed: "error", api_shutdown_failed: "error", database_shutdown_failed: "error",
  api_started: "info", api_stopped: "info"
} as const;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"]);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_EVENT_BYTES = 2_048;
type HttpEvent = { event: "api_request_failed" | "password_hash_verification_failed"; requestId: string;
  method: string; route: SafeRoute; statusCode: number; errorCategory: ErrorCategory; headersSent?: boolean };
type ProcessEvent = { event: Exclude<keyof typeof LEVELS, HttpEvent["event"]>; errorCategory?: ErrorCategory };
type Write = (line: string) => void | Promise<void>;

// A broken standard stream must not turn best-effort diagnostics into an uncaught
// asynchronous EPIPE. Do not recursively log transport errors or retry indefinitely.
process.stderr.on("error", () => {});
process.stdout.on("error", () => {});

export function createLogger({ stderr = (line: string): void => { process.stderr.write(line, () => {}); },
  stdout = (line: string): void => { process.stdout.write(line, () => {}); }, now = () => new Date()
}: { stderr?: Write; stdout?: Write; now?: () => Date } = {}) {
  return {
    log(input: HttpEvent | ProcessEvent): void {
      try {
        if (typeof input.event !== "string" || !Object.hasOwn(LEVELS, input.event)) return;
        const level = LEVELS[input.event];
        const common = { timestamp: now().toISOString(), level, event: input.event };
        const errorCategory = ERROR_CATEGORIES.includes(input.errorCategory ?? "INTERNAL_FAILURE")
          ? input.errorCategory ?? "INTERNAL_FAILURE" : "INTERNAL_FAILURE";
        let line: string;
        if ("requestId" in input) {
          // Rebuild from primitives; never spread input, error, request, or context.
          line = JSON.stringify({ ...common, requestId: typeof input.requestId === "string" && REQUEST_ID.test(input.requestId) ? input.requestId : "unavailable",
            method: METHODS.has(input.method) ? input.method : "OTHER",
            route: SAFE_ROUTES.includes(input.route) ? input.route : "unmatched",
            statusCode: Number.isInteger(input.statusCode) && input.statusCode >= 100 && input.statusCode <= 599 ? input.statusCode : 500,
            errorCategory, ...(input.headersSent === true ? { headersSent: true } : {}) }) + "\n";
        } else {
          line = JSON.stringify({ ...common, ...(level === "info" ? {} : { errorCategory }) }) + "\n";
        }
        if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) return;
        const pending = (level === "info" ? stdout : stderr)(line);
        if (pending) void pending.catch(() => {});
      } catch {
        // Serialization/clock/synchronous transport failures cannot affect callers.
      }
    }
  };
}

export type StructuredLogger = ReturnType<typeof createLogger>;
export const logger = createLogger();
