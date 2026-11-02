import crypto from "crypto";
import { requireIngestToken } from "@/lib/ingest/auth";
import {
  crmIdentityReconciliationEnabled,
  crmIdentityReconciliationWritesEnabled,
} from "@/lib/flags";
import { runCrmMissingParentDiagnostics } from "@/lib/crm/parent-diagnostics";
import { runCrmIdentityCoverageDiagnostics } from "@/lib/crm/coverage";
import {
  CRM_RECONCILIATION_BUSY_ERROR,
  runCrmIdentityReconciliation,
} from "@/lib/crm/reconcile";

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

export async function POST(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  // Dark deployment: no database connection, registry read, or audit row when
  // the writer flag is off.
  if (!crmIdentityReconciliationEnabled()) {
    return Response.json({ reconciled: 0, skipped: "flag_off" });
  }

  const searchParams = new URL(req.url).searchParams;
  const dryRun = searchParams.get("dryRun") === "1";
  const diagnostic = searchParams.get("diagnostics");
  if (diagnostic && !["missing_parents", "coverage"].includes(diagnostic)) {
    return err("unsupported_diagnostic", 400);
  }
  if (diagnostic && !dryRun) {
    return err("diagnostics_require_dry_run", 400);
  }
  if (!dryRun && !crmIdentityReconciliationWritesEnabled()) {
    return err("writes_disabled", 409);
  }

  if (diagnostic === "missing_parents") {
    try {
      const diagnostics = await runCrmMissingParentDiagnostics();
      return Response.json({
        diagnostic,
        dry_run: true,
        source: "approved_crm_namespaces",
        missing_parent_diagnostics: diagnostics,
      });
    } catch (error) {
      const configError =
        error instanceof Error && error.message === "crm_reconciler_not_configured";
      console.error(
        `[cron:crm-identity] diagnostics=missing_parents ${configError ? "config_missing" : "query_failed"}`,
      );
      return err(configError ? "config_error" : "internal", configError ? 503 : 500);
    }
  }

  if (diagnostic === "coverage") {
    try {
      const coverage = await runCrmIdentityCoverageDiagnostics();
      return Response.json({
        diagnostic,
        dry_run: true,
        source: "approved_crm_namespaces",
        identity_coverage: coverage,
      });
    } catch (error) {
      const configError =
        error instanceof Error && error.message === "crm_reconciler_not_configured";
      console.error(
        `[cron:crm-identity] diagnostics=coverage ${configError ? "config_missing" : "query_failed"}`,
      );
      return err(configError ? "config_error" : "internal", configError ? 503 : 500);
    }
  }

  const runId = crypto.randomUUID();
  const safeRunId = encodeURIComponent(runId).slice(0, 256);

  try {
    const counts = await runCrmIdentityReconciliation(runId, dryRun);
    const duplicateCandidateCounts = counts.duplicateMode === "persisted"
      ? {
          duplicate_candidates_opened: counts.duplicateCandidatesOpened,
          duplicate_candidates_refreshed: counts.duplicateCandidatesRefreshed,
          duplicate_candidates_inactivated: counts.duplicateCandidatesInactivated,
        }
      : {
          duplicate_candidates_would_open: counts.duplicateCandidatesWouldOpen,
          duplicate_candidates_would_refresh: counts.duplicateCandidatesWouldRefresh,
          duplicate_candidates_would_inactivate: counts.duplicateCandidatesWouldInactivate,
        };
    return Response.json({
      sources_seen: counts.sourcesSeen,
      identities_created: counts.identitiesCreated,
      mappings_created: counts.mappingsCreated,
      mappings_refreshed: counts.mappingsRefreshed,
      exceptions_opened: counts.exceptionsOpened,
      exceptions_reopened: counts.exceptionsReopened,
      exceptions_resolved: counts.exceptionsResolved,
      duplicate_signals_seen: counts.duplicateSignalsSeen,
      duplicate_mode: counts.duplicateMode,
      ...duplicateCandidateCounts,
      dry_run: dryRun,
      source: "approved_crm_namespaces",
    });
  } catch (error) {
    const configError =
      error instanceof Error && error.message === "crm_reconciler_not_configured";
    const alreadyRunning =
      error instanceof Error && error.message === CRM_RECONCILIATION_BUSY_ERROR;
    if (alreadyRunning) {
      console.info(`[cron:crm-identity] run_id=${safeRunId} already_running`);
      return Response.json(
        { reconciled: 0, skipped: "already_running" },
        { status: 202 },
      );
    }
    console.error(
      `[cron:crm-identity] run_id=${safeRunId} ${configError ? "config_missing" : "tx_failed"}`,
    );
    return err(configError ? "config_error" : "internal", configError ? 503 : 500);
  }
}
