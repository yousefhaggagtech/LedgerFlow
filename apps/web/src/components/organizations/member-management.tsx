"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useIdentity } from "@/components/identity/identity-provider";
import { ApiAlert } from "@/components/identity/api-alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AddMemberDrawer } from "./add-member-drawer";
import { ApiError } from "@/lib/api";
import { ROLE_LABELS, assignableRoles, canEditMember, isMember, isPage, isRole, type Membership, type OrganizationAccess, type Page, type Role } from "@/lib/identity";
export function MemberManagement({ access }: { access: OrganizationAccess }) {
  const { request, clearOrganization } = useIdentity();
  const router = useRouter();
  const [page, setPage] = useState<Page<Membership> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  const load = useCallback(async (after: string | null) => {
    const version = ++sequence.current;
    setPending(true); setPage(null); setError(null);
    try {
      const result = await request(`/organizations/${access.id}/members?limit=25${after ? `&cursor=${encodeURIComponent(after)}` : ""}`, isPage(isMember));
      if (version !== sequence.current) return false;
      if (result.items.some((member) => member.organizationId !== access.id)) throw new ApiError(502, "Unexpected organization in member response.");
      setPage(result); return true;
    } catch (failure) { if (version === sequence.current) setError(failure); return false; }
    finally { if (version === sequence.current) setPending(false); }
  }, [access.id, request]);
  useEffect(() => { void load(cursor); return () => { sequence.current++; }; }, [cursor, load]);
  async function mutate(userId: string, role: Role, method: "POST" | "PATCH") {
    setBusy(true); setError(null); setNotice("");
    try {
      const member = await request(`/organizations/${access.id}/members${method === "PATCH" ? `/${userId}` : ""}`, isMember,
        { method, body: JSON.stringify(method === "PATCH" ? { role } : { userId, role }) });
      if (member.organizationId !== access.id) throw new ApiError(502, "Unexpected organization in member response.");
      setNotice(`${method === "POST" ? "Member added" : "Role updated"}: ${member.userId} | ${ROLE_LABELS[member.role]} | ${member.status}.`);
      if (member.userId === access.membership.userId && method === "PATCH") {
        clearOrganization(); router.replace("/organizations"); return;
      }
      if (cursor === null) await load(null); else setCursor(null);
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 403 ||
          (failure.status === 404 && failure.message === "Organization not found."))) setDenied(true);
      // Conflicts and uncertain writes must reload committed state before a manual retry.
      if (failure instanceof ApiError && [0, 409, 502, 503].includes(failure.status)) {
        if (!await load(cursor)) setDenied(true);
      }
      setError(failure); throw failure;
    } finally { setBusy(false); }
  }
  const editableRoles = assignableRoles(access.membership.role);
  return <Card>
    <CardHeader className="flex flex-wrap items-start justify-between gap-4 sm:flex-row"><div className="space-y-2"><CardTitle><h2>Members</h2></CardTitle><CardDescription>Manage roles and access for {access.name}.</CardDescription></div>
      {access.capabilities.includes("member:invite") && editableRoles.length > 0 && <AddMemberDrawer access={access} disabled={busy || denied || pending || !page} onAdd={(id, role) => mutate(id, role, "POST")} />}
    </CardHeader>
    <CardContent className="space-y-4">
      <ApiAlert error={error} /><p role="status" className="break-words text-sm text-muted-foreground">{notice}</p>
      {pending && <p role="status">Loading members...</p>}
      {error != null && <Button variant="outline" disabled={busy || pending} onClick={() => void load(cursor)}>Refresh members</Button>}
      {denied && <p className="text-sm text-muted-foreground">Changes are paused. Switch organization to reload your access.</p>}
      {page && <>
        {page.items.length === 0 ? <div className="rounded-md border bg-muted p-5"><p>{cursor ? "No members on this page. Return to the first page." : "The organization membership list is unexpectedly empty. Refresh or contact an administrator."}</p></div> :
          <div className="overflow-x-auto"><table role="table" className="block w-full text-left text-sm md:table"><caption className="sr-only">Organization members, roles, and membership status</caption><thead role="rowgroup" className="sr-only border-b text-xs text-muted-foreground md:not-sr-only md:table-header-group"><tr><th scope="col" className="px-3 py-3 font-medium">User</th><th scope="col" className="px-3 py-3 font-medium">Role</th><th scope="col" className="px-3 py-3 font-medium">Status</th><th scope="col" className="px-3 py-3 font-medium">Change role</th></tr></thead>
            <tbody role="rowgroup" className="block divide-y md:table-row-group">{page.items.map((member) => <tr role="row" key={member.userId} className="grid grid-cols-2 gap-4 py-5 md:table-row md:py-0">
              <th role="rowheader" scope="row" className="col-span-2 min-w-0 px-1 font-normal md:px-3 md:py-4"><span className="block break-all font-mono text-xs">{member.userId}</span>{member.userId === access.membership.userId && <span className="mt-1 block text-xs font-medium text-primary">You</span>}</th>
              <td role="cell" className="px-1 md:px-3 md:py-4"><span className="mb-1 block text-xs text-muted-foreground md:hidden">Role</span>{ROLE_LABELS[member.role]}</td><td role="cell" className="px-1 md:px-3 md:py-4"><span className="mb-1 block text-xs text-muted-foreground md:hidden">Status</span><Badge variant="secondary">{member.status === "ACTIVE" ? "Active" : "Inactive"}</Badge></td>
              <td role="cell" className="col-span-2 min-w-0 px-1 md:px-3 md:py-4"><span className="mb-1 block text-xs text-muted-foreground md:hidden">Change role</span>{canEditMember(access, member) ? <Select aria-label={`Change role for ${member.userId}`} value={member.role} disabled={busy || denied || pending} onChange={(event) => { const role = event.target.value; if (isRole(role) && role !== member.role) void mutate(member.userId, role, "PATCH").catch(() => { /* The shared alert reports the failure. */ }); }}>{editableRoles.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</Select> : <span className="text-muted-foreground">Unavailable</span>}</td>
            </tr>)}</tbody>
          </table></div>}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4"><p className="text-xs text-muted-foreground">{page.items.length} members on this page</p><div className="flex gap-2">{cursor && <Button variant="outline" disabled={pending || busy} onClick={() => setCursor(null)}>First page</Button>}{page.nextCursor && <Button variant="outline" disabled={pending || busy} onClick={() => setCursor(page.nextCursor)}>Next page</Button>}</div></div>
      </>}
    </CardContent>
  </Card>;
}
