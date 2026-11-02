import { z } from "zod";
import { driftJson, driftRouteGate } from "@/lib/trade-requests/drift/route-gate";
import { appPool } from "@/lib/trade-requests/pg-compat";
import { fetchAccountDriftRun } from "@/lib/trade-requests/drift/position-drift-accounts-persistence";
import { runDateLocalSchema } from "@/lib/trade-requests/drift/run-date-param";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Port of the standalone GET /api/drift/v2/runs/:runDateLocal (server/src/routes/drift.ts:235-252).
export async function GET(request: Request, { params }: { params: Promise<{ runDateLocal: string }> }): Promise<Response> {
  const gate = await driftRouteGate(request, "read");
  if ("refused" in gate) return gate.refused;
  const parsed = z.object({ runDateLocal: runDateLocalSchema }).safeParse(await params);
  if (!parsed.success) return driftJson({ error: "Validation failed", details: parsed.error.issues }, 400);
  const run = await fetchAccountDriftRun(await appPool(), parsed.data.runDateLocal);
  if (run === null) return driftJson({ error: "drift run not found", runDateLocal: parsed.data.runDateLocal }, 404);
  return driftJson(run);
}
