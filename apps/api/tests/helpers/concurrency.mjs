import { setImmediate as yieldTurn } from "node:timers/promises";
import { sql } from "kysely";

const WAIT_TIMEOUT_MS = 2_000;

export async function within(pending, label) {
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), WAIT_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

// The test cluster/role is dedicated and migration files run sequentially.
// Observe PostgreSQL lock waits instead of assuming concurrent HTTP dispatch overlaps.
export async function waitForLockWaiters(db, expected) {
  const deadline = performance.now() + WAIT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const result = await sql`SELECT count(*) AS count FROM pg_stat_activity
      WHERE datname = current_database() AND usename = current_user
        AND pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'`.execute(db);
    if (Number(result.rows[0].count) >= expected) return;
    await yieldTurn();
  }
  throw new Error(`Timed out observing ${expected} PostgreSQL lock waiters`);
}

export function observeAuthorization(store, observe) {
  return { transaction: (context, work) => store.transaction(context, (transaction) => work(new Proxy(transaction, {
    get(instance, key) {
      if (key === "findAuthorization") return async (organizationId, userId) => {
        const result = await instance.findAuthorization(organizationId, userId);
        observe(organizationId, userId);
        return result;
      };
      const value = Reflect.get(instance, key);
      return typeof value === "function" ? value.bind(instance) : value;
    }
  }))) };
}
