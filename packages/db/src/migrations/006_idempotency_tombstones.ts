import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("idempotency_records").dropConstraint("idempotency_records_result_valid").execute();
  await db.schema.alterTable("idempotency_records").dropConstraint("idempotency_records_creation_scope").execute();
  await db.schema.alterTable("idempotency_records").alterColumn("response_status", (c) => c.dropNotNull()).execute();
  await db.schema.alterTable("idempotency_records").alterColumn("response_snapshot", (c) => c.dropNotNull()).execute();
  await db.schema.alterTable("idempotency_records")
    .addCheckConstraint("idempotency_records_result_valid", sql`expires_at > created_at AND (
      (status = 'COMPLETED' AND response_status BETWEEN 200 AND 299 AND jsonb_typeof(response_snapshot) = 'object')
      OR (status = 'EXPIRED' AND response_status IS NULL AND response_snapshot IS NULL)
    ) IS TRUE`).execute();
  await db.schema.alterTable("idempotency_records")
    .addCheckConstraint("idempotency_records_creation_scope", sql`command_type <> 'organization:create' OR status = 'EXPIRED' OR (
      response_snapshot #>> '{organization,id}' = organization_id::text
      AND response_snapshot #>> '{membership,organizationId}' = organization_id::text
      AND response_snapshot #>> '{membership,userId}' = user_id::text
    ) IS TRUE`).execute();
  // Compacted keys remain unique forever without occupying the hot cleanup index.
  await sql`CREATE INDEX idempotency_records_completed_expiry_index ON idempotency_records (expires_at, id)
    WHERE status = 'COMPLETED'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Never release keys or invent historical responses to make rollback possible.
  await sql`LOCK TABLE idempotency_records IN ACCESS EXCLUSIVE MODE`.execute(db);
  await sql`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM idempotency_records WHERE status = 'EXPIRED') THEN
      RAISE EXCEPTION 'Cannot roll back idempotency tombstones while EXPIRED records exist' USING ERRCODE = '55000';
    END IF;
  END $$`.execute(db);
  await db.schema.dropIndex("idempotency_records_completed_expiry_index").execute();
  await db.schema.alterTable("idempotency_records").dropConstraint("idempotency_records_result_valid").execute();
  await db.schema.alterTable("idempotency_records").dropConstraint("idempotency_records_creation_scope").execute();
  await db.schema.alterTable("idempotency_records").alterColumn("response_status", (c) => c.setNotNull()).execute();
  await db.schema.alterTable("idempotency_records").alterColumn("response_snapshot", (c) => c.setNotNull()).execute();
  await db.schema.alterTable("idempotency_records")
    .addCheckConstraint("idempotency_records_result_valid", sql`status = 'COMPLETED' AND response_status BETWEEN 200 AND 299
      AND jsonb_typeof(response_snapshot) = 'object' AND expires_at > created_at`).execute();
  await db.schema.alterTable("idempotency_records")
    .addCheckConstraint("idempotency_records_creation_scope", sql`command_type <> 'organization:create' OR (
      response_snapshot #>> '{organization,id}' = organization_id::text
      AND response_snapshot #>> '{membership,organizationId}' = organization_id::text
      AND response_snapshot #>> '{membership,userId}' = user_id::text
    ) IS TRUE`).execute();
}
