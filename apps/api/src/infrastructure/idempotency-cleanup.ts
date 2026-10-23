import { logger as defaultLogger, type StructuredLogger } from "./logger.ts";

export const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 5 * 60 * 1_000;

export function startIdempotencyCleanup(compact: (now: Date) => Promise<void>, logger: StructuredLogger = defaultLogger): () => Promise<void> {
  let pending: Promise<void> | undefined;
  function run(): void {
    if (pending) return;
    pending = Promise.resolve().then(() => compact(new Date())).catch(() => {
      logger.log({ event: "idempotency_cleanup_failed", errorCategory: "DATABASE_FAILURE" });
    }).finally(() => { pending = undefined; });
  }
  const timer = setInterval(run, IDEMPOTENCY_CLEANUP_INTERVAL_MS);
  timer.unref();
  run();
  return async () => { clearInterval(timer); await pending; };
}
