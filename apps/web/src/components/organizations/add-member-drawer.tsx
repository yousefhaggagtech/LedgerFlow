"use client";
import { useRef, useState, type FormEvent } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiAlert } from "@/components/identity/api-alert";
import { ROLE_LABELS, UUID_PATTERN, assignableRoles, isRole, type OrganizationAccess, type Role } from "@/lib/identity";
export function AddMemberDrawer({ access, disabled, onAdd }: { access: OrganizationAccess; disabled: boolean; onAdd: (userId: string, role: Role) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fields, setFields] = useState({ userId: "", role: "" });
  const input = useRef<HTMLInputElement>(null);
  const roleInput = useRef<HTMLSelectElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending || disabled) return;
    const next = { userId: UUID_PATTERN.test(userId.trim()) ? "" : "Enter a valid User UUID.", role: isRole(role) && assignableRoles(access.membership.role).includes(role) ? "" : "Choose a role." };
    setFields(next); setError(null);
    if (next.userId) { input.current?.focus(); return; }
    if (next.role || !isRole(role)) { roleInput.current?.focus(); return; }
    setPending(true);
    try { await onAdd(userId.trim().toLowerCase(), role); setOpen(false); setUserId(""); setRole(""); }
    catch (failure) { setError(failure); }
    finally { setPending(false); }
  }
  return <Sheet open={open} onOpenChange={(value) => { if (!pending) { setOpen(value); setError(null); setFields({ userId: "", role: "" }); } }}>
    {access.capabilities.includes("member:invite") && assignableRoles(access.membership.role).length > 0 &&
      <SheetTrigger asChild><Button disabled={disabled}>Add member</Button></SheetTrigger>}
    <SheetContent width="form" className="overflow-y-auto p-6" onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }} onPointerDownOutside={(event) => { if (pending) event.preventDefault(); }}>
      <SheetTitle className="pr-8 text-xl">Add member</SheetTitle><SheetDescription>Add an existing user directly to <strong className="break-words">{access.name}</strong>. No email invitation is sent.</SheetDescription>
      <form className="mt-4 space-y-5" onSubmit={submit} noValidate aria-busy={pending}>
        <ApiAlert error={error} />
        <div className="space-y-2"><label htmlFor="member-user-id" className="font-medium">User UUID</label><Input ref={input} id="member-user-id" value={userId} onChange={(event) => setUserId(event.target.value)} disabled={pending || disabled} required autoComplete="off" maxLength={36} aria-invalid={!!fields.userId} aria-describedby="member-user-help member-user-error" />
          <p id="member-user-help" className="text-xs text-muted-foreground">Ask the user for the ID shown on their organization-selection page.</p><p id="member-user-error" className="text-sm">{fields.userId}</p></div>
        <div className="space-y-2"><label htmlFor="member-role" className="font-medium">Role</label><Select ref={roleInput} id="member-role" value={role} onChange={(event) => setRole(event.target.value)} disabled={pending || disabled} required aria-invalid={!!fields.role} aria-describedby="member-role-error"><option value="" disabled>Choose a role</option>{assignableRoles(access.membership.role).map((item) => <option key={item} value={item}>{ROLE_LABELS[item]}</option>)}</Select><p id="member-role-error" className="text-sm">{fields.role}</p></div>
        <Button type="submit" className="w-full" disabled={pending || disabled}>{pending ? "Adding member..." : "Add member"}</Button>
        <p role="status" className="text-xs text-muted-foreground">{pending ? "Saving membership. Please wait." : disabled ? "Refresh organization access before making another change." : "The server verifies your current permissions when you submit."}</p>
      </form>
    </SheetContent>
  </Sheet>;
}
