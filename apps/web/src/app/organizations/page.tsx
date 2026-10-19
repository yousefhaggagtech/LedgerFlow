"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { useIdentity } from "@/components/identity/identity-provider";
import { ApiAlert } from "@/components/identity/api-alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { isAccess, isPage, ROLE_LABELS, type OrganizationAccess, type Page } from "@/lib/identity";
export default function OrganizationSelectionPage() {
  const router = useRouter();
  const { user, loadSession, request, selectOrganization } = useIdentity();
  const [page, setPage] = useState<Page<OrganizationAccess> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    setPending(true); setError(null); setPage(null);
    try {
      await loadSession();
      setPage(await request(`/organizations?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, isPage(isAccess)));
    } catch (failure) { setError(failure); }
    finally { setPending(false); }
  }, [cursor, loadSession, request]);
  useEffect(() => { void load(); }, [load]);
  return <div className="mx-auto max-w-2xl space-y-6">
    <div><p className="mb-2 text-xs font-medium uppercase tracking-wide text-primary">Your workspace</p><h1 className="text-2xl font-semibold tracking-tight">Choose an organization</h1><p className="mt-2 text-muted-foreground">Select the organization you want to manage.</p></div>
    {user && <p className="break-all rounded-md border bg-card p-4 text-xs text-muted-foreground">Your User ID: <span className="font-mono text-foreground">{user.id}</span></p>}
    <ApiAlert error={error} />
    {pending && <p role="status" className="rounded-lg border bg-card p-6">Loading your organizations...</p>}
    {error != null && <Button variant="outline" onClick={() => void load()}>Try again</Button>}
    {page && <>
      {page.items.length === 0 && <Card><CardContent className="space-y-2 py-8"><h2 className="font-semibold">No organizations available</h2><p className="text-muted-foreground">Ask an organization Owner or Admin to add your user ID.</p></CardContent></Card>}
      <ul className="space-y-3">{page.items.map((organization) => <li key={organization.id}>
        <button className="flex w-full items-center gap-4 rounded-lg border bg-card p-5 text-left shadow-xs hover:border-primary focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { selectOrganization(organization); router.push("/settings/organization"); }}>
          <span className="rounded-lg bg-accent p-3 text-primary"><Building2 aria-hidden="true" /></span>
          <span className="min-w-0 flex-1"><span className="block break-words font-semibold">{organization.name}</span><span className="mt-1 block text-sm text-muted-foreground">{ROLE_LABELS[organization.membership.role]}</span></span><span aria-hidden="true">&rarr;</span>
        </button>
      </li>)}</ul>
      <div className="flex gap-3">{cursor && <Button variant="outline" disabled={pending} onClick={() => setCursor(null)}>First page</Button>}{page.nextCursor && <Button variant="outline" disabled={pending} onClick={() => setCursor(page.nextCursor)}>Next page</Button>}</div>
    </>}
  </div>;
}
