import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { collectN8nJob, publishedN8nSchedule } from "@/lib/data-jobs/providers/n8n";
import { collectCloudSchedulerJob } from "@/lib/data-jobs/providers/cloud-scheduler";
import { nextCronRun } from "@/lib/data-jobs/providers/schedule";
import { readProviderJson } from "@/lib/data-jobs/providers/http";
import type { JobDefinition } from "@/lib/data-jobs/contracts";

const now = new Date("2026-09-18T16:10:00.000Z");
const n8n: JobDefinition = {
  id: "dev-synthetic", name: "Synthetic import", source: "Synthetic", environment: "dev", provider: "n8n",
  providerId: "SyntheticFlow123", trigger: "Schedule", runner: "n8n", destination: "Synthetic mirror", consumers: ["Synthetic view"],
  owner: "Operations", jobUrl: "https://n8n-dev.example/workflow/SyntheticFlow123", expectedEnabled: true, graceSeconds: 900, maxRunSeconds: 1800,
};
const cloud: JobDefinition = {
  ...n8n, id: "dev-synthetic-scheduler", provider: "cloud-scheduler", providerId: "projects/ops-portal-dev/locations/us-central1/jobs/synthetic-job",
  jobUrl: "https://console.cloud.google.com/cloudscheduler?project=ops-portal-dev",
};
const n8nConfig = { baseUrl: "https://n8n-dev.example", apiKey: "synthetic-api-key" };
const cloudConfig = { projectId: "ops-portal-dev", location: "us-central1", accessToken: "synthetic-access-token",
  logView: "projects/ops-portal-dev/locations/global/buckets/_Default/views/aoa-scheduler-monitor" };
const fetchMock = vi.fn();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const empty = () => json({ data: [], nextCursor: null });
function workflow(overrides: Record<string, unknown> = {}) {
  return { id: n8n.providerId, active: true, activeVersionId: "published-v1", versionId: "draft-v2",
    settings: { timezone: "America/New_York", saveDataSuccessExecution: "all", saveDataErrorExecution: "all" },
    nodes: [{ type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 0 * * *" }] } } }],
    activeVersion: { versionId: "published-v1", nodes: [{ type: "n8n-nodes-base.scheduleTrigger", parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 15 }] } } }] }, ...overrides };
}
function execution(id: string, status = "success", overrides: Record<string, unknown> = {}) {
  return { id, workflowId: n8n.providerId, status, startedAt: "2026-09-18T16:00:00Z", stoppedAt: "2026-09-18T16:01:00Z", retryOf: null, ...overrides };
}
function job(overrides: Record<string, unknown> = {}) {
  return { name: cloud.providerId, state: "ENABLED", schedule: "*/15 * * * *", timeZone: "America/New_York", scheduleTime: "2026-09-18T16:11:00Z", ...overrides };
}
function log(id: string, started = false, status = 200, overrides: Record<string, unknown> = {}) {
  return { insertId: id, logName: "projects/ops-portal-dev/logs/cloudscheduler.googleapis.com%2Fexecutions",
    timestamp: "2026-09-18T16:05:00.000Z", resource: { type: "cloud_scheduler_job", labels: { project_id: "ops-portal-dev", location: "us-central1", job_id: "synthetic-job" } },
    jsonPayload: { "@type": `type.googleapis.com/google.cloud.scheduler.logging.Attempt${started ? "Started" : "Finished"}`, jobName: cloud.providerId, targetType: "HTTP", debugInfo: "synthetic-private-exception-must-not-escape" },
    ...(started ? {} : { httpRequest: { status } }), ...overrides };
}

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("n8n read-only execution metadata", () => {
  it("uses published cadence, not draft, and keeps unexposed interval anchor unknown", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow())).mockResolvedValueOnce(json({ data: [execution("1")], nextCursor: null })).mockResolvedValueOnce(empty());
    const observed = await collectN8nJob(n8n, now, n8nConfig);
    expect(observed.schedule).toMatchObject({ kind: "scheduled", expression: "Every 15 minutes", timezone: "America/New_York", nextRunAt: null });
    expect(observed).toMatchObject({ coverage: "partial", code: "provider_history_retention_unverified" });
    expect(observed.runs[0]).toMatchObject({ status: "SUCCEEDED", evidence: "provider_execution", durationMs: 60_000, recordsProcessed: null });
    expect(fetchMock.mock.calls[0][0].searchParams.get("excludePinnedData")).toBe("true");
    expect(fetchMock.mock.calls[1][0].searchParams.get("includeData")).toBe("false");
    expect(fetchMock.mock.calls[2][0].searchParams.get("status")).toBe("running");
    expect(fetchMock.mock.calls.every(([, init]) => !init.method || init.method === "GET")).toBe(true);
  });
  it("requires exact published version evidence and never falls back to draft nodes", () => {
    expect(publishedN8nSchedule(workflow({ activeVersion: null }), now).kind).toBe("unknown");
    expect(publishedN8nSchedule(workflow({ activeVersionId: "different" }), now).kind).toBe("unknown");
  });
  it("preserves daily/weekly schedules with documented defaults without inventing seconds", () => {
    const shape = workflow();
    shape.activeVersion.nodes[0].parameters.rule.interval = [{ field: "weeks", triggerAtDay: [1, 2, 3, 4, 5], triggerAtHour: 7 }] as never;
    expect(publishedN8nSchedule(shape, now).expression).toBe("Every 1 weeks: Mon, Tue, Wed, Thu, Fri at hour 07 (minute unverified)");
    shape.activeVersion.nodes[0].parameters.rule.interval = [{ triggerAtHour: 7, triggerAtMinute: 30 }] as never;
    expect(publishedN8nSchedule(shape, now).expression).toBe("Every 1 days at 07:30");
  });
  it("computes explicit published cron only with a known timezone, including reviewed fallback", () => {
    const shape = workflow({ settings: {} });
    shape.activeVersion.nodes[0].parameters.rule.interval = [{ field: "cronExpression", expression: "*/15 * * * *" }] as never;
    expect(publishedN8nSchedule(shape, now).nextRunAt).toBeNull();
    expect(publishedN8nSchedule(shape, now, "America/New_York")).toMatchObject({ timezone: "America/New_York", nextRunAt: "2026-09-18T16:15:00.000Z", nextRunBasis: "calculated" });
    shape.active = false;
    expect(publishedN8nSchedule(shape, now, "America/New_York").nextRunAt).toBeNull();
  });
  it("retains failed attempts and links retries only from explicit metadata", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow())).mockResolvedValueOnce(json({ data: [execution("2", "success", { retryOf: "1" }), execution("1", "error"), execution("3", "success", { retryOf: undefined })], nextCursor: null })).mockResolvedValueOnce(empty());
    const observed = await collectN8nJob(n8n, now, n8nConfig);
    expect(observed.runs.find((run) => run.id.endsWith(":2"))).toMatchObject({ retryOf: `n8n:${n8n.providerId}:1`, logicalRunId: `n8n:${n8n.providerId}:1`, correlation: "exact" });
    expect(observed.runs.find((run) => run.id.endsWith(":1"))?.status).toBe("FAILED");
    expect(observed.runs.find((run) => run.id.endsWith(":3"))).toMatchObject({ logicalRunId: null, correlation: "attempt_only" });
  });
  it("does not invent logical identity for missing parents or retry cycles", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow())).mockResolvedValueOnce(json({ data: [execution("2", "success", { retryOf: "outside" }), execution("3", "error", { retryOf: "4" }), execution("4", "error", { retryOf: "3" })], nextCursor: null })).mockResolvedValueOnce(empty());
    expect((await collectN8nJob(n8n, now, n8nConfig)).runs.every((run) => run.logicalRunId === null && run.correlation === "attempt_only")).toBe(true);
  });
  it("fetches separate active metadata and retains starts before the history window", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow())).mockResolvedValueOnce(empty()).mockResolvedValueOnce(json({ data: [execution("1", "running", { stoppedAt: null, startedAt: "2026-09-16T16:00:00Z" })], nextCursor: null }));
    expect((await collectN8nJob(n8n, now, n8nConfig)).runs[0]).toMatchObject({ status: "RUNNING", durationMs: null });
  });
  it("preserves bounded last-known terminal anchors outside 24h for weekend views", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow())).mockResolvedValueOnce(json({ data: [
      execution("1", "success", { startedAt: "2026-09-16T16:00:00Z", stoppedAt: "2026-09-16T16:01:00Z" }),
      execution("2", "success", { startedAt: "2026-09-17T13:00:00Z", stoppedAt: "2026-09-17T13:01:00Z" }),
      execution("3", "error", { startedAt: "2026-09-17T12:00:00Z", stoppedAt: "2026-09-17T12:01:00Z" }),
    ], nextCursor: null })).mockResolvedValueOnce(empty());
    const observed = await collectN8nJob(n8n, now, n8nConfig);
    expect(observed.runs).toHaveLength(2);
    expect(observed.runs.map((run) => run.id.split(":").at(-1)).sort()).toEqual(["2", "3"]);
    expect(observed.runs.every((run) => run.finishedAt! < observed.windowStart)).toBe(true);
  });
  it("never turns disabled execution saving into complete or healthy evidence", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow({ settings: { saveDataSuccessExecution: "none", saveDataErrorExecution: "none" } }))).mockResolvedValueOnce(empty()).mockResolvedValueOnce(empty());
    expect(await collectN8nJob(n8n, now, n8nConfig)).toMatchObject({ coverage: "partial", code: "provider_execution_history_disabled", runs: [] });
  });
  it("labels unverified retention defaults partial, even when pagination is exhausted", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow({ settings: {} }))).mockResolvedValueOnce(empty()).mockResolvedValueOnce(empty());
    expect(await collectN8nJob(n8n, now, n8nConfig)).toMatchObject({ coverage: "partial", code: "provider_history_retention_unverified" });
  });
  it("does not treat explicit save-all and exhausted empty history as proof of global age/count retention", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow())).mockResolvedValueOnce(empty()).mockResolvedValueOnce(empty());
    expect(await collectN8nJob(n8n, now, n8nConfig)).toMatchObject({ coverage: "partial", code: "provider_history_retention_unverified", runs: [] });
  });
  it("follows safe opaque cursors but limits history and refuses misleading totals", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow()));
    for (let i = 0; i < 5; i += 1) fetchMock.mockResolvedValueOnce(json({ data: [execution(String(i))], nextCursor: `cursor-${i}`, total: 1 }));
    fetchMock.mockResolvedValueOnce(empty());
    const observed = await collectN8nJob(n8n, now, n8nConfig);
    expect(observed).toMatchObject({ coverage: "partial", code: "provider_history_truncated" });
    expect(observed.runs).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
  it("rejects repeated cursors and preserves already-read evidence", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow())).mockImplementation(() => Promise.resolve(json({ data: [execution("1")], nextCursor: "repeat" })));
    expect(await collectN8nJob(n8n, now, n8nConfig)).toMatchObject({ coverage: "partial", code: "provider_invalid_pagination" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("marks malformed terminal timing incomplete rather than claiming successful completion", async () => {
    fetchMock.mockResolvedValueOnce(json(workflow())).mockResolvedValueOnce(json({ data: [execution("1", "success", { stoppedAt: null }), execution("2", "success", { stoppedAt: "2026-09-18T15:00:00Z" })], nextCursor: null })).mockResolvedValueOnce(empty());
    expect(await collectN8nJob(n8n, now, n8nConfig)).toMatchObject({ runs: [], coverage: "partial", code: "provider_metadata_incomplete" });
  });
  it.each(["http://n8n-dev.example", "https://n8n.example.com", "https://n8n-dev.example.evil.test", "https://person:password@n8n-dev.example", "https://n8n-dev.example/webhook/private"])("never sends credentials to unapproved origin/path %s", async (baseUrl) => {
    expect((await collectN8nJob(n8n, now, { ...n8nConfig, baseUrl })).coverage).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects path traversal IDs and strips payload/exception/client fields", async () => {
    expect((await collectN8nJob({ ...n8n, providerId: "../credentials" }, now, n8nConfig)).coverage).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json(workflow())).mockResolvedValueOnce(json({ data: [execution("1", "error", { data: { private: "synthetic-private-data" }, error: "synthetic-private-exception", recordsProcessed: 99 })], nextCursor: null })).mockResolvedValueOnce(empty());
    const observed = await collectN8nJob(n8n, now, n8nConfig);
    expect(JSON.stringify(observed)).not.toContain("synthetic-private");
    expect(observed.runs[0].recordsProcessed).toBeNull();
  });
});

describe("Cloud Scheduler evidence boundary", () => {
  it("stores independent events, never nearest-time pairs, and marks HTTP200 as acknowledgment only", async () => {
    fetchMock.mockResolvedValueOnce(json(job())).mockResolvedValueOnce(json({ entries: [log("end-ok"), log("start", true), log("end-fail", false, 503)] }));
    const observed = await collectCloudSchedulerJob(cloud, now, cloudConfig);
    expect(observed.coverage).toBe("complete_window");
    expect(observed.runs.map((run) => run.status)).toEqual(["ACKNOWLEDGED", "UNKNOWN", "FAILED"]);
    expect(observed.runs.every((run) => run.correlation === "event_only" && run.logicalRunId === null && run.durationMs === null && run.evidence === "delivery_only")).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("synthetic-private");
    expect(observed.schedule).toMatchObject({ nextWakeAt: "2026-09-18T16:11:00.000Z", nextRunAt: "2026-09-18T16:15:00.000Z", nextRunBasis: "calculated", nextRetryAt: null });
    expect(fetchMock.mock.calls[0][0].hostname).toBe("cloudscheduler.googleapis.com");
    expect(fetchMock.mock.calls[1][0].pathname).toBe("/v2/entries:list");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).filter).toContain('resource.labels.project_id="ops-portal-dev"');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).resourceNames).toEqual([cloudConfig.logView]);
  });
  it("keeps a stable event ID and deduplicates overlapping pages", async () => {
    fetchMock.mockResolvedValueOnce(json(job())).mockResolvedValueOnce(json({ entries: [log("same")], nextPageToken: "next" })).mockResolvedValueOnce(json({ entries: [log("same")] }));
    const observed = await collectCloudSchedulerJob(cloud, now, cloudConfig);
    expect(observed.runs).toHaveLength(1);
    expect(observed.runs[0].id).toMatch(/^scheduler:[a-f0-9]{64}$/);
    expect(observed.runs[0].executionUrl).toContain("console.cloud.google.com/logs/query");
  });
  it("covers a full every-minute day without an unavoidable 1000-event truncation", async () => {
    fetchMock.mockResolvedValueOnce(json(job()));
    for (let page = 0; page < 3; page += 1) {
      const count = page === 2 ? 880 : 1000;
      fetchMock.mockResolvedValueOnce(json({ entries: Array.from({ length: count }, (_, index) => log(`event-${page * 1000 + index}`, index % 2 === 0)), ...(page < 2 ? { nextPageToken: `page-${page + 1}` } : {}) }));
    }
    const observed = await collectCloudSchedulerJob(cloud, now, cloudConfig);
    expect(observed.coverage).toBe("complete_window");
    expect(observed.runs).toHaveLength(2880);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).pageSize).toBe(1000);
  });
  it.each(["PAUSED", "DISABLED"])("does not show next run/wake for %s", async (state) => {
    fetchMock.mockResolvedValueOnce(json(job({ state }))).mockResolvedValueOnce(json({}));
    expect(await collectCloudSchedulerJob(cloud, now, cloudConfig)).toMatchObject({ enabled: false, schedule: { nextRunAt: null, nextWakeAt: null, nextRetryAt: null } });
  });
  it("does not infer success from omitted structured status or untrusted debugInfo", async () => {
    fetchMock.mockResolvedValueOnce(json(job())).mockResolvedValueOnce(json({ entries: [log("missing", false, 200, { httpRequest: {} })] }));
    expect((await collectCloudSchedulerJob(cloud, now, cloudConfig)).runs[0].status).toBe("UNKNOWN");
  });
  it("fails closed on wrong-project rows without copying them into output", async () => {
    fetchMock.mockResolvedValueOnce(json(job())).mockResolvedValueOnce(json({ entries: [log("wrong", false, 200, { resource: { type: "cloud_scheduler_job", labels: { project_id: "ops-portal" } } })] }));
    expect(await collectCloudSchedulerJob(cloud, now, cloudConfig)).toMatchObject({ coverage: "partial", runs: [], code: "provider_metadata_incomplete" });
  });
  it("preserves observed schedule but reports provider access denial rather than zero jobs", async () => {
    fetchMock.mockResolvedValueOnce(json(job())).mockResolvedValueOnce(json({ message: "synthetic-sensitive-policy" }, 403));
    const observed = await collectCloudSchedulerJob(cloud, now, cloudConfig);
    expect(observed).toMatchObject({ enabled: true, coverage: "unavailable", code: "provider_access_denied" });
    expect(JSON.stringify(observed)).not.toContain("synthetic-sensitive");
  });
  it("never uses a production token configuration for development resources", async () => {
    expect((await collectCloudSchedulerJob(cloud, now, { ...cloudConfig, projectId: "ops-portal" })).code).toBe("invalid_provider_configuration");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([undefined, "projects/ops-portal-dev", "projects/ops-portal-dev/locations/global/buckets/_Default/views/_AllLogs",
    "projects/ops-portal-dev/locations/global/buckets/_Default/views/_Default", "projects/ops-portal/locations/global/buckets/_Default/views/aoa-monitor",
    "projects/ops-portal-dev/locations/global/buckets/_Default/views/aoa-monitor?token=private"])("fails closed without a matching custom log view: %s", async (logView) => {
    expect((await collectCloudSchedulerJob(cloud, now, { ...cloudConfig, logView })).coverage).toBe("unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bounded provider transport and honest schedule calculations", () => {
  it("uses no-store/redirect:error and strips invalid JSON errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("synthetic-private-invalid-json"));
    await expect(readProviderJson(new URL("https://n8n-dev.example/api/v1/executions"))).rejects.toThrow("provider_invalid_response");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error", cache: "no-store" });
  });
  it("caps response bodies even without Content-Length", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(readProviderJson(new URL("https://n8n-dev.example/api/v1/executions"))).rejects.toThrow("provider_response_too_large");
  });
  it("aborts slow fetches within five seconds without leaking the error", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("synthetic-secret")))));
    const read = expect(readProviderJson(new URL("https://n8n-dev.example/api/v1/executions"))).rejects.toThrow("provider_timeout");
    await vi.advanceTimersByTimeAsync(5_001);
    await read;
  });
  it("changes UTC hour across spring/fall DST while retaining configured local schedule", () => {
    expect(nextCronRun("0 9 * * *", "America/New_York", new Date("2026-03-07T15:00:00Z"))).toBe("2026-03-08T13:00:00.000Z");
    expect(nextCronRun("0 9 * * *", "America/New_York", new Date("2026-10-31T14:00:00Z"))).toBe("2026-11-01T14:00:00.000Z");
  });
  it("handles weekdays and refuses unknown timezone, hash syntax, expressions and ambiguous DOM+DOW", () => {
    expect(nextCronRun("0 9 * * 1-5", "America/New_York", new Date("2026-09-18T16:10:00Z"))).toBe("2026-09-21T13:00:00.000Z");
    expect(nextCronRun("0 9 * * *", null, now)).toBeNull();
    expect(nextCronRun("H * * * *", "UTC", now)).toBeNull();
    expect(nextCronRun("={{ secret }}", "UTC", now)).toBeNull();
    expect(nextCronRun("0 9 1 * 1", "UTC", now)).toBeNull();
  });
});
