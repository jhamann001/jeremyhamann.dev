import { driftJson, driftRouteGate } from "@/lib/trade-requests/drift/route-gate";
import { DRIFT_ALLOW_LIST } from "@/lib/trade-requests/drift/registry-drift-allow-list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Port of the standalone GET /api/drift/v2/allow-list (server/src/routes/drift.ts:254-261).
export async function GET(request: Request): Promise<Response> {
  const gate = await driftRouteGate(request, "read");
  if ("refused" in gate) return gate.refused;
  return driftJson({ entries: DRIFT_ALLOW_LIST });
}
