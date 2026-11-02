import "server-only";
import { createHash } from "node:crypto";
import { UNKNOWN_SCHEDULE, type JobDefinition, type JobObservation, type JobRun } from "@/lib/data-jobs/contracts";
import { instant, ProviderReadError, providerErrorCode, readProviderJson, record, safeCron, safeId, safeTimezone } from "./http";
import { DATA_JOB_PROVIDER_CONFIG } from "@/lib/data-jobs/registry";
import { nextCronRun } from "./schedule";

const MAX_PAGES = 5;
// Cloud Logging permits up to 1000 per page. Five bounded pages cover the
// 2880 start/finish events from an every-minute job's ordinary 24h window.
const PAGE_SIZE = 1000;
const DAY_MS = 86_400_000;
const START = "type.googleapis.com/google.cloud.scheduler.logging.AttemptStarted";
const FINISH = "type.googleapis.com/google.cloud.scheduler.logging.AttemptFinished";
const FAILURE_CODES = new Set(["CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED", "NOT_FOUND", "ALREADY_EXISTS", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE", "UNIMPLEMENTED", "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED"]);

export type CloudSchedulerReadConfig = { projectId: string; location: string; accessToken: string; logView?: string };

/** A custom, IAM-scoped view is required; project-wide/default log access is not a fallback. */
export function validatedSchedulerLogView(projectId: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 500) throw new ProviderReadError("provider_log_view_unconfigured");
  const match = /^projects\/([a-z][a-z0-9-]{4,61}[a-z0-9])\/locations\/([a-z0-9-]+)\/buckets\/([A-Za-z0-9_-]+)\/views\/([A-Za-z0-9_-]+)$/.exec(value);
  if (!match || match[1] !== projectId || ["_AllLogs", "_Default"].includes(match[4])) {
    throw new ProviderReadError("invalid_provider_log_view");
  }
  return value;
}

function configFor(def: JobDefinition, config: CloudSchedulerReadConfig) {
  const prefix = `projects/${config.projectId}/locations/${config.location}/jobs/`;
  const shortId = def.providerId.slice(prefix.length);
  if (def.provider !== "cloud-scheduler" || config.projectId !== DATA_JOB_PROVIDER_CONFIG[def.environment]?.gcpProject
    || config.location !== DATA_JOB_PROVIDER_CONFIG[def.environment]?.region || !def.providerId.startsWith(prefix) || !safeId(shortId)
    || !config.accessToken || /[\r\n]/.test(config.accessToken)) {
    throw new ProviderReadError("invalid_provider_configuration");
  }
  return { shortId, logName: `projects/${config.projectId}/logs/cloudscheduler.googleapis.com%2Fexecutions`,
    logView: validatedSchedulerLogView(config.projectId, config.logView) };
}

function logRow(
  def: JobDefinition, raw: unknown, now: Date,
  config: { projectId: string; location: string; shortId: string; logName: string },
): JobRun | null {
  const row = record(raw);
  const resource = record(row?.resource);
  const labels = record(resource?.labels);
  const payload = record(row?.jsonPayload);
  const id = safeId(row?.insertId);
  const at = instant(row?.timestamp);
  if (!row || !payload || !id || !at || row.logName !== config.logName
    || resource?.type !== "cloud_scheduler_job" || labels?.project_id !== config.projectId
    || labels.location !== config.location || labels.job_id !== config.shortId
    || payload.jobName !== def.providerId || payload.targetType !== "HTTP"
    || ![START, FINISH].includes(String(payload["@type"]))) return null;

  const started = payload["@type"] === START;
  const httpStatus = record(row.httpRequest)?.status;
  const acknowledged = !started && typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus <= 299;
  const failed = !started && ((typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 300 && httpStatus <= 599)
    || (typeof payload.status === "string" && FAILURE_CODES.has(payload.status)));
  const query = `logName="${config.logName}" insertId="${id}"`;
  const executionUrl = new URL("https://console.cloud.google.com/logs/query");
  executionUrl.searchParams.set("project", config.projectId);
  executionUrl.searchParams.set("query", query);
  return {
    id: `scheduler:${createHash("sha256").update(`${def.providerId}\n${config.logName}\n${id}`).digest("hex")}`,
    jobId: def.id, logicalRunId: null, retryOf: null, correlation: "event_only",
    // The logs have independent insert IDs and no shared attempt key. Do not
    // pair nearest timestamps, invent a duration, or count starts as stalled runs.
    status: started ? "UNKNOWN" : failed ? "FAILED" : acknowledged ? "ACKNOWLEDGED" : "UNKNOWN",
    evidence: "delivery_only", startedAt: started ? at : null, finishedAt: started ? null : at,
    observedAt: now.toISOString(), durationMs: null, recordsProcessed: null, recordsRejected: null,
    code: started ? "scheduler_attempt_started_unpaired" : failed ? "scheduler_delivery_failed"
      : acknowledged ? "scheduler_delivery_acknowledged" : "scheduler_delivery_status_unknown",
    executionUrl: executionUrl.href,
  };
}

/** Read configuration + independently identified scheduler log events only. */
export async function collectCloudSchedulerJob(
  def: JobDefinition, now: Date, config: CloudSchedulerReadConfig,
): Promise<JobObservation> {
  const observation: JobObservation = {
    jobId: def.id, observedAt: now.toISOString(), enabled: null, schedule: { ...UNKNOWN_SCHEDULE }, runs: [],
    coverage: "unavailable", windowStart: new Date(now.getTime() - DAY_MS).toISOString(), windowEnd: now.toISOString(), code: null,
  };
  try {
    const scoped = configFor(def, config);
    const headers = { Authorization: `Bearer ${config.accessToken}`, Accept: "application/json" };
    const jobUrl = new URL(`https://cloudscheduler.googleapis.com/v1/${def.providerId}`);
    jobUrl.searchParams.set("fields", "name,state,schedule,timeZone,scheduleTime");
    const job = record(await readProviderJson(jobUrl, { headers }));
    if (!job || job.name !== def.providerId) throw new ProviderReadError("provider_invalid_response");
    observation.enabled = job.state === "ENABLED" ? true : job.state === "PAUSED" || job.state === "DISABLED" ? false : null;
    const wake = instant(job.scheduleTime);
    const nextWakeAt = observation.enabled === true && wake && wake > now.toISOString() ? wake : null;
    const nextRunAt = observation.enabled === true && typeof job.schedule === "string" && job.schedule.trim().split(/\s+/).length === 5
      ? nextCronRun(job.schedule, job.timeZone, now) : null;
    observation.schedule = {
      ...UNKNOWN_SCHEDULE, kind: "scheduled", expression: safeCron(job.schedule), timezone: safeTimezone(job.timeZone),
      // Per Scheduler's API this can be a retry OR the next scheduled execution.
      // Expose it as an unclassified provider wake, never label it a scheduled run.
      nextWakeAt, nextWakeBasis: nextWakeAt ? "provider" : "unknown",
      nextRunAt, nextRunBasis: nextRunAt ? "calculated" : "unknown",
    };
    const filter = [
      'resource.type="cloud_scheduler_job"', `resource.labels.project_id="${config.projectId}"`,
      `resource.labels.location="${config.location}"`, `resource.labels.job_id="${scoped.shortId}"`,
      `logName="${scoped.logName}"`, `jsonPayload.jobName="${def.providerId}"`,
      `(jsonPayload."@type"="${START}" OR jsonPayload."@type"="${FINISH}")`,
      `timestamp>="${observation.windowStart}"`, `timestamp<="${observation.windowEnd}"`,
    ].join(" AND ");
    let pageToken: string | null = null;
    const seen = new Set<string>();
    const rows = new Map<string, JobRun>();
    let invalid = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL("https://logging.googleapis.com/v2/entries:list");
      url.searchParams.set("fields", "entries(insertId,logName,timestamp,resource,jsonPayload,httpRequest/status),nextPageToken");
      const result = record(await readProviderJson(url, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ resourceNames: [scoped.logView], filter, orderBy: "timestamp desc", pageSize: PAGE_SIZE, ...(pageToken ? { pageToken } : {}) }),
      }));
      // Logging represents an empty successful result as {}, not always entries:[].
      if (!result || (result.entries != null && !Array.isArray(result.entries))
        || (Array.isArray(result.entries) && result.entries.length > PAGE_SIZE)) throw new ProviderReadError("provider_invalid_response");
      for (const raw of (result.entries ?? []) as unknown[]) {
        const run = logRow(def, raw, now, { ...config, ...scoped });
        const at = run?.finishedAt ?? run?.startedAt;
        if (!run || !at || at < observation.windowStart || at > observation.windowEnd) { invalid = true; continue; }
        rows.set(run.id, run);
      }
      observation.runs = [...rows.values()];
      observation.coverage = "partial";
      if (invalid) observation.code = "provider_metadata_incomplete";
      if (result.nextPageToken == null || result.nextPageToken === "") {
        observation.coverage = invalid ? "partial" : "complete_window";
        break;
      }
      if (typeof result.nextPageToken !== "string" || result.nextPageToken.length > 2048 || seen.has(result.nextPageToken)) {
        throw new ProviderReadError("provider_invalid_pagination");
      }
      pageToken = result.nextPageToken;
      seen.add(pageToken);
      if (page === MAX_PAGES - 1) observation.code = "provider_history_truncated";
    }
    return observation;
  } catch (error) {
    observation.code = providerErrorCode(error);
    observation.coverage = observation.runs.length > 0 ? "partial" : "unavailable";
    return observation;
  }
}
