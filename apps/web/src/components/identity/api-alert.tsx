import { ApiError, errorMessage } from "@/lib/api";
export function ApiAlert({ error }: { error: unknown }) {
  if (!error) return null;
  return <div role="alert" className="space-y-1 rounded-md border border-input bg-muted p-4 text-sm">
    {error instanceof ApiError && error.status === 403 && <p className="font-semibold">Permission Denied</p>}
    <p>{errorMessage(error)}</p>
    {error instanceof ApiError && error.requestId && <p className="break-all text-xs text-muted-foreground">Reference: {error.requestId}</p>}
  </div>;
}
