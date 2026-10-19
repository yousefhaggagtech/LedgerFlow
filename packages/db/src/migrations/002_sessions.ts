import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("sessions")
    .addColumn("id", "uuid", (c) => c.primaryKey())
    .addColumn("user_id", "uuid", (c) => c.notNull())
    // The UUID selects the row; only possession of the separate secret authenticates it.
    .addColumn("token_hash", "text", (c) => c.notNull())
    .addColumn("expires_at", "timestamptz", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("user_agent", "varchar(512)")
    .addColumn("ip_address", sql`inet`)
    .addForeignKeyConstraint("sessions_user_fk", ["user_id"], "users", ["id"],
      (fk) => fk.onDelete("restrict").onUpdate("restrict"))
    .addCheckConstraint("sessions_token_hash_format", sql`token_hash ~ '^[0-9a-f]{64}$'`)
    .addCheckConstraint("sessions_expiry_after_creation", sql`expires_at > created_at`)
    .execute();
  await db.schema.createIndex("sessions_expiry_index").on("sessions").column("expires_at").execute();
  await db.schema.createIndex("sessions_user_index").on("sessions").column("user_id").execute();
}

// Destructive rollback: existing sessions are lost. Prefer a forward fix on shared data.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sessions").execute();
}
