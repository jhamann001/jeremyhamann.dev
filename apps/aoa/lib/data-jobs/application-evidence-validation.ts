import { z } from "zod";
import type { JobApplicationEvidence } from "./application-evidence-types";

const instant = z.string().max(24).refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}, "invalid_timestamp");
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "invalid_business_date");
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const STATUS_BY_CODE = {
  commit_recorded: "COMPLETE", partial_commit_recorded: "PARTIAL", no_commit_recorded: "UNKNOWN",
  invalid_audit_metadata: "UNKNOWN", no_rows_committed: "UNKNOWN", application_read_unavailable: "UNKNOWN",
  sweep_complete: "COMPLETE", sweep_page_running: "RUNNING", sweep_progressing: "PROGRESSING",
  sweep_progress_stale: "PARTIAL", sweep_failed: "FAILED", sweep_not_run: "UNKNOWN",
  sweep_completion_unconfirmed: "UNKNOWN", invalid_checkpoint: "UNKNOWN",
} as const;
const schema = z.object({
  schemaVersion: z.literal(1),
  sourceKey: z.enum(["ACCOUNT_AUM", "REVIEW_QUEUE"]),
  environment: z.enum(["dev", "prod"]),
  observedAt: instant,
  coverage: z.enum(["snapshot_only", "unavailable"]),
  status: z.enum(["COMPLETE", "PROGRESSING", "RUNNING", "FAILED", "PARTIAL", "UNKNOWN"]),
  code: z.enum([
    "commit_recorded", "partial_commit_recorded", "no_commit_recorded", "invalid_audit_metadata",
    "no_rows_committed", "application_read_unavailable", "sweep_complete", "sweep_page_running",
    "sweep_progressing", "sweep_progress_stale", "sweep_failed", "sweep_not_run",
    "sweep_completion_unconfirmed", "invalid_checkpoint",
  ]),
  correlation: z.literal("source_only"),
  latestCommitAt: instant.nullable(), lastAttemptAt: instant.nullable(), lastFailureAt: instant.nullable(),
  lastFailureSource: z.enum(["TRADE_REQUEST", "CRM_IDENTITY", "MULTIPLE", "MATERIALIZATION", "UNKNOWN"]).nullable(),
  recordsCommitted: count, recordsRejected: count, businessAsOf: businessDate.nullable(),
  commitTrigger: z.enum(["scheduled_primary", "stale_retry", "unknown"]).nullable(),
  freshness: z.object({
    status: z.enum(["CURRENT", "STALE", "UNKNOWN"]), checkedAt: instant,
    basis: z.enum(["committed_snapshot_date", "complete_sweep_age"]),
    expectedBusinessAsOf: businessDate.nullable(),
    code: z.enum([
      "committed_snapshot_current", "committed_snapshot_stale", "business_date_unknown",
      "complete_sweep_current", "complete_sweep_stale", "complete_sweep_unknown",
    ]),
  }),
  latestFeedWarning: z.object({
    at: instant,
    code: z.enum(["empty", "stale_as_of", "stale_sync", "incomplete_coverage", "reconciliation_failed", "close_date_missing", "unknown"]),
  }).nullable(),
  stages: z.array(z.object({
    key: z.enum(["TRADE_REQUEST", "CRM_IDENTITY"]),
    status: z.enum(["COMPLETE", "PENDING", "FAILED", "UNKNOWN"]),
    basis: z.enum(["last_completed_sweep", "current_checkpoint"]),
  })).max(2),
}).superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: z.ZodIssueCode.custom, message: "inconsistent_application_evidence" });
  if (value.status !== STATUS_BY_CODE[value.code]) invalid();
  if ([value.latestCommitAt, value.lastAttemptAt, value.lastFailureAt, value.latestFeedWarning?.at]
    .some((at) => at != null && at > value.observedAt)
    || value.freshness.checkedAt !== value.observedAt
    || new Set(value.stages.map((stage) => stage.key)).size !== value.stages.length) invalid();
  if (value.latestCommitAt == null && (value.recordsCommitted != null || value.recordsRejected != null
    || value.businessAsOf != null || value.commitTrigger != null || value.freshness.status !== "UNKNOWN")) invalid();
  if (value.lastFailureAt == null && value.lastFailureSource != null) invalid();
  if (value.freshness.status !== (value.freshness.code.endsWith("_current") ? "CURRENT"
    : value.freshness.code.endsWith("_stale") ? "STALE" : "UNKNOWN")) invalid();
  if (value.sourceKey === "ACCOUNT_AUM") {
    if (value.stages.length || value.lastFailureAt != null || value.lastFailureSource != null
      || value.freshness.basis !== "committed_snapshot_date" || value.code.startsWith("sweep_")
      || value.code === "invalid_checkpoint" || value.freshness.code.startsWith("complete_sweep")) invalid();
    if (value.latestCommitAt != null && (value.recordsCommitted == null || value.recordsCommitted < 1
      || value.recordsRejected == null || value.commitTrigger == null)) invalid();
    if (value.freshness.status !== "UNKNOWN" && (!value.businessAsOf || !value.freshness.expectedBusinessAsOf)) invalid();
    if ((value.status === "COMPLETE" && value.recordsRejected !== 0)
      || (value.status === "PARTIAL" && (value.recordsRejected == null || value.recordsRejected < 1))) invalid();
  } else if (value.recordsCommitted != null || value.recordsRejected != null || value.businessAsOf != null
    || value.commitTrigger != null || value.latestFeedWarning != null
    || value.freshness.basis !== "complete_sweep_age" || value.freshness.expectedBusinessAsOf != null
    || (!value.code.startsWith("sweep_") && value.code !== "invalid_checkpoint" && value.code !== "application_read_unavailable")
    || !value.freshness.code.startsWith("complete_sweep")) invalid();
  if (value.sourceKey === "REVIEW_QUEUE" && (
    (value.status === "COMPLETE" && (value.latestCommitAt == null || value.stages.length !== 2
      || value.stages.some((stage) => stage.status !== "COMPLETE" || stage.basis !== "last_completed_sweep")))
    || (value.status === "FAILED" && value.lastFailureAt == null)
    || (["RUNNING", "PROGRESSING"].includes(value.status) && value.lastAttemptAt == null)
  )) invalid();
  if (value.coverage === "unavailable" && (value.status !== "UNKNOWN" || value.code !== "application_read_unavailable"
    || value.latestCommitAt != null || value.lastAttemptAt != null || value.lastFailureAt != null
    || value.latestFeedWarning != null || value.stages.length)) invalid();
});

/** Strips all unlisted fields recursively; never return raw Zod error/input to the user or logs. */
export function validateApplicationEvidence(input: unknown): JobApplicationEvidence {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error("invalid_application_evidence");
  return result.data;
}

export function isApplicationEvidenceStale(
  evidence: JobApplicationEvidence, now: Date, maxAgeMs = 15 * 60_000,
): boolean {
  const observed = new Date(evidence.observedAt).getTime();
  return !Number.isFinite(now.getTime()) || !Number.isFinite(observed)
    || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
    || now.getTime() < observed || now.getTime() - observed > maxAgeMs;
}

/** Preserve historical commits, but never present an expired cached freshness verdict as current. */
export function applicationEvidenceForDisplay(
  evidence: JobApplicationEvidence, now: Date, maxAgeMs = 15 * 60_000,
): { evidence: JobApplicationEvidence; monitoringStale: boolean } {
  const validated = validateApplicationEvidence(evidence);
  const monitoringStale = isApplicationEvidenceStale(validated, now, maxAgeMs);
  return {
    monitoringStale,
    evidence: !monitoringStale ? validated : {
      ...validated,
      freshness: { ...validated.freshness, status: "UNKNOWN",
        code: validated.sourceKey === "ACCOUNT_AUM" ? "business_date_unknown" : "complete_sweep_unknown" },
    },
  };
}
