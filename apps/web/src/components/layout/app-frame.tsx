"use client";
import { useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Layout } from "./app-shell";
import { useIdentity } from "@/components/identity/identity-provider";
import { ApiAlert } from "@/components/identity/api-alert";
export function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, organization, clearOrganization, logout } = useIdentity();
  const [error, setError] = useState<unknown>(null);
  if (pathname === "/login") return children;
  return <Layout key={pathname} section={pathname.startsWith("/settings") ? "Settings" : pathname === "/organizations" ? "Organizations" : "Sales"}
    settingsHref={organization ? "/settings/organization" : "/organizations"}
    onSettings={() => router.push(organization ? "/settings/organization" : "/organizations")}
    {...(user || pathname !== "/" ? { identity: { name: user?.fullName ?? "Account", organizationName: organization?.name ?? "Select an organization",
      onSwitch: () => { clearOrganization(); router.push("/organizations"); },
      onLogout: () => { setError(null); void logout().catch(setError); } } } : {})}>
    <ApiAlert error={error} />{children}
  </Layout>;
}
