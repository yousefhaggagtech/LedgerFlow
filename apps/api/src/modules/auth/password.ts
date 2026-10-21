import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";

// Identical work for unknown users, inactive accounts, and the unusable development seed.
const dummyHash = await argon2.hash(randomBytes(32), { type: argon2.argon2id });

export async function verifyPassword(storedHash: string | undefined, password: string, onFailure: () => void = () => {}): Promise<boolean> {
  const supported = storedHash?.startsWith("$argon2id$") === true;
  const hash = supported && storedHash ? storedHash : dummyHash;
  try {
    const valid = await argon2.verify(hash, password);
    return supported && valid;
  } catch {
    // Malformed persisted credentials cannot authenticate; do not expose the hash.
    try { onFailure(); } catch { /* Diagnostics must not bypass dummy verification. */ }
    await argon2.verify(dummyHash, password);
    return false;
  }
}
