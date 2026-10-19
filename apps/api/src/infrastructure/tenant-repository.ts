import { sql, type SelectQueryBuilder, type UpdateQueryBuilder, type DeleteQueryBuilder } from "kysely";

export function tenantScope(organizationId: string, column: string) {
  if (!organizationId.trim()) throw new Error("Organization scope is required.");
  // Column names come from repository code; tenant values are always parameters.
  return sql<boolean>`${sql.ref(column)} = ${organizationId}`;
}

/** Every query factory requires tenant scope before resource-specific filters. */
export abstract class BaseTenantRepository<Resource extends { organizationId: string }> {
  protected find<DB, Table extends keyof DB, Output>(organizationId: string,
    query: SelectQueryBuilder<DB, Table, Output>, column = "organization_id") {
    return query.where(tenantScope(organizationId, column));
  }

  protected update<DB, UpdatedTable extends keyof DB, Table extends keyof DB, Output>(organizationId: string,
    query: UpdateQueryBuilder<DB, UpdatedTable, Table, Output>, column = "organization_id") {
    return query.where(tenantScope(organizationId, column));
  }

  protected delete<DB, Table extends keyof DB, Output>(organizationId: string,
    query: DeleteQueryBuilder<DB, Table, Output>, column = "organization_id") {
    return query.where(tenantScope(organizationId, column));
  }

  protected ensureOrganization<T extends Resource>(organizationId: string, resource: T): T {
    if (resource.organizationId !== organizationId) throw new Error("Repository returned an invalid organization scope.");
    return resource;
  }
}
