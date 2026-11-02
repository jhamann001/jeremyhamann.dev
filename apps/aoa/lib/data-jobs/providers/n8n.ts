import "server-only";
import { UNKNOWN_SCHEDULE, type JobDefinition, type JobRun, type JobSchedule, type RunStatus } from "@/lib/data-jobs/contracts";
import { instant, ProviderReadError, providerErrorCode, readProviderJson, record, safeCron, safeId, safeTimezone } from "./http";
import { DATA_JOB_PROVIDER_CONFIG } from "@/lib/data-jobs/registry";
import { nextCronRun } from "./schedule";
import { collectIncrementalN8nExecutions, type N8nIncrementalConfig, type N8nJobObservation } from "./n8n-coverage";

// Explicit environment isolation; never send an API key to a URL from telemetry.
const MAX_PAGES = 5;
const PAGE_SIZE = 200;
const DAY_MS = 86_400_000;

function baseUrl(def: JobDefinition, configured: string): URL {
  const base = new URL(configured);
  if (def.provider !== "n8n" || !safeId(def.providerId) || base.origin !== DATA_JOB_PROVIDER_CONFIG[def.environment]?.n8nOrigin
    || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new ProviderReadError("invalid_provider_configuration");
  }
  return base;
}

function intervalText(value: unknown): string | null {
  const rule = record(value);
  if (!rule) return null;
  if (rule.field === "cronExpression") return safeCron(rule.expression);
  // n8n Schedule Trigger 1.x defaults are part of its published node contract.
  // A missing field means days, not an unknown trigger or a made-up cron rule.
  const field = rule.field ?? "days";
  const fields: Record<string, string> = { seconds: "secondsInterval", minutes: "minutesInterval", hours: "hoursInterval", days: "daysInterval", weeks: "weeksInterval", months: "monthsInterval" };
  const defaults: Record<string, number> = { seconds: 30, minutes: 5, hours: 1, days: 1, weeks: 1, months: 1 };
  if (typeof field !== "string" || !Object.hasOwn(fields, field)) return null;
  const count = rule[fields[field]] ?? defaults[field];
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 86_400) return null;
  if (field === "seconds" || field === "minutes") return `Every ${count} ${field}`;
  // Missing wall-clock parts can be filled by provider jitter, not necessarily
  // the editor's displayed default. Never silently turn an omitted minute into 0.
  const hour = rule.triggerAtHour;
  const minute = rule.triggerAtMinute;
  if ((hour != null && (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23))
    || (minute != null && (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59))) return null;
  if (field === "hours") return `Every ${count} hours${minute != null ? ` at minute ${minute}` : " (minute unverified)"}`;
  const time = hour == null ? "an unverified time" : minute == null
    ? `hour ${String(hour).padStart(2, "0")} (minute unverified)`
    : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  if (field === "weeks") {
    const days = rule.triggerAtDay ?? [0];
    if (!Array.isArray(days) || days.length === 0 || days.length > 7
      || !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) return null;
    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `Every ${count} weeks: ${days.map((day: number) => labels[day]).join(", ")} at ${time}`;
  }
  if (field === "months") {
    const day = rule.triggerAtDayOfMonth;
    if (day == null) return `Every ${count} months (day unverified) at ${time}`;
    if (!Number.isInteger(day) || (day as number) < 1 || (day as number) > 31) return null;
    return `Every ${count} months on day ${day} at ${time}`;
  }
  // An honest cadence label, not a made-up seconds anchor/next-run timestamp.
  return `Every ${count} days at ${time}`;
}

/** Draft node changes do not alter the observed live schedule. */
export function publishedN8nSchedule(workflow: Record<string, unknown>, now: Date, configuredTimezone?: string): JobSchedule {
  const published = record(workflow.activeVersion);
  const versionId = safeId(workflow.activeVersionId);
  if (!published || !versionId || published.versionId !== versionId || !Array.isArray(published.nodes)) return { ...UNKNOWN_SCHEDULE };
  // Workflow settings are stored on the workflow (not copied into every history
  // version). Only an explicit provider timezone is evidence; never assume ET.
  const timezone = safeTimezone(record(published.settings)?.timezone ?? record(workflow.settings)?.timezone ?? configuredTimezone);
  const nodes = published.nodes.map(record).filter((node) => node && node.disabled !== true);
  const schedules = nodes.filter((node) => node?.type === "n8n-nodes-base.scheduleTrigger");
  if (schedules.length > 0) {
    const intervals = schedules.flatMap((node) => {
      const intervals = record(record(node?.parameters)?.rule)?.interval;
      return Array.isArray(intervals) ? intervals : [null];
    });
    const expressions = intervals.map(intervalText);
    const next = intervals.map((interval) => record(interval)?.field === "cronExpression"
      ? nextCronRun(record(interval)?.expression, timezone, now) : null);
    const nextRunAt = workflow.active === true && next.length > 0 && next.every((at) => at != null)
      ? (next as string[]).sort()[0] : null;
    return { ...UNKNOWN_SCHEDULE, kind: "scheduled", timezone, nextRunAt,
      nextRunBasis: nextRunAt ? "calculated" : "unknown",
      expression: expressions.length > 0 && expressions.every((value) => value != null)
        ? expressions.join("; ").slice(0, 500) : null };
  }
  if (nodes.some((node) => ["n8n-nodes-base.webhook", "n8n-nodes-base.errorTrigger", "n8n-nodes-base.executeWorkflowTrigger"].includes(String(node?.type)))) {
    return { ...UNKNOWN_SCHEDULE, kind: "event", timezone };
  }
  if (nodes.some((node) => node?.type === "n8n-nodes-base.manualTrigger")) {
    return { ...UNKNOWN_SCHEDULE, kind: "manual", timezone };
  }
  return { ...UNKNOWN_SCHEDULE, timezone };
}

const STATUSES: Record<string, RunStatus> = {
  success: "SUCCEEDED", error: "FAILED", crashed: "FAILED", canceled: "CANCELED",
  running: "RUNNING", new: "RUNNING", waiting: "UNKNOWN",
};

function executionRow(def: JobDefinition, base: URL, raw: unknown, now: Date): JobRun | null {
  const row = record(raw);
  const id = safeId(row?.id);
  if (!row || !id || row.workflowId !== def.providerId) return null;
  const startedAt = instant(row.startedAt);
  // A waiting execution's stoppedAt marks suspension, not final completion.
  const finishedAt = ["success", "error", "crashed", "canceled"].includes(String(row.status)) ? instant(row.stoppedAt) : null;
  const status = typeof row.status === "string" && Object.hasOwn(STATUSES, row.status) ? STATUSES[row.status] : "UNKNOWN";
  if ((startedAt && finishedAt && finishedAt < startedAt)
    || (["SUCCEEDED", "FAILED", "CANCELED"].includes(status) && !finishedAt)) return null;
  const retryOf = safeId(row.retryOf);
  const retryKnown = row.retryOf === null || retryOf != null;
  const idFor = (value: string) => `n8n:${def.providerId}:${value}`;
  const duration = startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null;
  return {
    id: idFor(id), jobId: def.id, logicalRunId: retryKnown && !retryOf ? idFor(id) : null,
    retryOf: retryOf ? idFor(retryOf) : null, correlation: retryKnown && !retryOf ? "exact" : "attempt_only",
    status, evidence: "provider_execution", startedAt, finishedAt, observedAt: now.toISOString(),
    durationMs: duration != null && duration >= 0 ? duration : null,
    recordsProcessed: null, recordsRejected: null,
    code: status === "FAILED" ? "n8n_execution_failed" : row.status === "waiting" ? "n8n_execution_waiting" : null,
    executionUrl: new URL(`/workflow/${def.providerId}/executions/${id}`, base).href,
  };
}

/** Resolve only explicit retry links present in this window; never time-pair runs. */
function correlateRetries(runs: JobRun[]): void {
  const byId = new Map(runs.map((run) => [run.id, run]));
  for (const run of runs) {
    let current = run;
    const seen = new Set<string>();
    while (current.retryOf && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.retryOf);
      if (!parent) break;
      current = parent;
    }
    if (!current.retryOf && current.logicalRunId) { run.logicalRunId = current.logicalRunId; run.correlation = "exact"; }
  }
}

/** Metadata-only API reads. Provider success is not proof of AOA data commit. */
export async function collectN8nJob(
  def: JobDefinition, now: Date, config: { baseUrl: string; apiKey: string; timezone?: string; incremental?: N8nIncrementalConfig },
): Promise<N8nJobObservation> {
  const observation: N8nJobObservation = {
    jobId: def.id, observedAt: now.toISOString(), enabled: null, schedule: { ...UNKNOWN_SCHEDULE }, runs: [],
    coverage: "unavailable", windowStart: new Date(now.getTime() - DAY_MS).toISOString(), windowEnd: now.toISOString(), code: null,
  };
  try {
    const base = baseUrl(def, config.baseUrl);
    if (!config.apiKey || /[\r\n]/.test(config.apiKey)) throw new ProviderReadError("invalid_provider_configuration");
    const headers = { "X-N8N-API-KEY": config.apiKey, Accept: "application/json" };
    const workflowUrl = new URL(`/api/v1/workflows/${def.providerId}`, base);
    workflowUrl.searchParams.set("excludePinnedData", "true");
    const workflow = record(await readProviderJson(workflowUrl, { headers }));
    if (!workflow || workflow.id !== def.providerId) throw new ProviderReadError("provider_invalid_response");
    observation.enabled = typeof workflow.active === "boolean" ? workflow.active : null;
    observation.schedule = publishedN8nSchedule(workflow, now, config.timezone);
    if (observation.schedule.kind === "unknown") observation.code = "published_schedule_unavailable";
    let cursor: string | null = null;
    const seen = new Set<string>();
    const rows = new Map<string, JobRun>();
    const anchors = new Map<string, JobRun>();
    const allRows = () => [...new Map([...rows, ...[...anchors.values()].map((run) => [run.id, run] as const)]).values()];
    const settings = record(workflow.settings);
    const historySaved = settings?.saveDataSuccessExecution === "all" && settings?.saveDataErrorExecution === "all";
    const historyDisabled = settings?.saveDataSuccessExecution === "none" || settings?.saveDataErrorExecution === "none";
    if (!historySaved) observation.code = historyDisabled ? "provider_execution_history_disabled" : "provider_history_retention_unverified";
    if (config.incremental) {
      const result = await collectIncrementalN8nExecutions({ def, now, base, headers, observation, config: config.incremental,
        normalize: (raw) => executionRow(def, base, raw, now) });
      correlateRetries(result.runs);
      return result;
    }
    // Workflow-level "save all" is not proof of the instance's age/count
    // pruning policy or that earlier outcomes were retained. Even exhausted
    // pagination is observed history, not a proven complete 24-hour window.
    if (!observation.code || observation.code === "published_schedule_unavailable") observation.code = "provider_history_retention_unverified";
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL("/api/v1/executions", base);
      url.searchParams.set("workflowId", def.providerId);
      url.searchParams.set("includeData", "false");
      url.searchParams.set("limit", String(PAGE_SIZE));
      if (cursor) url.searchParams.set("cursor", cursor);
      const result = record(await readProviderJson(url, { headers }));
      if (!result || !Array.isArray(result.data) || result.data.length > PAGE_SIZE) throw new ProviderReadError("provider_invalid_response");
      let invalid = false;
      for (const raw of result.data) {
        const run = executionRow(def, base, raw, now);
        if (!run) { invalid = true; continue; }
        const instantAt = run.finishedAt ?? run.startedAt;
        if (!instantAt || Date.parse(instantAt) > now.getTime()) { invalid = true; continue; }
        if (instantAt >= observation.windowStart || run.status === "RUNNING") rows.set(run.id, run);
        // Preserve bounded last-known anchors so a weekend page can still show
        // Friday's last result. These are not part of the 24h rate denominator.
        for (const key of ["latest", ...(run.status === "SUCCEEDED" ? ["success"] : []), ...(["FAILED", "CANCELED"].includes(run.status) ? ["failure"] : [])]) {
          const prior = anchors.get(key);
          if (!prior || instantAt > (prior.finishedAt ?? prior.startedAt ?? "")) anchors.set(key, run);
        }
      }
      observation.runs = allRows();
      observation.coverage = "partial";
      if (invalid) observation.code = "provider_metadata_incomplete";
      if (result.nextCursor == null || result.nextCursor === "") {
        // Do not infer completeness from the end of retained provider history.
        // Only the independently reviewed incremental proof can certify it.
        break;
      }
      if (typeof result.nextCursor !== "string" || result.nextCursor.length > 2048 || seen.has(result.nextCursor)) {
        throw new ProviderReadError("provider_invalid_pagination");
      }
      cursor = result.nextCursor;
      seen.add(cursor);
      if (page === MAX_PAGES - 1) observation.code = "provider_history_truncated";
    }
    // The public API's unfiltered list omits active executions. Query these
    // separately, without asking for any execution payload/input/output data.
    const runningUrl = new URL("/api/v1/executions", base);
    runningUrl.searchParams.set("workflowId", def.providerId);
    runningUrl.searchParams.set("includeData", "false");
    runningUrl.searchParams.set("status", "running");
    runningUrl.searchParams.set("limit", String(PAGE_SIZE));
    const active = record(await readProviderJson(runningUrl, { headers }));
    if (!active || !Array.isArray(active.data) || active.data.length > PAGE_SIZE) throw new ProviderReadError("provider_invalid_response");
    for (const raw of active.data) {
      const run = executionRow(def, base, raw, now);
      if (!run || run.status !== "RUNNING" || !run.startedAt || run.startedAt > observation.windowEnd) {
        observation.coverage = "partial"; observation.code = "provider_metadata_incomplete"; continue;
      }
      const existing = rows.get(run.id);
      if (!existing || existing.status === "RUNNING" || existing.status === "UNKNOWN") rows.set(run.id, run);
    }
    observation.runs = allRows();
    if (active.nextCursor) { observation.coverage = "partial"; observation.code = "provider_history_truncated"; }
    correlateRetries(observation.runs);
    return observation;
  } catch (error) {
    observation.code = providerErrorCode(error);
    observation.coverage = observation.runs.length > 0 ? "partial" : "unavailable";
    return observation;
  }
}
