import type { JobEnvironment } from "./contracts";

/** Source-associated application evidence. It is deliberately not a provider JobRun. */
export type ApplicationSourceKey = "ACCOUNT_AUM" | "REVIEW_QUEUE";
export type ApplicationEvidenceStatus = "COMPLETE" | "PROGRESSING" | "RUNNING" | "FAILED" | "PARTIAL" | "UNKNOWN";
export type ApplicationEvidenceCode =
  | "commit_recorded" | "partial_commit_recorded" | "no_commit_recorded"
  | "invalid_audit_metadata" | "no_rows_committed" | "application_read_unavailable"
  | "sweep_complete" | "sweep_page_running" | "sweep_progressing"
  | "sweep_progress_stale" | "sweep_failed" | "sweep_not_run"
  | "sweep_completion_unconfirmed" | "invalid_checkpoint";
export type ApplicationFreshnessCode =
  | "committed_snapshot_current" | "committed_snapshot_stale" | "business_date_unknown"
  | "complete_sweep_current" | "complete_sweep_stale" | "complete_sweep_unknown";
export type FeedWarningCode = "empty" | "stale_as_of" | "stale_sync" |
  "incomplete_coverage" | "reconciliation_failed" | "close_date_missing" | "unknown";

export type JobApplicationEvidence = {
  schemaVersion: 1;
  sourceKey: ApplicationSourceKey;
  environment: JobEnvironment;
  observedAt: string;
  coverage: "snapshot_only" | "unavailable";
  status: ApplicationEvidenceStatus;
  code: ApplicationEvidenceCode;
  /** No incoming correlation header/run ID exists in this evidence contract. */
  correlation: "source_only";
  latestCommitAt: string | null;
  /** Latest durable audit timestamp or bounded-sweep start, never inferred provider attempt. */
  lastAttemptAt: string | null;
  /** Review-queue failure only. A feed-health warning is not an import attempt failure. */
  lastFailureAt: string | null;
  lastFailureSource: "TRADE_REQUEST" | "CRM_IDENTITY" | "MULTIPLE" | "MATERIALIZATION" | "UNKNOWN" | null;
  /** Counts and date belong to latestCommitAt, not lastAttemptAt or provider execution. */
  recordsCommitted: number | null;
  recordsRejected: number | null;
  businessAsOf: string | null;
  /** Endpoint mode, not the identity of its caller. Manual calls can use either mode. */
  commitTrigger: "scheduled_primary" | "stale_retry" | "unknown" | null;
  freshness: {
    status: "CURRENT" | "STALE" | "UNKNOWN";
    checkedAt: string;
    basis: "committed_snapshot_date" | "complete_sweep_age";
    expectedBusinessAsOf: string | null;
    code: ApplicationFreshnessCode;
  };
  /** Unhealthy-only audit. It neither proves ongoing failure nor verified recovery. */
  latestFeedWarning: { at: string; code: FeedWarningCode } | null;
  stages: Array<{
    key: "TRADE_REQUEST" | "CRM_IDENTITY";
    status: "COMPLETE" | "PENDING" | "FAILED" | "UNKNOWN";
    basis: "last_completed_sweep" | "current_checkpoint";
  }>;
};

export type ApplicationAuditInput = { at: Date; detail: string | null };
export type ApplicationSweepInput = {
  last_started_at: Date | null;
  last_completed_at: Date | null;
  last_failure_at: Date | null;
  last_failure_source: string | null;
  lease_expires_at: Date | null;
  /** Boolean projections only: never copy cursor values into monitoring. */
  trade_progress: boolean;
  crm_progress: boolean;
  trade_complete: boolean;
  crm_complete: boolean;
};
