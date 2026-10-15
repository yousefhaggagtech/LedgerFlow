import express from "express";

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
app.disable("x-powered-by");
app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
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
  server.close((error) => {
    clearTimeout(timeout);
    if (error) {
      process.stderr.write("API server could not shut down cleanly.\n");
      process.exitCode = 1;
    }
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
