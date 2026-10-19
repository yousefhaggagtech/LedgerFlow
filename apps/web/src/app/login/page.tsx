"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Wallet } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiAlert } from "@/components/identity/api-alert";
import { useIdentity } from "@/components/identity/identity-provider";
import { apiRequest } from "@/lib/api";
import { isSession } from "@/lib/identity";
export default function LoginPage() {
  const router = useRouter();
  const { setUser, clearOrganization } = useIdentity();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError(null);
    try {
      const session = await apiRequest("/auth/login", isSession, { method: "POST", body: JSON.stringify({ email: String(form.get("email")).trim(), password: String(form.get("password")) }) });
      setUser(session.user); clearOrganization(); router.replace("/organizations");
    } catch (failure) { setError(failure); }
    finally { setPending(false); }
  }
  return <main className="flex min-h-dvh items-center justify-center p-5">
    <div className="w-full max-w-md space-y-8">
      <div className="flex items-center justify-center gap-3 text-xl font-semibold"><span className="rounded-lg bg-primary p-2 text-primary-foreground"><Wallet aria-hidden="true" /></span>LedgerFlow</div>
      <Card><CardHeader><CardTitle><h1 className="text-2xl">Welcome back</h1></CardTitle><CardDescription>Sign in to your organization workspace.</CardDescription></CardHeader>
        <CardContent><form onSubmit={submit} className="space-y-5" aria-busy={pending}>
          <ApiAlert error={error} />
          <div className="space-y-2"><label htmlFor="email" className="font-medium">Email address</label><Input id="email" name="email" type="email" autoComplete="username" maxLength={254} required disabled={pending} autoFocus /></div>
          <div className="space-y-2"><label htmlFor="password" className="font-medium">Password</label><Input id="password" name="password" type="password" autoComplete="current-password" maxLength={1024} required disabled={pending} /></div>
          <Button className="w-full" disabled={pending}>{pending ? "Signing in..." : "Sign in"}</Button>
          <p role="status" className="sr-only">{pending ? "Signing in. Please wait." : ""}</p>
        </form></CardContent>
      </Card><p className="text-center text-xs text-muted-foreground">Financial operations. One connected workspace.</p>
    </div>
  </main>;
}
