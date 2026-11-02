import { driftJson, driftRouteGate } from "@/lib/trade-requests/drift/route-gate";
import { appPool } from "@/lib/trade-requests/pg-compat";
import { fetchAccountDriftRun } from "@/lib/trade-requests/drift/position-drift-accounts-persistence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The latest live run (the newest run date's newest run), for the Drift screen's default view (ticket).
export async function GET(request: Request): Promise<Response> {
  const gate = await driftRouteGate(request, "read");
  if ("refused" in gate) return gate.refused;
  const pool = await appPool();
  const { rows } = await pool.query<{ latest: string | null }>(
    `SELECT to_char(MAX(run_date_local), 'YYYY-MM-DD') AS latest FROM trade_request.position_drift_accounts`,
  );
  const latest = rows[0]?.latest ?? null;
  const run = latest ? await fetchAccountDriftRun(pool, latest) : null;
  if (run === null) return driftJson({ error: "drift run not found", runDateLocal: null }, 404);
  return driftJson(run);
}
