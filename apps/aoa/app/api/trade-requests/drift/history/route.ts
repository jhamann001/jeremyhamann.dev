import { driftJson, driftRouteGate } from "@/lib/trade-requests/drift/route-gate";
import { appPool } from "@/lib/trade-requests/pg-compat";
import { clampHistoryDays, fetchAccountDriftHistory } from "@/lib/trade-requests/drift/position-drift-accounts-persistence";
import { fetchActiveOverrides } from "@/lib/trade-requests/drift/drift-status-overrides";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Port of the standalone GET /api/drift/v2/history (server/src/routes/drift.ts:147-164): live account
// results with each account's active override attached. Shadow results are never read here.
export async function GET(request: Request): Promise<Response> {
  const gate = await driftRouteGate(request, "read");
  if ("refused" in gate) return gate.refused;
  const days = clampHistoryDays(new URL(request.url).searchParams.get("days") ?? undefined);
  const pool = await appPool();
  const runs = await fetchAccountDriftHistory(pool, days);
  const overrides = await fetchActiveOverrides(pool, runs.map((r) => r.accountId));
  return driftJson({ days, runs: runs.map((r) => ({ ...r, override: overrides.get(r.accountId) ?? null })) });
}
