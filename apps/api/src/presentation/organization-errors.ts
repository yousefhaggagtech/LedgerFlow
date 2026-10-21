import { OrganizationError, type OrganizationErrorCode } from "../modules/organizations/types.ts";
import type { ErrorCategory } from "../infrastructure/logger.ts";

const RESPONSES: Record<OrganizationErrorCode, { status: number; category: ErrorCategory }> = {
  VALIDATION_FAILED: { status: 400, category: "VALIDATION_FAILURE" },
  UNAUTHENTICATED: { status: 401, category: "AUTHENTICATION_FAILURE" },
  PERMISSION_DENIED: { status: 403, category: "AUTHORIZATION_FAILURE" },
  RESOURCE_NOT_FOUND: { status: 404, category: "RESOURCE_NOT_FOUND" },
  BUSINESS_CONFLICT: { status: 409, category: "BUSINESS_CONFLICT" },
  // The adapter already translated these into expected 409s before Phase 4.
  CONCURRENT_CONFLICT: { status: 409, category: "BUSINESS_CONFLICT" }
};

export function organizationErrorHttp(error: unknown) {
  if (!(error instanceof OrganizationError) || !Object.hasOwn(RESPONSES, error.code)) return undefined;
  const mapping = RESPONSES[error.code];
  return { ...mapping, message: error.message };
}
