import type { AuthStore, AuthUser, SessionKey } from "./types.ts";
import { SESSION_TTL_MS } from "./session-policy.ts";

export interface LoginInput { email: string; password: string }
export interface LoginContext { previousSession: SessionKey | undefined; userAgent: string | null; ipAddress: string | null }
export interface SessionCredential { token: string; key: SessionKey }
export interface LoginResult { user: AuthUser; session: { token: string; expiresAt: Date } }
export interface LoginDependencies {
  store: Pick<AuthStore, "findUserByEmail" | "createSession">;
  verifyPassword: (hash: string | undefined, password: string, onFailure: () => void) => Promise<boolean>;
  issueSession: () => SessionCredential;
  now: () => Date;
}

export function createLogin({ store, verifyPassword, issueSession, now }: LoginDependencies) {
  return async (input: LoginInput, context: LoginContext, onVerificationFailure = () => {}): Promise<LoginResult | undefined> => {
    const user = await store.findUserByEmail(input.email);
    // Verify even absent/inactive users; the injected adapter preserves dummy work.
    const passwordMatches = await verifyPassword(user?.passwordHash, input.password, onVerificationFailure);
    if (!user || !passwordMatches || user.status !== "ACTIVE") return undefined;
    const { token, key } = issueSession();
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
    await store.createSession({ ...key, userId: user.id, createdAt, expiresAt,
      userAgent: context.userAgent, ipAddress: context.ipAddress }, context.previousSession);
    // Token is delivery material for the HTTP-only cookie, never a JSON user field.
    return { user: { id: user.id, email: user.email, fullName: user.fullName }, session: { token, expiresAt } };
  };
}

export type Login = ReturnType<typeof createLogin>;
