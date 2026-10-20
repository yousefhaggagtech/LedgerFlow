import { sql, type SelectQueryBuilder, type UpdateQueryBuilder, type DeleteQueryBuilder } from "kysely";

export function tenantScope(organizationId: string, column: string) {
  if (!organizationId.trim()) throw new Error("Organization scope is required.");
  // Column names come from repository code; tenant values are always parameters.
  return sql<boolean>`${sql.ref(column)} = ${organizationId}`;
}

/** Every query factory requires tenant scope before resource-specific filters. */
export abstract class BaseTenantRepository<Resource extends { organizationId: string }> {
  readonly #organizationId: string;
  readonly #userId: string;

  // Only infrastructure factories construct repositories, after checking membership
  // or creating a new organization in the authenticated user's transaction.
  protected constructor(context: { readonly organizationId: string; readonly userId: string }) {
    if (!context.organizationId.trim() || !context.userId.trim()) throw new Error("Authenticated tenant context is required.");
    this.#organizationId = context.organizationId;
    this.#userId = context.userId;
  }

  protected get organizationId(): string { return this.#organizationId; }
  protected get actorUserId(): string { return this.#userId; }

  protected scope(column: string) { return tenantScope(this.#organizationId, column); }

  protected find<DB, Table extends keyof DB, Output>(
    query: SelectQueryBuilder<DB, Table, Output>, column = "organization_id") {
    return query.where(this.scope(column));
  }

  protected update<DB, UpdatedTable extends keyof DB, Table extends keyof DB, Output>(
    query: UpdateQueryBuilder<DB, UpdatedTable, Table, Output>, column = "organization_id") {
    return query.where(this.scope(column));
  }

  protected delete<DB, Table extends keyof DB, Output>(
    query: DeleteQueryBuilder<DB, Table, Output>, column = "organization_id") {
    return query.where(this.scope(column));
  }

  protected insertValues<T extends object>(values: T & { organization_id?: never }): T & { organization_id: string } {
    if ("organization_id" in values) throw new Error("Organization scope cannot be supplied in insert values.");
    return { ...values, organization_id: this.#organizationId };
  }

  protected ensureOrganization<T extends Resource>(resource: T): T {
    if (resource.organizationId !== this.#organizationId) throw new Error("Repository returned an invalid organization scope.");
    return resource;
  }
}
