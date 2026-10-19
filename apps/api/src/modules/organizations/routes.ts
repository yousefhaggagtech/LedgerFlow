import { Router, type Request, type Response } from "express";
import type { AuthConfig } from "../auth/config.ts";
import { authenticate } from "../auth/session.ts";
import type { AuthStore } from "../auth/types.ts";
import type { OrganizationService } from "./service.ts";
import { OrganizationError, type Actor } from "./types.ts";
import { creationInput, identifier, idempotencyKey, memberInput, organizationPageInput, pageInput, roleInput } from "./validation.ts";

function actor(request: Request, response: Response): Actor {
  if (!request.userId) throw new OrganizationError(401, "Unauthorized");
  const correlationId = response.get("X-Request-Id");
  if (!correlationId) throw new Error("Request correlation is missing.");
  return { userId: request.userId, correlationId };
}

export function createOrganizationRouter(service: OrganizationService, store: AuthStore, config: AuthConfig,
  now?: () => Date): Router {
  const router = Router();
  router.use(authenticate(store, config, now));
  router.get("/", async (request, response) => {
    response.json(await service.list(actor(request, response).userId, organizationPageInput(request.query)));
  });
  router.post("/", async (request, response) => {
    const result = await service.create(actor(request, response), creationInput(request.body), idempotencyKey(request.get("Idempotency-Key")));
    response.status(201).json(result);
  });
  router.get("/:id", async (request, response) => {
    response.json(await service.get(identifier(request.params.id), actor(request, response).userId));
  });
  router.get("/:id/members", async (request, response) => {
    const organizationId = identifier(request.params.id);
    response.json(await service.members(organizationId, actor(request, response).userId, pageInput(request.query, organizationId)));
  });
  router.post("/:id/members", async (request, response) => {
    response.status(201).json(await service.add(identifier(request.params.id), actor(request, response), memberInput(request.body)));
  });
  router.patch("/:id/members/:userId", async (request, response) => {
    response.json(await service.changeRole(identifier(request.params.id), actor(request, response),
      identifier(request.params.userId), roleInput(request.body)));
  });
  return router;
}
