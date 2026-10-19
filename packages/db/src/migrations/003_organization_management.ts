import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Audit actors must identify the same membership AND user within the tenant.
  await db.schema.alterTable("memberships")
    .addUniqueConstraint("memberships_audit_actor_unique", ["organization_id", "id", "user_id"]).execute();
  await db.schema.createTable("audit_events")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("organization_id", "uuid", (c) => c.notNull())
    .addColumn("actor_kind", "text", (c) => c.notNull())
    .addColumn("actor_membership_id", "uuid")
    .addColumn("actor_user_id", "uuid")
    .addColumn("action", "text", (c) => c.notNull())
    .addColumn("target_type", "text", (c) => c.notNull())
    .addColumn("target_id", "uuid", (c) => c.notNull())
    .addColumn("occurred_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("correlation_id", "uuid", (c) => c.notNull())
    .addColumn("previous_state", "jsonb")
    .addColumn("new_state", "jsonb", (c) => c.notNull())
    .addForeignKeyConstraint("audit_events_organization_fk", ["organization_id"], "organizations", ["id"],
      (fk) => fk.onDelete("restrict").onUpdate("restrict"))
    .addForeignKeyConstraint("audit_events_actor_fk", ["organization_id", "actor_membership_id", "actor_user_id"],
      "memberships", ["organization_id", "id", "user_id"], (fk) => fk.onDelete("restrict").onUpdate("restrict"))
    .addCheckConstraint("audit_events_actor_valid", sql`(actor_kind = 'HUMAN' AND actor_membership_id IS NOT NULL
      AND actor_user_id IS NOT NULL) OR (actor_kind = 'SYSTEM' AND actor_membership_id IS NULL AND actor_user_id IS NULL)`)
    .addCheckConstraint("audit_events_action_target_valid", sql`(action = 'ORGANIZATION_CREATED' AND target_type = 'ORGANIZATION')
      OR (action IN ('MEMBER_ADDED', 'MEMBER_ROLE_CHANGED') AND target_type = 'MEMBERSHIP')`)
    .addCheckConstraint("audit_events_states_valid", sql`jsonb_typeof(new_state) = 'object'
      AND (previous_state IS NULL OR jsonb_typeof(previous_state) = 'object')`)
    .execute();
  await db.schema.createIndex("audit_events_organization_time_index").on("audit_events")
    .columns(["organization_id", "occurred_at", "id"]).execute();
  await sql`CREATE FUNCTION reject_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Audit events are append-only' USING ERRCODE = '23514'; END;
  $$`.execute(db);
  await sql`CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_event_mutation()`.execute(db);

  // Bootstrap has no tenant yet: scope creation keys by global user and command.
  // Only completed commands are persisted, in the same transaction as their result.
  await db.schema.createTable("idempotency_records")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("user_id", "uuid", (c) => c.notNull())
    .addColumn("organization_id", "uuid", (c) => c.notNull())
    .addColumn("command_type", "varchar(100)", (c) => c.notNull())
    .addColumn("idempotency_key", "varchar(128)", (c) => c.notNull())
    .addColumn("request_hash", "text", (c) => c.notNull())
    .addColumn("response_status", "integer", (c) => c.notNull())
    .addColumn("response_snapshot", "jsonb", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("COMPLETED"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addForeignKeyConstraint("idempotency_records_user_fk", ["user_id"], "users", ["id"],
      (fk) => fk.onDelete("restrict").onUpdate("restrict"))
    .addForeignKeyConstraint("idempotency_records_organization_fk", ["organization_id"], "organizations", ["id"],
      (fk) => fk.onDelete("restrict").onUpdate("restrict"))
    .addUniqueConstraint("idempotency_records_command_unique", ["user_id", "command_type", "idempotency_key"])
    .addCheckConstraint("idempotency_records_key_valid", sql`idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$' AND btrim(command_type) <> ''`)
    .addCheckConstraint("idempotency_records_hash_valid", sql`request_hash ~ '^[0-9a-f]{64}$'`)
    .addCheckConstraint("idempotency_records_result_valid", sql`status = 'COMPLETED' AND response_status BETWEEN 200 AND 299
      AND jsonb_typeof(response_snapshot) = 'object' AND expires_at > created_at`)
    .execute();
  await db.schema.createIndex("idempotency_records_expiry_index").on("idempotency_records").column("expires_at").execute();
}

// Destructive rollback requires approval on shared databases; never drops identity data.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("idempotency_records").execute();
  await db.schema.dropTable("audit_events").execute();
  await sql`DROP FUNCTION reject_audit_event_mutation()`.execute(db);
  await db.schema.alterTable("memberships").dropConstraint("memberships_audit_actor_unique").execute();
}
