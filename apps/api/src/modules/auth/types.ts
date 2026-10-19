export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
}

export interface LoginUser extends AuthUser {
  passwordHash: string;
  status: "ACTIVE" | "INACTIVE";
}

export interface SessionKey {
  id: string;
  tokenHash: string;
}

export interface NewSession extends SessionKey {
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  userAgent: string | null;
  ipAddress: string | null;
}

export interface AuthStore {
  findUserByEmail(email: string): Promise<LoginUser | undefined>;
  createSession(session: NewSession, previous: SessionKey | undefined): Promise<void>;
  findSessionUser(key: SessionKey, now: Date): Promise<AuthUser | undefined>;
  deleteSession(key: SessionKey): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<void>;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      userId?: string;
    }
  }
}
