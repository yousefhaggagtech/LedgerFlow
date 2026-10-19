"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiRequest } from "@/lib/api";
import { isSession, type OrganizationAccess, type User } from "@/lib/identity";
interface IdentityContext {
  user: User | null;
  organization: OrganizationAccess | null;
  selectOrganization: (organization: OrganizationAccess) => void;
  setUser: (user: User) => void;
  clearOrganization: () => void;
  loadSession: () => Promise<User>;
  request: typeof apiRequest;
  logout: () => Promise<void>;
}
const Context = createContext<IdentityContext | null>(null);
export function IdentityProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [organization, selectOrganization] = useState<OrganizationAccess | null>(null);
  const request: typeof apiRequest = useCallback(async (path, guard, init) => {
    try { return await apiRequest(path, guard, init); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) { setUser(null); selectOrganization(null); router.replace("/login"); }
      throw error;
    }
  }, [router]);
  const loadSession = useCallback(async () => {
    const session = await request("/auth/me", isSession);
    setUser(session.user);
    return session.user;
  }, [request]);
  const clearOrganization = useCallback(() => { selectOrganization(null); }, []);
  const logout = useCallback(async () => {
    await apiRequest("/auth/logout", (value): value is null => value === null, { method: "POST" });
    setUser(null); selectOrganization(null); router.replace("/login");
  }, [router]);
  const value = useMemo(() => ({ user, organization, selectOrganization, setUser, clearOrganization, loadSession, request, logout }), [user, organization, clearOrganization, loadSession, request, logout]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useIdentity() {
  const identity = useContext(Context);
  if (!identity) throw new Error("Identity provider is missing.");
  return identity;
}
