import { isObject } from "@/lib/identity";
const REQUEST_TIMEOUT_MS = 15_000;
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL;
export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string | null;
  constructor(status: number, message: string, requestId: string | null = null) {
    super(message); this.status = status; this.requestId = requestId;
  }
}
export async function apiRequest<T>(path: string, guard: (value: unknown) => value is T, init: RequestInit = {}): Promise<T> {
  if (!API_ORIGIN) throw new ApiError(503, "The API connection is not configured.");
  let response: Response;
  try {
    response = await fetch(new URL(path, API_ORIGIN).href, { ...init, credentials: "include", cache: "no-store",
      headers: { "Content-Type": "application/json", ...init.headers }, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { throw new ApiError(0, "Could not reach the service. Check your connection and refresh before retrying a change."); }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, isObject(data) && typeof data.error === "string" ? data.error : "The request could not be completed.", response.headers.get("X-Request-Id"));
  }
  if (!guard(data)) throw new ApiError(502, "The service returned an unexpected response. Refresh before retrying a change.");
  return data;
}
export function errorMessage(error: unknown): string { return error instanceof ApiError ? error.message : "The request could not be completed. Please try again."; }
