import { Migrator, type Kysely } from "kysely";
import * as identityAndTenancy from "./migrations/001_identity_and_tenancy.js";
import * as sessions from "./migrations/002_sessions.js";
import * as organizationManagement from "./migrations/003_organization_management.js";
import * as rbacPermissions from "./migrations/004_rbac_permissions.js";
import * as tenantRelationshipGuards from "./migrations/005_tenant_relationship_guards.js";
import * as idempotencyTombstones from "./migrations/006_idempotency_tombstones.js";

export function createMigrator<Schema>(db: Kysely<Schema>, migrationTableSchema?: string): Migrator {
  // An explicit registry works in compiled ESM on Windows without path-based imports.
  return new Migrator({
    db,
    ...(migrationTableSchema ? { migrationTableSchema } : {}),
    provider: {
      async getMigrations() {
        return { "001_identity_and_tenancy": identityAndTenancy, "002_sessions": sessions,
          "003_organization_management": organizationManagement, "004_rbac_permissions": rbacPermissions,
          "005_tenant_relationship_guards": tenantRelationshipGuards, "006_idempotency_tombstones": idempotencyTombstones };
      }
    }
  });
}
