import { previousTradingDay } from "@/lib/market-calendar";
import type { JobEnvironment } from "./contracts";
import type {
  ApplicationAuditInput, ApplicationSourceKey, ApplicationSweepInput,
  FeedWarningCode, JobApplicationEvidence,
} from "./application-evidence-types";

const MAX_AUDIT_BYTES = 16_384;
const SWEEP_FRESH_MS = 2 * 60 * 60_000;
const SWEEP_PROGRESS_MS = 20 * 60_000;
const WARNING_CODES = new Set<FeedWarningCode>([
  "empty", "stale_as_of", "stale_sync", "incomplete_coverage", "reconciliation_failed", "close_date_missing",
]);
const FAILURE_SOURCES = new Set(["TRADE_REQUEST", "CRM_IDENTITY", "MULTIPLE", "MATERIALIZATION"]);

function timestamp(value: Date | null | undefined, now: Date): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) && value <= now
    ? value.toISOString() : null;
}
function record(detail: string | null): Record<string, unknown> | null {
  if (!detail || detail.length > MAX_AUDIT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(detail);
    return value != null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function businessDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

export function unavailableApplicationEvidence(
  sourceKey: ApplicationSourceKey, environment: JobEnvironment, now: Date,
): JobApplicationEvidence {
  return {
    schemaVersion: 1, sourceKey, environment, observedAt: now.toISOString(), coverage: "unavailable",
    status: "UNKNOWN", code: "application_read_unavailable", correlation: "source_only",
    latestCommitAt: null, lastAttemptAt: null, lastFailureAt: null, lastFailureSource: null,
    recordsCommitted: null, recordsRejected: null, businessAsOf: null, commitTrigger: null,
    freshness: {
      status: "UNKNOWN", checkedAt: now.toISOString(),
      basis: sourceKey === "ACCOUNT_AUM" ? "committed_snapshot_date" : "complete_sweep_age",
      expectedBusinessAsOf: null,
      code: sourceKey === "ACCOUNT_AUM" ? "business_date_unknown" : "complete_sweep_unknown",
    },
    latestFeedWarning: null, stages: [],
  };
}

type ParsedCommit = { at: string; committed: number; rejected: number; businessAsOf: string | null;
  trigger: "scheduled_primary" | "stale_retry" | "unknown" };
function parseCommit(row: ApplicationAuditInput, now: Date): ParsedCommit | null {
  const at = timestamp(row.at, now);
  const data = record(row.detail);
  if (!at || !data || data.dry_run !== false) return null;
  const committed = count(data.upserted);
  const rejected = count(data.rejected);
  if (committed == null || rejected == null || committed === 0) return null;
  const received = data.received === undefined ? null : count(data.received);
  if (data.received !== undefined && (received == null || received !== committed + rejected)) return null;
  return {
    at, committed, rejected, businessAsOf: businessDate(data.as_of_max),
    trigger: data.trigger === "scheduled_primary" || data.trigger === "stale_retry" ? data.trigger : "unknown",
  };
}

/** Existing committed audits only; no provider attempt correlation or failure denominator. */
export function evaluateAccountAumEvidence(
  environment: JobEnvironment,
  input: { audits: readonly ApplicationAuditInput[]; warning: ApplicationAuditInput | null },
  now: Date,
): JobApplicationEvidence {
  const result = unavailableApplicationEvidence("ACCOUNT_AUM", environment, now);
  result.coverage = "snapshot_only";
  const audits = input.audits.slice(0, 32)
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    // Dry-run evidence is not a live attempt or committed data, even if a legacy writer logged it.
    .filter((row) => record(row.detail)?.dry_run !== true);
  const latest = audits[0];
  const latestResult = latest ? parseCommit(latest, now) : null;
  const commit = audits.map((row) => parseCommit(row, now)).find((row) => row != null) ?? null;
  result.lastAttemptAt = latest ? timestamp(latest.at, now) : null;
  result.code = !latest ? "no_commit_recorded" : !latestResult
    ? record(latest.detail)?.dry_run === false && count(record(latest.detail)?.upserted) === 0
      ? "no_rows_committed" : "invalid_audit_metadata"
    : latestResult.rejected > 0 ? "partial_commit_recorded" : "commit_recorded";
  result.status = latestResult ? latestResult.rejected > 0 ? "PARTIAL" : "COMPLETE" : "UNKNOWN";
  if (commit) {
    result.latestCommitAt = commit.at;
    result.recordsCommitted = commit.committed;
    result.recordsRejected = commit.rejected;
    result.businessAsOf = commit.businessAsOf;
    result.commitTrigger = commit.trigger;
  }
  const warningAt = input.warning ? timestamp(input.warning.at, now) : null;
  if (warningAt) {
    const reason = record(input.warning!.detail)?.reason;
    result.latestFeedWarning = {
      at: warningAt,
      code: typeof reason === "string" && WARNING_CODES.has(reason as FeedWarningCode)
        ? reason as FeedWarningCode : "unknown",
    };
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    const expected = previousTradingDay(today);
    result.freshness.expectedBusinessAsOf = expected;
    if (commit?.businessAsOf && commit.businessAsOf <= today) {
      const current = commit.businessAsOf >= expected;
      result.freshness.status = current ? "CURRENT" : "STALE";
      result.freshness.code = current ? "committed_snapshot_current" : "committed_snapshot_stale";
    }
  } catch {
    // Calendar coverage lapses remain unknown rather than silently using calendar days.
  }
  return result;
}

/** The singleton is a rolling checkpoint, not a history of individual invocation results. */
export function evaluateReviewQueueEvidence(
  environment: JobEnvironment, sweep: ApplicationSweepInput | null, now: Date,
): JobApplicationEvidence {
  const result = unavailableApplicationEvidence("REVIEW_QUEUE", environment, now);
  result.coverage = "snapshot_only";
  result.code = "sweep_not_run";
  if (!sweep) return result;
  const started = timestamp(sweep.last_started_at, now);
  const completed = timestamp(sweep.last_completed_at, now);
  const failed = timestamp(sweep.last_failure_at, now);
  if ([sweep.last_started_at, sweep.last_completed_at, sweep.last_failure_at]
    .some((value) => value != null && timestamp(value, now) == null)
    || [sweep.trade_progress, sweep.crm_progress, sweep.trade_complete, sweep.crm_complete]
      .some((value) => typeof value !== "boolean")
    || (sweep.lease_expires_at != null && !Number.isFinite(sweep.lease_expires_at.getTime()))) {
    result.code = "invalid_checkpoint";
    return result;
  }
  result.lastAttemptAt = started;
  result.latestCommitAt = completed;
  result.lastFailureAt = failed;
  result.lastFailureSource = failed
    ? FAILURE_SOURCES.has(sweep.last_failure_source ?? "")
      ? sweep.last_failure_source as JobApplicationEvidence["lastFailureSource"] : "UNKNOWN"
    : null;
  if (completed) {
    const current = now.getTime() - new Date(completed).getTime() <= SWEEP_FRESH_MS;
    result.freshness.status = current ? "CURRENT" : "STALE";
    result.freshness.code = current ? "complete_sweep_current" : "complete_sweep_stale";
  }
  const partial = sweep.trade_progress || sweep.crm_progress || sweep.trade_complete || sweep.crm_complete;
  const newPage = started != null && (completed == null || started > completed);
  const failedLatest = failed != null && (completed == null || failed >= completed)
    && (started == null || failed >= started);
  const running = newPage && sweep.lease_expires_at != null && sweep.lease_expires_at > now;
  const currentProgress = started != null && now.getTime() - new Date(started).getTime() <= SWEEP_PROGRESS_MS;
  if (running) {
    result.status = "RUNNING"; result.code = "sweep_page_running";
  } else if (failedLatest) {
    result.status = "FAILED"; result.code = "sweep_failed";
  } else if (partial) {
    result.status = currentProgress ? "PROGRESSING" : "PARTIAL";
    result.code = currentProgress ? "sweep_progressing" : "sweep_progress_stale";
  } else if (completed && !newPage) {
    result.status = "COMPLETE"; result.code = "sweep_complete";
  } else if (started) {
    result.code = "sweep_completion_unconfirmed";
  }
  const completedSnapshot = result.status === "COMPLETE";
  result.stages = (["TRADE_REQUEST", "CRM_IDENTITY"] as const).map((key) => ({
    key,
    status: failedLatest && (result.lastFailureSource === key || result.lastFailureSource === "MULTIPLE")
      ? "FAILED" : completedSnapshot || (key === "TRADE_REQUEST" ? sweep.trade_complete : sweep.crm_complete)
        ? "COMPLETE" : started ? "PENDING" : "UNKNOWN",
    basis: completedSnapshot ? "last_completed_sweep" : "current_checkpoint",
  }));
  return result;
}
