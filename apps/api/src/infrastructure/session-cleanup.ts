import type { AuthStore } from "../modules/auth/types.ts";
import { SESSION_CLEANUP_INTERVAL_MS } from "../modules/auth/config.ts";

export function startSessionCleanup(store: AuthStore): () => Promise<void> {
  let pending: Promise<void> | undefined;
  function run(): void {
    if (pending) return;
    pending = store.deleteExpiredSessions(new Date()).catch(() => {
      process.stderr.write('{"level":"error","event":"session_cleanup_failed"}\n');
    }).finally(() => { pending = undefined; });
  }
  const timer = setInterval(run, SESSION_CLEANUP_INTERVAL_MS);
  timer.unref();
  run();
  return async () => { clearInterval(timer); await pending; };
}
