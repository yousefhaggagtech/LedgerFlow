import type { AuthUser } from "../modules/auth/types.ts";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      userId?: string;
    }
  }
}
