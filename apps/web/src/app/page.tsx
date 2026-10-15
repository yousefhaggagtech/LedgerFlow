import { isHealthResponse } from "@ledgerflow/shared";
import { Building2, Cable } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusRefresh } from "./status-refresh";

export const dynamic = "force-dynamic";
const REQUEST_TIMEOUT_MS = 10_000;
type Status = "UP" | "DOWN" | "UNKNOWN";

async function readStatus(): Promise<{ api: Status; database: Status; error?: string }> {
  try {
    const apiUrl = process.env.API_URL;
    if (!apiUrl) return { api: "UNKNOWN", database: "UNKNOWN", error: "API_URL is not configured." };
    const url = new URL(apiUrl);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Invalid API URL");
    const response = await fetch(new URL("/health", url), {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const data: unknown = await response.json();
    if (!isHealthResponse(data) ||
      (data.database === "UP" ? response.status !== 200 : response.status !== 503)) {
      throw new Error("Invalid health response");
    }
    return data.database === "UP"
      ? { api: data.api, database: data.database }
      : { api: data.api, database: data.database, error: "Database is unavailable." };
  } catch {
    return { api: "DOWN", database: "UNKNOWN", error: "API health check failed. Database status is unknown." };
  }
}

function StatusIndicator({ label, status }: { label: string; status: Status }) {
  return (
    <p className="flex items-center gap-3">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant="secondary" className="tabular-nums">{status}</Badge>
    </p>
  );
}

export default async function Page() {
  const health = await readStatus();
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Workspace</h1>
          <p className="text-muted-foreground">A simpler way to manage your business finances.</p>
        </div>
        <Badge variant="outline" className="bg-card">Foundation preview</Badge>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center py-12 text-center md:py-16">
          <span className="mb-6 flex size-12 items-center justify-center rounded-lg border bg-background text-muted-foreground">
            <Building2 className="size-6" aria-hidden="true" />
          </span>
          <h2 className="text-xl font-semibold tracking-tight">Your business, in one workspace</h2>
          <p className="mt-3 max-w-md leading-relaxed text-muted-foreground">
            Sales, expenses, banking, and the details in between.
            Your workspace is ready for the tools that come next.
          </p>
          <p className="mt-6 max-w-md text-xs leading-relaxed text-muted-foreground">
            Explore the sidebar to preview each section. Business features will be added in future updates.
          </p>
        </CardContent>
      </Card>
      <StatusRefresh />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm"><Cable className="size-4 text-muted-foreground" aria-hidden="true" />System status</CardTitle>
          <CardDescription>Workspace connectivity. Refreshes every five seconds.</CardDescription>
        </CardHeader>
        <CardContent>
          <section aria-label="Connectivity status" aria-live="polite" className="space-y-4">
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <StatusIndicator label="API" status={health.api} />
              <StatusIndicator label="DB" status={health.database} />
            </div>
            {health.error && <p className="text-sm text-muted-foreground">{health.error}</p>}
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
