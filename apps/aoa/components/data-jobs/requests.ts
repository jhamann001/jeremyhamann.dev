import { validateApplicationEvidence } from "@/lib/data-jobs/application-evidence-validation";
import { applicationSourceForJob } from "@/lib/data-jobs/application-evidence-association";
import type { JobDefinition } from "@/lib/data-jobs/contracts";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string";
const nullableText = (value: unknown) => value === null || text(value);
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const nullableCount = (value: unknown) => value === null || count(value);

export class JobMetadataAccessError extends Error {
  constructor() { super("Monitoring access unavailable"); this.name = "JobMetadataAccessError"; }
}

function isRun(value: unknown): boolean {
  return record(value) && ["id", "jobId", "status", "evidence", "correlation", "observedAt"].every((key) => text(value[key]))
    && ["logicalRunId", "retryOf", "startedAt", "finishedAt", "code", "executionUrl"].every((key) => nullableText(value[key]))
    && ["durationMs", "recordsProcessed", "recordsRejected"].every((key) => nullableCount(value[key]));
}

function isSummary(value: unknown): boolean {
  if (!record(value) || !record(value.definition) || !record(value.stats) || !Array.isArray(value.incidents)) return false;
  const { definition, stats } = value;
  if (value.applicationEvidence != null) {
    try {
      const evidence = validateApplicationEvidence(value.applicationEvidence);
      if (evidence.environment !== definition.environment || evidence.sourceKey !== applicationSourceForJob(definition as JobDefinition)) return false;
      value.applicationEvidence = evidence;
    } catch { return false; }
  }
  if (value.applicationEvidenceStale !== undefined && typeof value.applicationEvidenceStale !== "boolean") return false;
  if (!["id", "name", "source", "environment", "provider", "trigger", "runner", "destination", "owner", "jobUrl"].every((key) => text(definition[key]))
    || !Array.isArray(definition.consumers) || !definition.consumers.every(text)
    || !["executions", "succeeded", "failed", "acknowledged", "running"].every((key) => count(stats[key]))
    || !["windowStart", "windowEnd", "rateLabel"].every((key) => text(stats[key])) || !nullableCount(stats.successRate)
    || (stats.deliveryFailed !== undefined && !count(stats.deliveryFailed))
    || !text(value.status) || !text(value.reason) || typeof value.monitoringStale !== "boolean"
    || !nullableText(value.lastSuccessAt) || !nullableText(value.lastFailureAt)
    || (value.latestRun !== null && !isRun(value.latestRun))) return false;
  if (value.observation !== null && (!record(value.observation) || !record(value.observation.schedule)
    || !text(value.observation.observedAt) || !text(value.observation.coverage))) return false;
  return value.incidents.every((incident) => record(incident) && text(incident.kind) && text(incident.openedAt) && nullableText(incident.resolvedAt));
}

/** Defensive response-envelope checks keep a bad API response in the retry state.
 * Server-side validation remains authoritative for provider evidence and allowed URLs.
 */
function isMetadataPage(value: unknown, url: string): boolean {
  if (!record(value) || !nullableText(value.nextCursor)) return false;
  if (url.split("?")[0].endsWith("/runs")) return Array.isArray(value.runs) && value.runs.length <= 25 && value.runs.every(isRun);
  return Array.isArray(value.jobs) && value.jobs.length <= 20 && value.jobs.every(isSummary)
    && text(value.generatedAt) && count(value.total) && record(value.collector)
    && nullableText(value.collector.lastCompletedAt) && typeof value.collector.stale === "boolean"
    && value.collector.alertsEnabled === false;
}

/** Same-origin metadata only; request failures never expose server error bodies. */
export async function fetchJobMetadata<T>(url: string, signal: AbortSignal): Promise<T> {
  const timeoutController = new AbortController();
  const abort = () => timeoutController.abort();
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 12_000);
  try {
    const response = await fetch(url, {
      cache: "no-store", credentials: "same-origin", signal: timeoutController.signal,
      headers: { Accept: "application/json" },
    });
    if (response.redirected || [401, 403, 404].includes(response.status)) throw new JobMetadataAccessError();
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Monitoring metadata unavailable");
    }
    const value: unknown = await response.json();
    if (!isMetadataPage(value, url)) throw new Error("Monitoring metadata unavailable");
    return value as T;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

/** Refresh only as many bounded pages as the user has opened. */
export async function fetchMetadataPages<T extends { nextCursor: string | null }>(
  url: (cursor: string | null) => string,
  pageCount: number,
  signal: AbortSignal,
): Promise<T[]> {
  const pages: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let index = 0; index < Math.min(5, Math.max(1, pageCount)); index += 1) {
    if (signal.aborted) throw new Error("Monitoring refresh canceled");
    const page: T = await fetchJobMetadata<T>(url(cursor), signal);
    pages.push(page);
    cursor = page.nextCursor;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
  return pages;
}
