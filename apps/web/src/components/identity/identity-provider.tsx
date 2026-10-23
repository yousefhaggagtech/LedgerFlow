"use client";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "@/lib/api";
import { createAccessRefresh } from "@/lib/access-refresh";
import { isSession, type OrganizationAccess, type User } from "@/lib/identity";
interface IdentityContext {
  user: User | null;
  organization: OrganizationAccess | null;
  selectOrganization: (organization: OrganizationAccess) => void;
  setUser: (user: User) => void;
  clearOrganization: () => void;
  loadSession: () => Promise<User>;
  refreshAccess: () => Promise<void>;
  request: typeof apiRequest;
  logout: () => Promise<void>;
}
const Context = createContext<IdentityContext | null>(null);
export function IdentityProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [organization, setOrganization] = useState<OrganizationAccess | null>(null);
  const access = useMemo(() => createAccessRefresh(apiRequest, setOrganization,
    () => { setUser(null); router.replace("/login"); }), [router]);
  const { request, refresh: refreshAccess, select: selectOrganization } = access;
  const loadSession = useCallback(async () => {
    const session = await request("/auth/me", isSession);
    setUser(session.user);
    return session.user;
  }, [request]);
  const clearOrganization = useCallback(() => { selectOrganization(null); }, [selectOrganization]);
  const logout = useCallback(async () => {
    await request("/auth/logout", (value): value is null => value === null, { method: "POST" });
    setUser(null); selectOrganization(null); router.replace("/login");
  }, [request, router, selectOrganization]);
  const value = useMemo(() => ({ user, organization, selectOrganization, setUser, clearOrganization, loadSession, refreshAccess, request, logout }), [user, organization, selectOrganization, clearOrganization, loadSession, refreshAccess, request, logout]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useIdentity() {
  const identity = useContext(Context);
  if (!identity) throw new Error("Identity provider is missing.");
  return identity;
}
