import type { AuthStore } from "../modules/auth/types.ts";
import { SESSION_CLEANUP_INTERVAL_MS } from "../modules/auth/session-policy.ts";
import { logger as defaultLogger, type StructuredLogger } from "./logger.ts";

export function startSessionCleanup(store: AuthStore, logger: StructuredLogger = defaultLogger): () => Promise<void> {
  let pending: Promise<void> | undefined;
  function run(): void {
    if (pending) return;
    pending = store.deleteExpiredSessions(new Date()).catch(() => {
      logger.log({ event: "session_cleanup_failed", errorCategory: "DATABASE_FAILURE" });
    }).finally(() => { pending = undefined; });
  }
  const timer = setInterval(run, SESSION_CLEANUP_INTERVAL_MS);
  timer.unref();
  run();
  return async () => { clearInterval(timer); await pending; };
}
