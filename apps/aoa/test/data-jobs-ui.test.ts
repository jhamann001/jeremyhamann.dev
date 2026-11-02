import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JobRun, JobSummary } from "@/lib/data-jobs/contracts";
import { UNKNOWN_SCHEDULE } from "@/lib/data-jobs/contracts";
import { JobCard, JobRunTable } from "@/components/data-jobs/JobCard";
import { JobsMonitor } from "@/components/data-jobs/JobsMonitor";
import { durationLabel, historyUrl, jobTimestamp, listUrl, nextRunLabel, successRateLabel, uniqueById } from "@/components/data-jobs/presentation";

const observedAt = "2026-09-18T14:00:00.000Z";
const run: JobRun = {
  id: "example-attempt", jobId: "synthetic-import", logicalRunId: null, retryOf: null,
  correlation: "attempt_only", status: "ACKNOWLEDGED", evidence: "delivery_only",
  startedAt: observedAt, finishedAt: observedAt, observedAt, durationMs: 1200,
  recordsProcessed: null, recordsRejected: null, code: "DELIVERY_ACKNOWLEDGED",
  executionUrl: "https://console.cloud.google.com/logs/query?project=synthetic-project",
};
const job: JobSummary = {
  definition: {
    id: "synthetic-import", name: "Synthetic source import", source: "Example source", environment: "dev", provider: "cloud-scheduler", providerId: "synthetic-provider",
    trigger: "Scheduled wake-up", runner: "Example worker", destination: "Example mirror", consumers: ["Example report"], owner: "Operations",
    jobUrl: "https://console.cloud.google.com/cloudscheduler?project=synthetic-project", expectedEnabled: true, graceSeconds: 600, maxRunSeconds: 600,
  },
  status: "UNKNOWN", reason: "Delivery is observed; AOA commit is not confirmed.",
  observation: { jobId: "synthetic-import", observedAt, enabled: true, schedule: { ...UNKNOWN_SCHEDULE, kind: "scheduled", expression: "0 9 * * 1-5", timezone: "America/New_York", nextWakeAt: "2026-09-21T13:00:00.000Z", nextWakeBasis: "provider" }, coverage: "partial", windowStart: "2026-09-11T14:00:00.000Z", windowEnd: observedAt, code: null },
  monitoringStale: true, latestRun: run, lastSuccessAt: null, lastFailureAt: null, incidents: [],
  stats: { windowStart: "2026-09-11T14:00:00.000Z", windowEnd: observedAt, executions: 1, succeeded: 0, failed: 0, acknowledged: 1, running: 0, successRate: null, rateLabel: "Provider execution success rate; delivery-only observations excluded." },
};

function renderCard(expanded = true, value = job) {
  return renderToStaticMarkup(React.createElement(JobCard, {
    job: value, expanded, onToggle: () => undefined, history: { data: { runs: [run], nextCursor: null }, loading: false, error: false, limited: false },
    onRetryHistory: () => undefined, onMoreHistory: () => undefined,
  }));
}

describe("Data sources & jobs presentation", () => {
  it("starts compact and does not render collapsed history or internal detail", () => {
    const html = renderCard(false);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Synthetic source import");
    expect(html).toContain("Monitoring stale");
    expect(html).not.toContain("Execution history");
    expect(html).not.toContain("Example mirror");
  });

  it("shows the source-to-consumer path, provenance and disabled alert state when expanded", () => {
    const html = renderCard();
    expect(html).toContain('aria-controls="job-panel-synthetic-import"');
    expect(html).toContain('aria-label="Data journey"');
    for (const value of ["Example source", "Scheduled wake-up", "Example worker", "Example mirror", "Example report", "America/New_York"]) expect(html).toContain(value);
    expect(html).toContain("Slack delivery is disabled and not configured");
    expect(html).toContain("Partial delivery history; only observed event counts are shown. Execution success rate is unavailable.");
    expect(html).toContain("Monitoring last observed");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("100%");
  });

  it("does not mislabel ambiguous scheduler wakes as a next scheduled run or retry", () => {
    const html = renderCard();
    expect(html).toContain("Next provider wake (schedule or retry)");
    expect(html).toContain("a scheduled run and a retry cannot be distinguished");
    expect(nextRunLabel(job.observation!.schedule, true)).toBe("Not available");
  });

  it("separates delivery acknowledgements and unknown counts from successful imports", () => {
    const html = renderToStaticMarkup(React.createElement(JobRunTable, { runs: [run] }));
    expect(html).toContain("Delivery acknowledged");
    expect(html).toContain("Delivery only · import unconfirmed");
    expect(html).toContain("Not reported");
    expect(html).toContain("Not correlated");
    expect(html).not.toContain("Succeeded");
    expect(html).not.toContain("0 processed");
  });

  it("shows scheduler delivery failures separately without suggesting zero failed executions", () => {
    const html = renderCard(true, { ...job, stats: { ...job.stats, executions: 0, failed: 0, succeeded: 0, running: 0, deliveryFailed: 2 } });
    expect(html).toContain("<dt>Executions</dt><dd>Not correlated</dd>");
    expect(html).toContain("<dt>Succeeded</dt><dd>Not verified</dd>");
    expect(html).toContain("<dt>Failed</dt><dd>Not correlated</dd>");
    expect(html).toContain("<dt>Running</dt><dd>Not verified</dd>");
    expect(html).toContain("<dt>Failed delivery events</dt><dd>2</dd>");
    expect(html).toContain("<dt>Delivery acknowledged</dt><dd>1</dd>");
    expect(renderCard()).toContain("<dt>Failed delivery events</dt><dd>Not recorded</dd>");
  });

  it("continues to show actual correlated n8n execution counts and excludes delivery-only labels", () => {
    const html = renderCard(true, { ...job, definition: { ...job.definition, provider: "n8n" }, stats: { ...job.stats, executions: 3, succeeded: 2, failed: 1, running: 0 } });
    expect(html).toContain("<dt>Executions</dt><dd>3</dd>");
    expect(html).toContain("<dt>Failed</dt><dd>1</dd>");
    expect(html).not.toContain("Failed delivery events");
    expect(html).toContain("Partial history; only observed execution counts are shown. Success rate is unavailable.");
  });

  it("keeps the initial registry state loading, with no invented successful data", () => {
    const html = renderToStaticMarkup(React.createElement(JobsMonitor));
    expect(html).toContain("Loading job observations");
    expect(html).toContain("Slack alerts disabled");
    expect(html).not.toContain("Synthetic source import");
    expect(html).not.toContain("All jobs healthy");
  });

  it("does not invent scheduled starts for manual, event-driven, paused or unknown jobs", () => {
    const scheduled = { ...UNKNOWN_SCHEDULE, kind: "scheduled" as const, nextRunAt: observedAt, nextRunBasis: "calculated" as const };
    expect(nextRunLabel(scheduled, true)).toMatch(/^Expected: /);
    expect(nextRunLabel({ ...scheduled, kind: "manual" }, true)).toBe("On demand");
    expect(nextRunLabel({ ...scheduled, kind: "event" }, true)).toBe("When the trigger fires");
    expect(nextRunLabel(scheduled, false)).toBe("Paused — no expected run");
    expect(nextRunLabel(undefined, null)).toBe("Schedule not observed");
    expect(nextRunLabel({ ...scheduled, nextRunBasis: "unknown" }, true)).toBe("Not available");
  });

  it("formats timestamps, missing values and rates without turning near-perfect into perfect", () => {
    expect(jobTimestamp("not-a-date")).toBe("Not recorded");
    expect(jobTimestamp(observedAt, "not-a-timezone")).toContain("UTC");
    expect(durationLabel(null)).toBe("Not recorded");
    expect(durationLabel(-10)).toBe("Not recorded");
    expect(durationLabel(0)).toBe("<1s");
    expect(durationLabel(125000)).toBe("2m 5s");
    expect(durationLabel(3660000)).toBe("1h 1m");
    expect(successRateLabel(99.999)).toBe(">99.9%");
    expect(successRateLabel(100)).toBe("100%");
    expect(successRateLabel(null)).toBe("Not available");
    expect(successRateLabel(101)).toBe("Not available");
  });

  it("encodes filters and cursors and avoids duplicated records across changing pages", () => {
    expect(listUrl("  source&status=HEALTHY  ", "FAILED", "a+b")).toBe("/api/data-health/jobs?q=source%26status%3DHEALTHY&status=FAILED&cursor=a%2Bb");
    expect(new URL(listUrl("x".repeat(200), ""), "https://example.invalid").searchParams.get("q")).toHaveLength(100);
    expect(historyUrl("job/id", "a+b")).toBe("/api/data-health/jobs/job%2Fid/runs?cursor=a%2Bb");
    expect(uniqueById([{ id: "a", value: 1 }, { id: "a", value: 2 }, { id: "b", value: 3 }], (item) => item.id)).toEqual([{ id: "a", value: 1 }, { id: "b", value: 3 }]);
  });
});
