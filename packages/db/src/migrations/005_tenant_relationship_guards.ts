import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // The existing polymorphic target stays compatible with old writers. This
  // derived column enables a real FK without rewriting immutable audit history.
  // PostgreSQL 16 rewrites the physical table when adding a stored generated column.
  await sql`ALTER TABLE audit_events ADD COLUMN target_membership_id uuid
    GENERATED ALWAYS AS (CASE WHEN target_type = 'MEMBERSHIP' THEN target_id ELSE NULL END) STORED`.execute(db);
  await db.schema.alterTable("audit_events")
    .addForeignKeyConstraint("audit_events_target_membership_fk", ["organization_id", "target_membership_id"],
      "memberships", ["organization_id", "id"], (fk) => fk.onDelete("restrict").onUpdate("restrict")).execute();
  await db.schema.alterTable("audit_events")
    .addCheckConstraint("audit_events_target_organization_scope", sql`target_type <> 'ORGANIZATION' OR target_id = organization_id`).execute();
  await db.schema.createIndex("audit_events_target_membership_index").on("audit_events")
    .columns(["organization_id", "target_membership_id"]).execute();

  // A completed bootstrap result must belong to its creator's actual membership.
  // Inactive memberships remain valid history; replay separately checks access.
  await db.schema.alterTable("idempotency_records")
    .addForeignKeyConstraint("idempotency_records_membership_fk", ["organization_id", "user_id"],
      "memberships", ["organization_id", "user_id"], (fk) => fk.onDelete("restrict").onUpdate("restrict")).execute();
  await db.schema.alterTable("idempotency_records")
    .addCheckConstraint("idempotency_records_creation_scope", sql`command_type <> 'organization:create' OR (
      response_snapshot #>> '{organization,id}' = organization_id::text
      AND response_snapshot #>> '{membership,organizationId}' = organization_id::text
      AND response_snapshot #>> '{membership,userId}' = user_id::text
    ) IS TRUE`).execute();
  await db.schema.createIndex("idempotency_records_membership_index").on("idempotency_records")
    .columns(["organization_id", "user_id"]).execute();
}

// Removes only derived values and guards; original history and identity rows survive.
// Shared-database rollback weakens isolation and requires explicit approval.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idempotency_records_membership_index").execute();
  await db.schema.alterTable("idempotency_records").dropConstraint("idempotency_records_creation_scope").execute();
  await db.schema.alterTable("idempotency_records").dropConstraint("idempotency_records_membership_fk").execute();
  await db.schema.dropIndex("audit_events_target_membership_index").execute();
  await db.schema.alterTable("audit_events").dropConstraint("audit_events_target_organization_scope").execute();
  await db.schema.alterTable("audit_events").dropConstraint("audit_events_target_membership_fk").execute();
  await db.schema.alterTable("audit_events").dropColumn("target_membership_id").execute();
}
