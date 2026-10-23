"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { useIdentity } from "@/components/identity/identity-provider";
import { ApiAlert } from "@/components/identity/api-alert";
import { MemberManagement } from "@/components/organizations/member-management";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError } from "@/lib/api";
import { isOrganization, type Organization } from "@/lib/identity";
export default function OrganizationSettingsPage() {
  const { organization: access, loadSession, refreshAccess, request } = useIdentity();
  const organizationId = access?.id;
  const router = useRouter();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const version = ++sequence.current;
    setPending(true); setOrganization(null); setError(null);
    try {
      await loadSession();
      if (!organizationId) { router.replace("/organizations"); return; }
      await refreshAccess();
      // Direct navigation still calls the server when capability hints are absent.
      const result = await request(`/organizations/${organizationId}`, isOrganization);
      if (result.id !== organizationId) throw new ApiError(502, "Unexpected organization in settings response.");
      if (version === sequence.current) setOrganization(result);
    } catch (failure) { if (version === sequence.current) setError(failure); }
    finally { if (version === sequence.current) setPending(false); }
  }, [organizationId, loadSession, refreshAccess, request, router]);
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load]);
  return <div className="space-y-8">
    <div className="space-y-2"><p className="text-xs font-medium uppercase tracking-wide text-primary">Organization</p><h1 className="text-2xl font-semibold tracking-tight">Organization settings</h1><p className="text-muted-foreground">Your workspace details and team access.</p></div>
    <ApiAlert error={error} />{pending && <p role="status" className="rounded-lg border bg-card p-6">Loading organization settings...</p>}{error != null && <Button variant="outline" onClick={() => void load()}>Try again</Button>}
    {organization && <Card><CardHeader><div className="mb-2 flex items-center gap-3"><span className="rounded-lg bg-accent p-3 text-primary"><Building2 aria-hidden="true" /></span><CardTitle><h2 className="break-words text-xl">{organization.name}</h2></CardTitle></div><CardDescription>Core details for this organization.</CardDescription></CardHeader>
      <CardContent><dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">{[["Organization name", organization.name], ["Base currency", organization.baseCurrency], ["Accounting timezone", organization.accountingTimezone]].map(([label, value]) => <div key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-2 break-words font-medium">{value}</dd></div>)}<div><dt className="text-xs text-muted-foreground">Status</dt><dd className="mt-2"><Badge variant="secondary">{organization.status === "ACTIVE" ? "Active" : "Suspended"}</Badge></dd></div></dl><p className="mt-6 border-t pt-4 text-xs text-muted-foreground">Each organization uses one base currency. Currency and timezone changes are unavailable.</p></CardContent>
    </Card>}
    {access?.capabilities.includes("member:read") && !pending && <MemberManagement key={access.id} access={access} />}
  </div>;
}
