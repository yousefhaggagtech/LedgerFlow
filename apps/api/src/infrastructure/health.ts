import type { HealthResponse } from "@ledgerflow/shared";

export async function getHealth(checkDatabase: () => Promise<void>): Promise<HealthResponse> {
  try {
    await checkDatabase();
    return { api: "UP", database: "UP" };
  } catch {
    // Driver errors may contain credentials or infrastructure details.
    return { api: "UP", database: "DOWN", error: "Database is unavailable." };
  }
}
