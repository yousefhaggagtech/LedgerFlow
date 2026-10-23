import { checkDatabaseConnection, createDatabaseFromEnvironment } from "@ledgerflow/db";
import type { Database } from "@ledgerflow/db";
import { createApp } from "./app.ts";
import { PostgresAuthStore } from "./infrastructure/auth-store.ts";
import { startSessionCleanup } from "./infrastructure/session-cleanup.ts";
import { loadAuthConfig } from "./modules/auth/config.ts";
import { expireCreationSnapshots, PostgresOrganizationStore } from "./infrastructure/organization-store.ts";
import { startIdempotencyCleanup } from "./infrastructure/idempotency-cleanup.ts";
import { logger } from "./infrastructure/logger.ts";
import { loadTrustProxy } from "./presentation/proxy-config.ts";

const portValue = process.env.API_PORT;
const host = process.env.API_HOST;
if (!portValue || !/^\d+$/.test(portValue)) {
  throw new Error("API_PORT must be an integer between 1 and 65535.");
}
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT must be an integer between 1 and 65535.");
}
if (!host?.trim()) {
  throw new Error("API_HOST is required.");
}

const authConfig = loadAuthConfig();
const trustProxy = loadTrustProxy();
const db = createDatabaseFromEnvironment<Database>();
const authStore = new PostgresAuthStore(db);
const app = createApp({ authStore, authConfig, trustProxy, organizationStore: new PostgresOrganizationStore(db),
  checkDatabase: () => checkDatabaseConnection(db) });
const stopCleanup = startSessionCleanup(authStore);
const stopIdempotencyCleanup = startIdempotencyCleanup((now) => expireCreationSnapshots(db, now));

const server = app.listen(port, host);
server.once("listening", () => { logger.log({ event: "api_started" }); });
server.on("error", () => {
  logger.log({ event: "api_start_failed", errorCategory: "INTERNAL_FAILURE" });
  process.exitCode = 1;
});

const SHUTDOWN_TIMEOUT_MS = 10_000;
function shutdown(): void {
  const timeout = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  timeout.unref();
  server.close(async (error) => {
    if (error) {
      logger.log({ event: "api_shutdown_failed", errorCategory: "INTERNAL_FAILURE" });
      process.exitCode = 1;
    }
    try {
      await Promise.all([stopCleanup(), stopIdempotencyCleanup()]);
      await db.destroy();
    } catch {
      logger.log({ event: "database_shutdown_failed", errorCategory: "DATABASE_FAILURE" });
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
      if (!process.exitCode) logger.log({ event: "api_stopped" });
    }
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
