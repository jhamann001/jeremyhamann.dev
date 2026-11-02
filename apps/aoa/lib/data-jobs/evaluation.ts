import type { JobDefinition, JobIncident, JobObservation, JobRun, JobSummary, IncidentKind } from "./contracts";

export const MONITOR_STALE_MS = 15 * 60_000;
export const HISTORY_WINDOW_MS = 24 * 60 * 60_000;
export const runTime = (run: JobRun) => run.finishedAt ?? run.startedAt ?? run.observedAt;
const epoch = (value: string | null | undefined) => value ? Date.parse(value) : 0;

export function observationUnavailable(observation: Pick<JobObservation, "coverage" | "code" | "observedAt"> | null, now: Date): boolean {
  const safeCoverageNotes = ["published_schedule_unavailable", "provider_execution_history_disabled", "provider_history_retention_unverified", "provider_completion_window_warming", "provider_null_start_history_unverified"];
  return !observation || observation.coverage === "unavailable"
    || Boolean(observation.code && !safeCoverageNotes.includes(observation.code))
    || now.getTime() - epoch(observation.observedAt) > MONITOR_STALE_MS;
}

/** Compare provider state, data completion and collector freshness separately. */
export function summarizeJob(definition: JobDefinition, observation: JobObservation | null,
  runs: JobRun[], incidents: JobIncident[], now: Date, expectedDueAt: string | null = null): JobSummary {
  // Coverage belongs to the provider's fixed read boundary, not the later DB commit time.
  const end = observation?.windowEnd ?? now.toISOString();
  const start = observation?.windowStart ?? new Date(now.getTime() - HISTORY_WINDOW_MS).toISOString();
  const sorted = [...runs].sort((a, b) => epoch(runTime(b)) - epoch(runTime(a)) || b.id.localeCompare(a.id));
  const windowRuns = sorted.filter((run) => epoch(runTime(run)) >= epoch(start) && epoch(runTime(run)) <= epoch(end));
  // Uncorrelated Scheduler log events cannot form execution denominators.
  const executions = windowRuns.filter((run) => run.correlation !== "event_only");
  const succeeded = executions.filter((run) => run.status === "SUCCEEDED").length;
  const failed = executions.filter((run) => run.status === "FAILED").length;
  const canceled = executions.filter((run) => run.status === "CANCELED").length;
  const terminal = succeeded + failed + canceled;
  const latestRun = sorted[0] ?? null;
  const latestTerminal = sorted.find((run) => ["SUCCEEDED", "FAILED", "CANCELED", "ACKNOWLEDGED"].includes(run.status));
  const lastSuccessAt = sorted.find((run) => run.status === "SUCCEEDED")?.finishedAt ?? null;
  const lastFailureAt = sorted.find((run) => run.status === "FAILED")?.finishedAt ?? null;
  const activeRuns = sorted.filter((run) => run.status === "RUNNING" && run.correlation !== "event_only");
  const pendingUnknown = sorted.filter((run) => run.status === "UNKNOWN" && run.evidence === "provider_execution" && run.correlation !== "event_only");
  const active = activeRuns.find((run) => run.startedAt && now.getTime() - epoch(run.startedAt) > definition.maxRunSeconds * 1000) ?? activeRuns[0];
  const monitoringStale = observationUnavailable(observation, now)
    || [...activeRuns, ...pendingUnknown].some((run) => now.getTime() - epoch(run.observedAt) > MONITOR_STALE_MS);
  let status: JobSummary["status"] = "UNKNOWN";
  let reason = "No complete execution evidence has been collected. Missing evidence is not a success.";
  const laterAttempt = (due: string) => sorted.some((run) => epoch(run.startedAt ?? run.finishedAt) >= epoch(due));
  if (observation?.enabled === false) {
    status = "PAUSED";
    reason = definition.expectedEnabled ? "Provider is disabled; this registered job is expected to be enabled." : "Provider is intentionally disabled.";
  } else if (active && epoch(active.startedAt) && now.getTime() - epoch(active.startedAt) > definition.maxRunSeconds * 1000) {
    status = monitoringStale ? "UNKNOWN" : "STALLED";
    reason = monitoringStale ? "The monitor cannot confirm whether the recorded run is still active." : "The provider reports a run beyond its reviewed runtime limit.";
  } else if (active) {
    status = monitoringStale ? "UNKNOWN" : "RUNNING";
    reason = "The provider reported an active execution. Data completion is not yet confirmed.";
  } else if (pendingUnknown.length) {
    status = "UNKNOWN";
    reason = "A provider execution is waiting or its state is unknown. A previous successful result does not prove it completed.";
  } else if (latestTerminal?.status === "FAILED" || latestTerminal?.status === "CANCELED") {
    status = "FAILED";
    reason = "Latest recorded terminal result failed or was canceled. Historical failures remain in run history after recovery.";
  } else if (!monitoringStale && expectedDueAt && observation?.coverage === "complete_window" && observation.enabled === true
    && now.getTime() > epoch(expectedDueAt) + definition.graceSeconds * 1000 && !laterAttempt(expectedDueAt)) {
    status = "OVERDUE";
    reason = "No start evidence was observed after a previously published next scheduled run plus its grace period.";
  } else if (!monitoringStale && latestTerminal?.status === "SUCCEEDED") {
    status = "HEALTHY";
    reason = latestTerminal.evidence === "application_commit" ? "Application commitment was verified. Source freshness remains a separate check."
      : "Latest provider execution succeeded. This does not independently verify every imported record or source freshness.";
  } else if (latestTerminal?.status === "ACKNOWLEDGED") {
    reason = "Scheduler delivery was acknowledged. Import completion and exact retry correlation are not independently verified.";
  }
  const { runs: _runs, ...metadata } = observation ?? { runs: [] };
  return { definition, status, reason, observation: observation ? metadata as Omit<JobObservation, "runs"> : null,
    monitoringStale, latestRun, lastSuccessAt, lastFailureAt, incidents,
    stats: { windowStart: start, windowEnd: end, executions: executions.length, succeeded, failed,
      acknowledged: windowRuns.filter((run) => run.status === "ACKNOWLEDGED").length,
      deliveryFailed: windowRuns.filter((run) => run.correlation === "event_only" && run.status === "FAILED").length,
      running: executions.filter((run) => run.status === "RUNNING").length,
      successRate: terminal && observation?.coverage === "complete_window" ? succeeded / terminal * 100 : null,
      rateLabel: observation?.coverage === "complete_window"
        ? "Terminal provider attempts · 24 hours; not an end-to-end data match rate"
        : "Rate unavailable: execution-history coverage is incomplete; counts are observed evidence only" } };
}

export function incidentKinds(summary: JobSummary): IncidentKind[] {
  const kinds: IncidentKind[] = [];
  if (summary.monitoringStale) kinds.push("monitoring_unavailable");
  if (summary.status === "FAILED" || (summary.status === "PAUSED" && summary.definition.expectedEnabled)) kinds.push("failure");
  if (summary.status === "STALLED") kinds.push("stalled");
  if (summary.status === "OVERDUE") kinds.push("overdue");
  return kinds;
}

/** Keep a due date until evidence covers it; a newer provider schedule cannot erase a missed run. */
export function nextExpectedDue(previous: string | null, observation: JobObservation): string | null {
  if (observation.enabled === false) return null;
  if (observation.coverage !== "unavailable" && ["manual", "event"].includes(observation.schedule.kind)) return null;
  if (previous && !observation.runs.some((run) => epoch(run.startedAt ?? run.finishedAt) >= epoch(previous))) return previous;
  // A provider wake can mean a retry, so it is deliberately not a scheduled-run deadline.
  return observation.schedule.kind === "scheduled" ? observation.schedule.nextRunAt : null;
}

/** Idempotent polling must never regress a terminal attempt back to running. */
export function shouldReplaceRun(previous: JobRun, incoming: JobRun): boolean {
  if (epoch(incoming.observedAt) < epoch(previous.observedAt)) return false;
  const terminal = (run: JobRun) => !["RUNNING", "UNKNOWN"].includes(run.status);
  return !terminal(previous) || terminal(incoming);
}
