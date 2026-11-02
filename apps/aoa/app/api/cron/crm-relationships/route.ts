import crypto from "crypto";
import { requireIngestToken } from "@/lib/ingest/auth";
import {
  crmRelationshipContinuousRefreshEnabled,
  crmRelationshipReconciliationEnabled,
  crmRelationshipReconciliationWritesEnabled,
} from "@/lib/flags";
import {
  runCrmRelationshipSnapshot,
  type CrmRelationshipSnapshotCompleteness,
} from "@/lib/crm/relationships";

export const runtime = "nodejs";

type ErrorBody = { error: string };
const err = (error: string, status: number) =>
  Response.json({ error } satisfies ErrorBody, { status });

function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

function completenessFrom(searchParams: URLSearchParams):
  | { ok: true; value: CrmRelationshipSnapshotCompleteness }
  | { ok: false } {
  const read = (key: string): boolean | null => {
    const value = searchParams.get(key);
    if (value === null || value === "0") return false;
    if (value === "1") return true;
    return null;
  };
  const contact = read("contactComplete");
  const deal = read("dealComplete");
  const transfer = read("transferComplete");
  if (contact === null || deal === null || transfer === null) return { ok: false };
  return { ok: true, value: { contact, deal, transfer } };
}

export async function POST(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  // Dark means dark: do not construct the reconciler client or touch audit.
  if (!crmRelationshipReconciliationEnabled()) {
    return Response.json({ reconciled: 0, skipped: "flag_off" });
  }

  const searchParams = new URL(req.url).searchParams;
  const dryRun = searchParams.get("dryRun") === "1";
  const continuousParam = searchParams.get("continuous");
  if (continuousParam !== null && continuousParam !== "0" && continuousParam !== "1") {
    return err("invalid_continuous", 400);
  }
  const continuous = continuousParam === "1";
  const completeness = completenessFrom(searchParams);
  if (!completeness.ok) return err("invalid_completeness", 400);
  if (continuous && !crmRelationshipContinuousRefreshEnabled()) {
    return err("continuous_refresh_disabled", 409);
  }
  if (!dryRun && !crmRelationshipReconciliationWritesEnabled()) {
    return err("writes_disabled", 409);
  }

  const runId = crypto.randomUUID();
  const safeRunId = encodeURIComponent(runId).slice(0, 256);

  try {
    const derivations = await runCrmRelationshipSnapshot(
      runId,
      dryRun,
      completeness.value,
    );
    return Response.json({
      run_id: runId,
      dry_run: dryRun,
      continuous,
      source: "approved_crm_relationship_sources",
      completeness: completeness.value,
      derivations: derivations.map((row) => ({
        derivation: row.derivation,
        snapshot_complete: row.snapshotComplete,
        candidates: row.candidates,
        created: row.created,
        refreshed: row.refreshed,
        reactivated: row.reactivated,
        inactivated: row.inactivated,
        missing_endpoint: row.missingEndpoint,
        ambiguous_endpoint: row.ambiguousEndpoint,
        rejected_type: row.rejectedType,
      })),
    });
  } catch (error) {
    const configError =
      error instanceof Error && error.message === "crm_reconciler_not_configured";
    console.error(
      `[cron:crm-relationships] run_id=${safeRunId} ${configError ? "config_missing" : "tx_failed"}`,
    );
    return err(configError ? "config_error" : "internal", configError ? 503 : 500);
  }
}
