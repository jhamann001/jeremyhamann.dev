import { requireIngestToken } from "@/lib/ingest/auth";
import { runAssetMapImport } from "@/lib/data/asset-map-import";

// Node runtime: crypto (run id) + Prisma. Phase-1 asset-mapping ingest — the
// SECOND scheduled/internal PULL route (after account-aum). Cloud Scheduler
// POSTs here and the app PULLS the household→accounts[]→positions[] tree from
// the statement-pipeline's OIDC-gated /api/v1/households, mirroring it UNLINKED into
// mirror.acat_asset_map_* (upsert-by-UUID, superseded_by carried verbatim, no
// person resolution — that is Phase 2). Auth REUSES the ingest bearer token
// (requireIngestToken → INGEST_TOKEN); no new inbound secret. Same 405 posture
// as app/api/ingest/* and account-aum.
//
// RUN IDENTITY (ticket, default off): with ASSET_MAP_RUN_IDENTITY_ENABLED=1 the
// same pages also feed a strict identity census. Preview (writes gate off) and
// dryRun=1 return read-only aggregate diagnostics; with
// ASSET_MAP_RUN_IDENTITY_WRITES_ENABLED=1 a complete census is applied in a
// SEPARATE ingest tx after the base tx commits (lib/data/asset-map-run-identity).
//
// SCHEDULE (documented here; the Cloud Scheduler job is an out-of-band gcloud
// step, NOT created by this PR — same as account-aum): POST every 30 min during
// business hours, e.g. `*/30 7-19 * * 1-5` America/Los_Angeles. Wire it like
// account-aum: Cloud Scheduler → OIDC → the /api/cron middleware exclusion →
// the restrictServiceUsage allow-list entry for this path.
//
// CROSS-APP DEPENDENCY: needs statement-pipeline PR #29 merged and AOA's aoa-run@ SA
// added to the pipeline's POSITIONS_API_ALLOWED_SAS, plus STATEMENT_PIPELINE_URL set
// in Secret Manager. Until then a live run returns 503 (unset URL) or 502.
export const runtime = "nodejs";

const err = (error: string, status: number) => Response.json({ error }, { status });

// Shared 405 (NOT exported — Next rejects non-Route exports); each verb returns
// it, guaranteeing our body over Next's default.
function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function POST(req: Request): Promise<Response> {
  // 1. Auth — the same bearer gate the push ingest + account-aum routes use.
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);
  // 2 to 8 (config, pull, flatten, cap, locked write tx, response, identity
  // phase) live in the shared import (ticket).
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const result = await runAssetMapImport({ dryRun });
  return Response.json(result.body, { status: result.status });
}
