import { sql, type Kysely } from "kysely";

// Migration definitions stay independent of the evolving application schema.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createType("organization_status").asEnum(["ACTIVE", "SUSPENDED"]).execute();
  await db.schema.createType("user_status").asEnum(["ACTIVE", "INACTIVE"]).execute();
  await db.schema.createType("membership_status").asEnum(["ACTIVE", "INACTIVE"]).execute();
  await db.schema.createType("membership_role")
    .asEnum(["OWNER", "ADMIN", "ACCOUNTANT", "FINANCE_MEMBER", "VIEWER"]).execute();

  await db.schema.createTable("organizations")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("name", "text", (c) => c.notNull())
    .addColumn("base_currency", "text", (c) => c.notNull())
    .addColumn("status", sql`organization_status`, (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("accounting_timezone", "text", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addCheckConstraint("organizations_name_not_blank", sql`btrim(name) <> ''`)
    .addCheckConstraint("organizations_currency_format", sql`base_currency ~ '^[A-Z]{3}$'`)
    .addCheckConstraint("organizations_timezone_not_blank", sql`btrim(accounting_timezone) <> ''`)
    .execute();

  await db.schema.createTable("users")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("email", "text", (c) => c.notNull())
    .addColumn("password_hash", "text", (c) => c.notNull())
    .addColumn("full_name", "text", (c) => c.notNull())
    .addColumn("status", sql`user_status`, (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint("users_email_unique", ["email"])
    .addCheckConstraint("users_email_not_blank", sql`btrim(email) <> ''`)
    .addCheckConstraint("users_password_hash_not_blank", sql`btrim(password_hash) <> ''`)
    .addCheckConstraint("users_full_name_not_blank", sql`btrim(full_name) <> ''`)
    .execute();

  await db.schema.createTable("memberships")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("organization_id", "uuid", (c) => c.notNull())
    .addColumn("user_id", "uuid", (c) => c.notNull())
    .addColumn("role", sql`membership_role`, (c) => c.notNull())
    .addColumn("status", sql`membership_status`, (c) => c.notNull().defaultTo("ACTIVE"))
    .addColumn("created_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn("updated_at", "timestamptz", (c) => c.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint("memberships_organization_fk", ["organization_id"], "organizations", ["id"],
      (fk) => fk.onDelete("restrict").onUpdate("restrict"))
    .addForeignKeyConstraint("memberships_user_fk", ["user_id"], "users", ["id"],
      (fk) => fk.onDelete("restrict").onUpdate("restrict"))
    .addUniqueConstraint("memberships_organization_user_unique", ["organization_id", "user_id"])
    // Future tenant-owned actor references must target (organization_id, id).
    .addUniqueConstraint("memberships_organization_id_unique", ["organization_id", "id"])
    .execute();

  await db.schema.createIndex("memberships_user_id_index").on("memberships").column("user_id").execute();
  // Both composite unique indexes already support lookups by organization_id.
}

// Destructive rollback: only use on an empty/disposable database after approval.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("memberships").execute();
  await db.schema.dropTable("users").execute();
  await db.schema.dropTable("organizations").execute();
  await db.schema.dropType("membership_role").execute();
  await db.schema.dropType("membership_status").execute();
  await db.schema.dropType("user_status").execute();
  await db.schema.dropType("organization_status").execute();
}
