import type { Kysely } from "kysely";
import type { Database } from "@ledgerflow/db";
import type { AuthStore, NewSession, SessionKey } from "../modules/auth/types.ts";

const CLEANUP_BATCH_SIZE = 1_000;

export class PostgresAuthStore implements AuthStore {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  findUserByEmail(email: string) {
    // Identity is global; tenant membership is a separate authorization boundary.
    return this.db.selectFrom("users")
      .select(["id", "email", "full_name as fullName", "password_hash as passwordHash", "status"])
      .where("email", "=", email).executeTakeFirst();
  }

  async createSession(session: NewSession, previous: SessionKey | undefined): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      if (previous) {
        await trx.deleteFrom("sessions").where("id", "=", previous.id)
          .where("token_hash", "=", previous.tokenHash).execute();
      }
      await trx.insertInto("sessions").values({
        id: session.id, token_hash: session.tokenHash, user_id: session.userId,
        created_at: session.createdAt, expires_at: session.expiresAt,
        user_agent: session.userAgent, ip_address: session.ipAddress
      }).execute();
    });
  }

  findSessionUser(key: SessionKey, now: Date) {
    return this.db.selectFrom("sessions as s").innerJoin("users as u", "u.id", "s.user_id")
      .select(["u.id", "u.email", "u.full_name as fullName"])
      .where("s.id", "=", key.id).where("s.token_hash", "=", key.tokenHash)
      .where("s.expires_at", ">", now).where("u.status", "=", "ACTIVE").executeTakeFirst();
  }

  async deleteSession(key: SessionKey): Promise<void> {
    await this.db.deleteFrom("sessions").where("id", "=", key.id)
      .where("token_hash", "=", key.tokenHash).execute();
  }

  async deleteExpiredSessions(now: Date): Promise<void> {
    // Short batches and row locks allow multiple API instances to clean up safely.
    await this.db.deleteFrom("sessions").where("id", "in",
      this.db.selectFrom("sessions").select("id").where("expires_at", "<=", now)
        .orderBy("expires_at").limit(CLEANUP_BATCH_SIZE).forUpdate().skipLocked()
    ).execute();
  }
}
