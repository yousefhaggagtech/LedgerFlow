import { isHealthResponse } from "@ledgerflow/shared";
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
  const color = status === "UP" ? "bg-green-600" : status === "DOWN" ? "bg-red-600" : "bg-gray-500";
  return (
    <p className="flex items-center gap-3 text-lg">
      <span aria-hidden="true" className={`h-3 w-3 rounded-full ${color}`} />
      {label}: {status}
    </p>
  );
}

export default async function Page() {
  const health = await readStatus();
  return (
    <main className="mx-auto max-w-lg space-y-4 p-8 text-gray-900">
      <h1 className="text-2xl font-semibold">System Status</h1>
      <StatusRefresh />
      <section aria-label="Connectivity status" aria-live="polite" className="space-y-3">
        <StatusIndicator label="API" status={health.api} />
        <StatusIndicator label="DB" status={health.database} />
        {health.error && <p>{health.error}</p>}
      </section>
      <p className="text-sm text-gray-600">Automatically refreshes every five seconds.</p>
    </main>
  );
}
