import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import type { HealthResponse } from "@ledgerflow/shared";
import { getHealth } from "./infrastructure/health.ts";
import type { AuthConfig } from "./modules/auth/config.ts";
import { createAuthRouter } from "./modules/auth/routes.ts";
import type { AuthStore } from "./modules/auth/types.ts";
import { createOrganizationRouter } from "./modules/organizations/routes.ts";
import { OrganizationService } from "./modules/organizations/service.ts";
import { OrganizationError, type OrganizationStore } from "./modules/organizations/types.ts";

interface AppDependencies {
  authStore: AuthStore;
  authConfig: AuthConfig;
  checkDatabase: () => Promise<void>;
  now?: () => Date;
  organizationStore?: OrganizationStore;
}

export function createApp({ authStore, authConfig, checkDatabase, now, organizationStore }: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use("/organizations", (_request, response, next) => {
    // Even parser/origin failures need the same correlation header as audited commands.
    response.set("X-Request-Id", randomUUID());
    next();
  });
  // Forwarded IPs are deliberately untrusted until a deployment defines its proxy boundary.
  app.use(helmet(authConfig.production ? {} : { strictTransportSecurity: false }));
  app.use(cors({ credentials: true,
    origin: (origin, callback) => callback(null, origin === authConfig.webOrigin),
    methods: ["GET", "POST", "PATCH", "OPTIONS"], allowedHeaders: ["Content-Type", "Idempotency-Key"],
    exposedHeaders: ["X-Request-Id"]
  }));
  app.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    const origin = request.get("origin");
    if (origin !== undefined && origin !== authConfig.webOrigin) {
      response.status(403).json({ error: "Origin is not allowed." });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      // CORS alone cannot prevent CSRF. JSON forces preflight; Origin rejects sibling sites.
      if (request.get("sec-fetch-site") === "cross-site") {
        response.status(403).json({ error: "Origin is not allowed." });
        return;
      }
      if (request.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        response.status(415).json({ error: "Content-Type must be application/json." });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: "8kb" }));
  app.use(cookieParser());
  app.get("/health", async (_request, response: express.Response<HealthResponse>) => {
    const health = await getHealth(checkDatabase);
    response.set("Cache-Control", "no-store");
    response.status(health.database === "UP" ? 200 : 503).json(health);
  });
  app.use("/auth", createAuthRouter(authStore, authConfig, now));
  if (organizationStore) {
    app.use("/organizations", createOrganizationRouter(new OrganizationService(organizationStore, now), authStore, authConfig, now));
  }
  const errorHandler: express.ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (response.headersSent) { _next(error); return; }
    if (error instanceof OrganizationError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
    response.set("Cache-Control", "no-store");
    if (status === 400 || status === 413) {
      response.status(status).json({ error: status === 413 ? "Request body is too large." : "Invalid JSON body." });
      return;
    }
    process.stderr.write('{"level":"error","event":"api_request_failed"}\n');
    response.status(503).json({ error: "Service is unavailable." });
  };
  app.use(errorHandler);
  return app;
}
