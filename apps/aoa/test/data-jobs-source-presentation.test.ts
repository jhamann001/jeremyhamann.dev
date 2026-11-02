import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobCard, JobRunTable } from "@/components/data-jobs/JobCard";
import { fetchJobMetadata } from "@/components/data-jobs/requests";
import { applicationAttention } from "@/lib/data-jobs/application-attention";
import { evaluateAccountAumEvidence, evaluateReviewQueueEvidence } from "@/lib/data-jobs/application-evidence-evaluation";
import type { JobApplicationEvidence } from "@/lib/data-jobs/application-evidence-types";
import { UNKNOWN_SCHEDULE, type JobListResponse, type JobObservation, type JobRun, type JobSummary } from "@/lib/data-jobs/contracts";
import { summarizeJob } from "@/lib/data-jobs/evaluation";
import { getDataJobs } from "@/lib/data-jobs/registry";

const NOW = new Date("2026-09-18T15:00:00.000Z");
const observedAt = NOW.toISOString();
const at = (time: string) => new Date(`2026-09-18T${time}:00.000Z`);
const definitions = getDataJobs("prod");
const definitionFor = (evidence: JobApplicationEvidence) => definitions.find((definition) =>
  definition.id === (evidence.sourceKey === "ACCOUNT_AUM" ? "prod-account-aum" : "prod-review-queue"))!;
function aum(changes: Record<string, unknown> = {}, warning = false) {
  return evaluateAccountAumEvidence("prod", {
    audits: [{ at: at("13:00"), detail: JSON.stringify({ dry_run: false, upserted: 100,
      received: 100, rejected: 0, as_of_max: "2026-09-17", trigger: "scheduled_primary", ...changes }) }],
    warning: warning ? { at: at("14:00"), detail: JSON.stringify({ reason: "incomplete_coverage" }) } : null,
  }, NOW);
}
function failedSweep() {
  return evaluateReviewQueueEvidence("prod", {
    last_started_at: at("14:55"), last_completed_at: at("14:00"), last_failure_at: at("14:56"),
    last_failure_source: "CRM_IDENTITY", lease_expires_at: null,
    trade_progress: false, crm_progress: true, trade_complete: true, crm_complete: false,
  }, NOW);
}
function fixture(evidence: JobApplicationEvidence = aum()): { job: JobSummary; run: JobRun } {
  const definition = definitionFor(evidence);
  const run: JobRun = {
    id: "scheduler:synthetic-ack", jobId: definition.id, logicalRunId: null, retryOf: null,
    correlation: "event_only", status: "ACKNOWLEDGED", evidence: "delivery_only",
    startedAt: null, finishedAt: at("14:58").toISOString(), observedAt,
    durationMs: null, recordsProcessed: null, recordsRejected: null, code: "DELIVERY_ACKNOWLEDGED",
    executionUrl: null,
  };
  const observation: JobObservation = { jobId: definition.id, observedAt, enabled: true,
    schedule: { ...UNKNOWN_SCHEDULE }, runs: [run], coverage: "complete_window",
    windowStart: "2026-09-17T15:00:00.000Z", windowEnd: observedAt, code: null };
  const summary = summarizeJob(definition, observation, [run], [], NOW);
  return { job: { ...summary, applicationEvidence: evidence, applicationEvidenceStale: false }, run };
}
function render(job: JobSummary, expanded = false, runs: JobRun[] = []) {
  return renderToStaticMarkup(React.createElement(JobCard, { job, expanded,
    onToggle: () => undefined, onRetryHistory: () => undefined, onMoreHistory: () => undefined,
    history: { data: { runs, nextCursor: null }, loading: false, error: false, limited: false },
  }));
}
function page(job: JobSummary): JobListResponse {
  return { generatedAt: observedAt, jobs: [job], total: 1, nextCursor: null,
    collector: { lastCompletedAt: observedAt, stale: false, alertsEnabled: false } };
}
function fetched(value: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
  return fetchJobMetadata<JobListResponse>("/api/data-health/jobs", new AbortController().signal);
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("source evidence in collapsed job cards", () => {
  it("shows a source failure even though Scheduler acknowledged delivery", () => {
    const { job } = fixture(failedSweep());
    const html = render(job);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Application failed");
    expect(html).not.toContain("AOA source completion</h3>");
    expect(html).not.toContain("Execution history");
    expect(job.latestRun?.status).toBe("ACKNOWLEDGED");
    expect(job.status).not.toBe("FAILED");
    expect(applicationAttention(job, NOW)).toEqual({ label: "Application failed", tone: "red" });
  });

  it("shows partial commitment independently from provider health", () => {
    const { job } = fixture(aum({ received: 105, rejected: 5 }));
    expect(render(job)).toContain("Partial source result");
    const expanded = render(job, true);
    expect(expanded).toContain("100 / 5");
    expect(expanded).toContain("Counts belong to the committed result above, not a provider attempt.");
    expect(job.stats.successRate).toBeNull();
  });

  it("shows a stale source business date without inventing failed provider execution", () => {
    const { job } = fixture(aum({ as_of_max: "2026-09-14" }));
    expect(render(job)).toContain("Source data stale");
    expect(job.stats.failed).toBe(0);
    expect(render(job, true)).toContain("Stale at last check");
  });

  it("does not interpret a historical unhealthy-only warning as a current source failure", () => {
    const { job } = fixture(aum({}, true));
    expect(applicationAttention(job, NOW)).toBeNull();
    expect(render(job)).not.toContain("Application failed");
    expect(render(job, true)).toContain("this warning does not prove an ongoing failure or a verified recovery");
  });

  it("marks malformed/missing supplemental evidence unverified while keeping the provider card usable", () => {
    const { job } = fixture();
    job.applicationEvidence = null;
    job.applicationEvidenceStale = true;
    expect(render(job)).toContain("Source unverified");
    expect(render(job, true)).toContain("AOA source evidence could not be verified. Provider history remains available separately.");
  });
});

describe("cached source evidence ages independently", () => {
  it("recomputes freshness at render after a failed/absent refresh even when the server stale flag was false", () => {
    const { job } = fixture();
    expect(render(job, true)).toContain("Current at last check");
    vi.setSystemTime(new Date("2026-09-18T15:16:00.000Z"));
    const html = render(job, true);
    expect(html).toContain("Source unverified");
    expect(html).toContain("Not currently verified");
    expect(html).not.toContain("Current at last check");
    expect(html).toContain("Last-known timestamps are historical only");
    expect(html).toContain("Last committed source result");
    expect(html).toContain("100 / 0");
    expect(job.applicationEvidenceStale).toBe(false);
    expect(job.applicationEvidence?.freshness.status).toBe("CURRENT");
  });

  it("obeys an explicit server-side stale verdict even before the local age limit", () => {
    const { job } = fixture();
    job.applicationEvidenceStale = true;
    expect(render(job, true)).not.toContain("Current at last check");
    expect(render(job)).toContain("Source unverified");
  });

  it("treats a future-dated observation as unverified at presentation", () => {
    const { job } = fixture();
    vi.setSystemTime(new Date("2026-09-18T14:59:00.000Z"));
    expect(render(job, true)).not.toContain("Current at last check");
    expect(render(job)).toContain("Source unverified");
  });
});

describe("application evidence cannot rewrite provider statistics", () => {
  it.each(["complete", "partial", "failed"] as const)("keeps provider counts/rates/history unchanged for %s application evidence", (kind) => {
    const evidence = kind === "failed" ? failedSweep() : kind === "partial" ? aum({ received: 105, rejected: 5 }) : aum();
    const { job, run } = fixture(evidence);
    const before = JSON.stringify({ stats: job.stats, latestRun: job.latestRun, status: job.status });
    const historyBefore = renderToStaticMarkup(React.createElement(JobRunTable, { runs: [run] }));
    const html = render(job, true, [run]);
    expect(html).toContain("This snapshot is not linked to a specific provider execution and does not change its success rate.");
    expect(html).toContain("<dt>Execution success rate</dt><dd>Not available</dd>");
    expect(html).toContain("<dt>Delivery acknowledged</dt><dd>1</dd>");
    expect(html).not.toContain("100%");
    expect(JSON.stringify({ stats: job.stats, latestRun: job.latestRun, status: job.status })).toBe(before);
    expect(renderToStaticMarkup(React.createElement(JobRunTable, { runs: [run] }))).toBe(historyBefore);
    expect(run.recordsProcessed).toBeNull();
    expect(run.recordsRejected).toBeNull();
  });
});

describe("source-evidence response envelope", () => {
  it("returns sanitized source evidence rather than the original nested response fields", async () => {
    const { job } = fixture(aum({}, true));
    const evidence = job.applicationEvidence!;
    const response = page(job);
    const payload = { ...response, jobs: [{ ...job, applicationEvidence: {
      ...evidence, raw: "SYNTHETIC_SECRET_DO_NOT_COPY",
      freshness: { ...evidence.freshness, query: "SYNTHETIC_SECRET_DO_NOT_COPY" },
      latestFeedWarning: { ...evidence.latestFeedWarning, body: "SYNTHETIC_SECRET_DO_NOT_COPY" },
    } }] };
    const result = await fetched(payload);
    expect(result.jobs[0].applicationEvidence).toEqual(evidence);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SECRET_DO_NOT_COPY");
    expect(result.jobs[0].stats).toEqual(job.stats);
  });

  it("strips nested review stage extras", async () => {
    const { job } = fixture(failedSweep());
    const evidence = job.applicationEvidence!;
    const result = await fetched(page({ ...job, applicationEvidence: { ...evidence,
      stages: evidence.stages.map((stage) => ({ ...stage, privateField: "SYNTHETIC_PRIVATE" })),
    } }));
    expect(result.jobs[0].applicationEvidence).toEqual(evidence);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE");
  });

  it("rejects a valid source snapshot from the wrong environment", async () => {
    const { job } = fixture();
    await expect(fetched(page({ ...job, applicationEvidence: { ...job.applicationEvidence!, environment: "dev" } })))
      .rejects.toThrow("Monitoring metadata unavailable");
  });

  it.each(["wrong-source", "unregistered-job", "wrong-provider"])("rejects a valid snapshot with %s association", async (variant) => {
    const { job } = fixture();
    if (variant === "wrong-source") job.applicationEvidence = failedSweep();
    if (variant === "unregistered-job") job.definition = { ...job.definition, id: "prod-unregistered-import" };
    if (variant === "wrong-provider") job.definition = { ...job.definition, provider: "n8n" };
    await expect(fetched(page(job))).rejects.toThrow("Monitoring metadata unavailable");
  });

  it("rejects malformed evidence without returning its raw contents", async () => {
    const { job } = fixture();
    const payload = page(job);
    (payload.jobs[0].applicationEvidence as unknown as Record<string, unknown>).code = "SYNTHETIC_SECRET_ERROR";
    await expect(fetched(payload)).rejects.toThrow("Monitoring metadata unavailable");
  });
});
