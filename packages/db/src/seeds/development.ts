import type { Kysely } from "kysely";
import type { Database } from "../schema.js";

export const DEVELOPMENT_USER_EMAIL = "owner@ledgerflow.example";

export async function seedDevelopment(db: Kysely<Database>) {
  return db.transaction().execute(async (trx) => {
    const organization = await trx.insertInto("organizations").values({
      name: "LedgerFlow Test Organization",
      base_currency: "EGP",
      accounting_timezone: "Africa/Cairo"
    }).returning("id").executeTakeFirstOrThrow();

    const user = await trx.insertInto("users").values({
      email: DEVELOPMENT_USER_EMAIL,
      full_name: "Test Owner",
      // Deliberately unusable credential; this seed does not establish authentication.
      password_hash: "!"
    }).returning("id").executeTakeFirstOrThrow();

    const membership = await trx.insertInto("memberships").values({
      organization_id: organization.id,
      user_id: user.id,
      role: "OWNER"
    }).returning("id").executeTakeFirstOrThrow();

    return { organizationId: organization.id, userId: user.id, membershipId: membership.id };
  });
}
