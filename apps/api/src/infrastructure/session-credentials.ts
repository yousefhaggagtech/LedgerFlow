import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SessionKey } from "../modules/auth/types.ts";
import type { SessionCredential } from "../modules/auth/login.ts";

const SESSION_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})$/;

export function sessionKey(cookie: unknown): SessionKey | undefined {
  if (typeof cookie !== "string") return undefined;
  const parts = SESSION_PATTERN.exec(cookie);
  if (!parts?.[1] || !parts[2]) return undefined;
  return { id: parts[1], tokenHash: createHash("sha256").update(parts[2]).digest("hex") };
}

export function newSessionToken(): string {
  return `${randomUUID()}.${randomBytes(32).toString("hex")}`;
}

export function issueSessionCredential(): SessionCredential {
  const token = newSessionToken();
  const key = sessionKey(token);
  if (!key) throw new Error("Session token generation failed.");
  return { token, key };
}
