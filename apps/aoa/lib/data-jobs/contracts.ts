import type { JobApplicationEvidence } from "./application-evidence-types";

/** PII-free monitoring metadata only. Never store execution input/output or exception text. */
export type JobProvider = "n8n" | "cloud-scheduler";
export type JobEnvironment = "dev" | "prod";
export type JobStatus = "UNKNOWN" | "HEALTHY" | "FAILED" | "RUNNING" | "OVERDUE" | "STALLED" | "PAUSED";
export type JobFilter = JobStatus | "SOURCE_ATTENTION" | "";
export type RunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "ACKNOWLEDGED" | "UNKNOWN";
export type EvidenceLevel = "provider_execution" | "delivery_only" | "application_commit";
export type IncidentKind = "failure" | "overdue" | "stalled" | "monitoring_unavailable";

export type JobDefinition = {
  id: string;
  name: string;
  source: string;
  environment: JobEnvironment;
  provider: JobProvider;
  providerId: string;
  trigger: string;
  runner: string;
  destination: string;
  consumers: string[];
  owner: string;
  jobUrl: string;
  runbookUrl?: string;
  expectedEnabled: boolean;
  graceSeconds: number;
  maxRunSeconds: number;
};

export type JobSchedule = {
  kind: "scheduled" | "manual" | "event" | "unknown";
  expression: string | null;
  timezone: string | null;
  nextRunAt: string | null;
  nextRunBasis: "provider" | "calculated" | "unknown";
  nextRetryAt: string | null;
  /** Scheduler can publish a wake-up that is either a retry or a schedule. */
  nextWakeAt?: string | null;
  nextWakeBasis?: "provider" | "unknown";
};

export type JobRun = {
  id: string;
  jobId: string;
  logicalRunId: string | null;
  retryOf: string | null;
  correlation: "exact" | "attempt_only" | "event_only";
  status: RunStatus;
  evidence: EvidenceLevel;
  startedAt: string | null;
  finishedAt: string | null;
  observedAt: string;
  durationMs: number | null;
  recordsProcessed: number | null;
  recordsRejected: number | null;
  code: string | null;
  executionUrl: string | null;
};

export type JobObservation = {
  jobId: string;
  observedAt: string;
  enabled: boolean | null;
  schedule: JobSchedule;
  runs: JobRun[];
  coverage: "complete_window" | "partial" | "unavailable";
  windowStart: string;
  windowEnd: string;
  code: string | null;
};

export type JobIncident = {
  kind: IncidentKind;
  openedAt: string;
  resolvedAt: string | null;
  delivery: "DISABLED";
};

export type JobSummary = {
  definition: JobDefinition;
  status: JobStatus;
  reason: string;
  observation: Omit<JobObservation, "runs"> | null;
  monitoringStale: boolean;
  latestRun: JobRun | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  incidents: JobIncident[];
  /** Source-level commit evidence; never paired to a provider execution by time. */
  applicationEvidence?: JobApplicationEvidence | null;
  applicationEvidenceStale?: boolean;
  stats: {
    windowStart: string;
    windowEnd: string;
    executions: number;
    succeeded: number;
    failed: number;
    acknowledged: number;
    deliveryFailed?: number;
    running: number;
    successRate: number | null;
    rateLabel: string;
  };
};

export type JobListResponse = {
  generatedAt: string;
  jobs: JobSummary[];
  nextCursor: string | null;
  total: number;
  collector: { lastCompletedAt: string | null; stale: boolean; alertsEnabled: false };
};
export type JobHistoryResponse = { runs: JobRun[]; nextCursor: string | null };

export const UNKNOWN_SCHEDULE: JobSchedule = {
  kind: "unknown", expression: null, timezone: null, nextRunAt: null,
  nextRunBasis: "unknown", nextRetryAt: null,
};
