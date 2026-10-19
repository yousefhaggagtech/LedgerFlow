import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable("permissions")
    .addColumn("id", "uuid", (c) => c.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn("code", "text", (c) => c.notNull().unique())
    .addColumn("description", "text", (c) => c.notNull())
    .addCheckConstraint("permissions_code_format", sql`code ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$'`)
    .addCheckConstraint("permissions_description_not_blank", sql`btrim(description) <> ''`)
    .execute();

  await db.schema.createTable("role_permissions")
    // Roles are enum values, not rows: using the existing type enforces valid roles.
    .addColumn("role", sql`membership_role`, (c) => c.notNull())
    .addColumn("permission_id", "uuid", (c) => c.notNull())
    .addPrimaryKeyConstraint("role_permissions_pkey", ["role", "permission_id"])
    .addForeignKeyConstraint("role_permissions_permission_fk", ["permission_id"], "permissions", ["id"],
      (fk) => fk.onDelete("restrict").onUpdate("restrict"))
    .execute();
  await db.schema.createIndex("role_permissions_permission_index").on("role_permissions").column("permission_id").execute();

  // Seed once with the schema, including production; rerunning migrations cannot restore revoked grants.
  await sql`INSERT INTO permissions (code, description) VALUES
    ('org:create', 'Create an organization through authenticated bootstrap.'),
    ('org:read', 'Read organization settings.'),
    ('member:read', 'List organization memberships.'),
    ('member:invite', 'Add an existing user subject to assignment invariants.'),
    ('member:edit', 'Change a membership role subject to assignment and Owner invariants.')`.execute(db);
  await sql`INSERT INTO role_permissions (role, permission_id)
    SELECT roles.role, p.id FROM permissions p
    CROSS JOIN (VALUES ('OWNER'::membership_role), ('ADMIN'::membership_role)) AS roles(role)
    WHERE p.code IN ('org:read', 'member:read', 'member:invite', 'member:edit')`.execute(db);
}

// Destructive rollback requires approval on shared databases; identity/session data is preserved.
export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("role_permissions").execute();
  await db.schema.dropTable("permissions").execute();
}
