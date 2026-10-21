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
import type { OrganizationStore } from "./modules/organizations/types.ts";
import { logger as defaultLogger, type StructuredLogger } from "./infrastructure/logger.ts";
import { correlateRequest, createErrorHandler, identifyRoute, logRequestFailure } from "./presentation/request-diagnostics.ts";
import { createLogin } from "./modules/auth/login.ts";
import { verifyPassword } from "./modules/auth/password.ts";
import { issueSessionCredential } from "./infrastructure/session-credentials.ts";

interface AppDependencies {
  authStore: AuthStore;
  authConfig: AuthConfig;
  checkDatabase: () => Promise<void>;
  now?: () => Date;
  organizationStore?: OrganizationStore;
  logger?: StructuredLogger;
}

export function createApp({ authStore, authConfig, checkDatabase, now, organizationStore, logger = defaultLogger }: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.use(correlateRequest);
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
  app.get("/health", identifyRoute("/health"), async (request, response: express.Response<HealthResponse>) => {
    const health = await getHealth(async () => {
      try { await checkDatabase(); }
      catch (error: unknown) {
        logRequestFailure(request, response, 503, "DATABASE_FAILURE", logger);
        throw error;
      }
    });
    response.set("Cache-Control", "no-store");
    response.status(health.database === "UP" ? 200 : 503).json(health);
  });
  const login = createLogin({ store: authStore, verifyPassword, issueSession: issueSessionCredential,
    now: now ?? (() => new Date()) });
  app.use("/auth", createAuthRouter(authStore, authConfig, login, now, logger));
  if (organizationStore) {
    app.use("/organizations", createOrganizationRouter(new OrganizationService(organizationStore, now), authStore, authConfig, now));
  }
  app.use(createErrorHandler(logger));
  return app;
}
