import { ApiError, type apiRequest } from "@/lib/api";
import { isAccessHints, type OrganizationAccess } from "@/lib/identity";

// Owned by one mounted provider; selection/refresh generations prevent stale replies crossing tenants.
export function createAccessRefresh(send: typeof apiRequest, onChange: (value: OrganizationAccess | null) => void,
  onUnauthenticated: () => void) {
  let selected: OrganizationAccess | null = null;
  let selection = 0;
  let refreshSequence = 0;
  function select(value: OrganizationAccess | null): void {
    selected = value; selection++; onChange(value);
  }
  async function refresh(): Promise<void> {
    const current = selected;
    if (!current) return;
    const version = selection;
    const sequence = ++refreshSequence;
    try {
      const hints = await send(`/organizations/${current.id}/access`, isAccessHints);
      if (version !== selection || sequence !== refreshSequence) return;
      if (hints.membership.organizationId !== current.id || hints.membership.userId !== current.membership.userId) {
        throw new ApiError(502, "Unexpected organization access response.");
      }
      selected = { ...current, ...hints };
      onChange(selected);
    } catch (error) {
      if (version === selection && sequence === refreshSequence) {
        select(null);
        if (error instanceof ApiError && error.status === 401) onUnauthenticated();
      }
      throw error;
    }
  }
  const request: typeof apiRequest = async (path, guard, init) => {
    const version = selection;
    try { return await send(path, guard, init); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) { select(null); onUnauthenticated(); }
      else if (error instanceof ApiError && error.status === 403 && selected && version === selection &&
          !["GET", "HEAD", "OPTIONS"].includes(init?.method?.toUpperCase() ?? "GET")) {
        try { await refresh(); }
        catch (refreshError) {
          if (refreshError instanceof ApiError && refreshError.status === 401) throw refreshError;
          // Refresh already invalidated stale hints; preserve the original mutation denial for feedback.
        }
      }
      throw error;
    }
  };
  return { select, refresh, request };
}
