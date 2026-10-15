import express from "express";
import { checkDatabaseConnection, createDatabaseFromEnvironment } from "@ledgerflow/db";
import type { HealthResponse } from "@ledgerflow/shared";
import { getHealth } from "./infrastructure/health.ts";

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

const app = express();
const db = createDatabaseFromEnvironment<Record<string, never>>();
app.disable("x-powered-by");
app.get("/health", async (_request, response: express.Response<HealthResponse>) => {
  const health = await getHealth(() => checkDatabaseConnection(db));
  response.set("Cache-Control", "no-store");
  response.status(health.database === "UP" ? 200 : 503).json(health);
});

const server = app.listen(port, host);
server.on("error", () => {
  process.stderr.write("API server could not start. Check API_HOST and API_PORT.\n");
  process.exitCode = 1;
});

const SHUTDOWN_TIMEOUT_MS = 10_000;
function shutdown(): void {
  const timeout = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
  timeout.unref();
  server.close(async (error) => {
    if (error) {
      process.stderr.write("API server could not shut down cleanly.\n");
      process.exitCode = 1;
    }
    try {
      await db.destroy();
    } catch {
      process.stderr.write("Database pool could not shut down cleanly.\n");
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
    }
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
