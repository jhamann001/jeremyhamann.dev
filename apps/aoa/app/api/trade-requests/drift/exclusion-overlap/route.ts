import { z } from "zod";
import { driftJson, driftRouteGate, DRIFT_HEADERS } from "@/lib/trade-requests/drift/route-gate";
import { appPool } from "@/lib/trade-requests/pg-compat";
import { analyzeExclusionOverlapForRun } from "@/lib/trade-requests/drift/drift-exclusion-analysis";
import { runDateLocalSchema } from "@/lib/trade-requests/drift/run-date-param";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Port of the standalone HEAD/GET /api/drift/v2/exclusion-overlap (server/src/routes/drift.ts:130-145,
// 263-310): off unless the diagnostic switch is exactly "1"; one-hour per-date cache.
type Report = NonNullable<Awaited<ReturnType<typeof analyzeExclusionOverlapForRun>>>;
const TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { expiresAtMs: number; report: Report }>();
const enabled = () => process.env.TRADE_REQUEST_DRIFT_EXCLUSION_OVERLAP_ENABLED === "1";

export async function HEAD(request: Request): Promise<Response> {
  const gate = await driftRouteGate(request, "read");
  if ("refused" in gate) return new Response(null, { status: gate.refused.status, headers: DRIFT_HEADERS });
  return new Response(null, { status: enabled() ? 204 : 404, headers: DRIFT_HEADERS });
}

export async function GET(request: Request): Promise<Response> {
  const gate = await driftRouteGate(request, "read");
  if ("refused" in gate) return gate.refused;
  if (!enabled()) return driftJson({ error: "drift exclusion overlap diagnostic disabled" }, 404);
  const parsed = z.object({ runDateLocal: runDateLocalSchema.optional() }).safeParse({
    runDateLocal: new URL(request.url).searchParams.get("runDateLocal") ?? undefined,
  });
  if (!parsed.success) return driftJson({ error: "Validation failed", details: parsed.error.issues }, 400);
  const { runDateLocal } = parsed.data;
  const key = runDateLocal ?? "__latest__";
  const hit = cache.get(key);
  if (hit && hit.expiresAtMs > Date.now()) return driftJson(hit.report);
  const report = await analyzeExclusionOverlapForRun(await appPool(), { runDateLocal });
  if (report === null) return driftJson({ error: "drift run not found", runDateLocal: runDateLocal ?? null }, 404);
  cache.set(key, { expiresAtMs: Date.now() + TTL_MS, report });
  return driftJson(report);
}
