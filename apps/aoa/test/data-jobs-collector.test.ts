import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDefinition, JobObservation } from "@/lib/data-jobs/contracts";

const m = vi.hoisted(() => ({
  enabled: vi.fn(), paused: vi.fn(), environment: vi.fn(), claim: vi.fn(), save: vi.fn(), finish: vi.fn(),
  getJobs: vi.fn(), token: vi.fn(), n8n: vi.fn(), cloud: vi.fn(), auth: vi.fn(), fetch: vi.fn(),
  states: vi.fn(), application: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/flags", () => ({ dataJobCollectionEnabled: m.enabled }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: m.paused }));
vi.mock("@/lib/data-jobs/store", () => ({ jobEnvironment: m.environment, claimCollection: m.claim, saveObservation: m.save, finishCollection: m.finish, readCollectionStates: m.states }));
vi.mock("@/lib/data-jobs/application-evidence", () => ({ collectApplicationEvidence: m.application }));
vi.mock("@/lib/data-jobs/registry", () => ({
  getDataJobs: m.getJobs,
  DATA_JOB_PROVIDER_CONFIG: {
    dev: { n8nOrigin: "https://n8n-dev.example", gcpProject: "ops-portal-dev", region: "us-central1" },
    prod: { n8nOrigin: "https://n8n.example.com", gcpProject: "ops-portal", region: "us-central1" },
  },
}));
vi.mock("@/lib/data-jobs/providers/n8n", () => ({ collectN8nJob: m.n8n }));
vi.mock("@/lib/data-jobs/providers/cloud-scheduler", () => ({ collectCloudSchedulerJob: m.cloud }));
vi.mock("@/lib/data-jobs/auth", () => ({ requireDataJobsCollectorAuth: m.auth }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class { getAccessToken = m.token; } }));
import { collectDataJobs } from "@/lib/data-jobs/collector";
import { POST, GET } from "@/app/api/cron/data-jobs/route";

const first: JobDefinition = {
  id: "dev-synthetic", name: "Synthetic import", source: "Synthetic", environment: "dev", provider: "n8n",
  providerId: "SyntheticFlow123", trigger: "Schedule", runner: "n8n", destination: "Synthetic mirror", consumers: ["Synthetic view"],
  owner: "Operations", jobUrl: "https://n8n-dev.example/workflow/SyntheticFlow123", expectedEnabled: true, graceSeconds: 900, maxRunSeconds: 1800,
};
const second: JobDefinition = { ...first, id: "dev-synthetic-scheduler", provider: "cloud-scheduler", providerId: "projects/ops-portal-dev/locations/us-central1/jobs/synthetic-job" };
const observed = (job: JobDefinition, now = new Date()): JobObservation => ({
  jobId: job.id, observedAt: now.toISOString(), enabled: true,
  schedule: { kind: "unknown", expression: null, timezone: null, nextRunAt: null, nextRunBasis: "unknown", nextRetryAt: null },
  runs: [], coverage: "complete_window", windowStart: new Date(now.getTime() - 86_400_000).toISOString(), windowEnd: now.toISOString(), code: null,
});
const request = () => new Request("https://aoa.jeremyhamann.dev/api/cron/data-jobs", { method: "POST" });

beforeEach(() => {
  Object.values(m).forEach((mock) => mock.mockReset());
  m.enabled.mockReturnValue(true); m.paused.mockReturnValue(false); m.environment.mockReturnValue("dev");
  m.claim.mockResolvedValue("synthetic-lease"); m.save.mockResolvedValue(undefined); m.finish.mockResolvedValue(undefined);
  m.states.mockResolvedValue(new Map()); m.application.mockResolvedValue([]);
  m.getJobs.mockReturnValue([first, second]); m.auth.mockResolvedValue(true); m.token.mockResolvedValue("synthetic-adc-token");
  m.n8n.mockImplementation(async (job: JobDefinition, now: Date) => observed(job, now));
  m.cloud.mockImplementation(async (job: JobDefinition, now: Date) => observed(job, now));
  m.fetch.mockRejectedValue(new Error("live_network_forbidden_in_test")); vi.stubGlobal("fetch", m.fetch);
  vi.stubEnv("DATA_JOB_N8N_API_KEY", "synthetic-key"); vi.stubEnv("DATA_JOB_CLOUD_READS", "1"); vi.stubEnv("DATA_JOB_N8N_TIMEZONE", "America/New_York");
  vi.stubEnv("DATA_JOB_N8N_COVERAGE_EVIDENCE", ""); vi.stubEnv("DATA_JOB_SCHEDULER_LOG_VIEW", "projects/ops-portal-dev/locations/global/buckets/synthetic/views/scheduler");
});
afterEach(() => { expect(m.fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("dedicated bounded data-jobs collector", () => {
  it.each(["flag", "paused", "environment"])("does not claim/write/read providers when disabled by %s", async (reason) => {
    if (reason === "flag") m.enabled.mockReturnValue(false);
    if (reason === "paused") m.paused.mockReturnValue(true);
    if (reason === "environment") m.environment.mockReturnValue(null);
    expect(await collectDataJobs()).toMatchObject({ skipped: true, collected: 0 });
    expect(m.claim).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled(); expect(m.token).not.toHaveBeenCalled();
  });
  it("does no work without acquiring the fenced collection lease", async () => {
    m.claim.mockResolvedValue(null);
    expect(await collectDataJobs()).toMatchObject({ busy: true, collected: 0 });
    expect(m.n8n).not.toHaveBeenCalled(); expect(m.cloud).not.toHaveBeenCalled(); expect(m.finish).not.toHaveBeenCalled();
  });
  it("records unavailable evidence instead of fake successes when access is unconfigured", async () => {
    vi.stubEnv("DATA_JOB_N8N_API_KEY", ""); vi.stubEnv("DATA_JOB_CLOUD_READS", "0");
    expect(await collectDataJobs()).toMatchObject({ collected: 2, unavailable: 2 });
    expect(m.n8n).not.toHaveBeenCalled(); expect(m.cloud).not.toHaveBeenCalled(); expect(m.token).not.toHaveBeenCalled();
    expect(m.save.mock.calls.map((call) => call[1].coverage)).toEqual(["unavailable", "unavailable"]);
    expect(m.save.mock.calls.every((call) => call[1].runs.length === 0)).toBe(true);
    expect(m.finish).toHaveBeenCalledWith("dev", "synthetic-lease", expect.any(Date));
  });
  it("uses only environment-bound configured origins/projects and preserves observations", async () => {
    m.n8n.mockImplementation(async (job: JobDefinition, now: Date) => ({ ...observed(job, now), coverage: "partial", code: "provider_history_truncated" }));
    expect(await collectDataJobs()).toMatchObject({ collected: 2, unavailable: 1 });
    expect(m.n8n).toHaveBeenCalledWith(first, expect.any(Date), { baseUrl: "https://n8n-dev.example", apiKey: "synthetic-key", timezone: "America/New_York" });
    expect(m.cloud).toHaveBeenCalledWith(second, expect.any(Date), { projectId: "ops-portal-dev", location: "us-central1", accessToken: "synthetic-adc-token", logView: process.env.DATA_JOB_SCHEDULER_LOG_VIEW });
    expect(m.save).toHaveBeenCalledWith(first, expect.objectContaining({ coverage: "partial", code: "provider_history_truncated" }), "synthetic-lease", expect.any(Date), {});
  });
  it("keeps an ADC failure static and still collects independently available n8n evidence", async () => {
    m.token.mockRejectedValue(new Error("synthetic-private-credential-error"));
    const result = await collectDataJobs();
    expect(result).toMatchObject({ collected: 2, unavailable: 1 });
    expect(m.n8n).toHaveBeenCalledOnce(); expect(m.cloud).not.toHaveBeenCalled();
    expect(JSON.stringify(m.save.mock.calls)).not.toContain("synthetic-private-credential-error");
  });
  it("uses a fixed four-worker bound", async () => {
    m.getJobs.mockReturnValue(Array.from({ length: 11 }, (_, index) => ({ ...first, id: `dev-synthetic-${index}` })));
    let inFlight = 0; let peak = 0;
    m.n8n.mockImplementation(async (job: JobDefinition, now: Date) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--; return observed(job, now);
    });
    expect(await collectDataJobs()).toMatchObject({ collected: 11, unavailable: 0 });
    expect(peak).toBe(4); expect(m.token).not.toHaveBeenCalled();
  });
  it("records unobserved jobs explicitly once the time budget is spent", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-18T16:00:00Z"));
    m.getJobs.mockReturnValue(Array.from({ length: 8 }, (_, index) => ({ ...first, id: `dev-synthetic-${index}` })));
    m.n8n.mockImplementation(async (job: JobDefinition, now: Date) => {
      vi.setSystemTime(new Date("2026-09-18T16:04:01Z")); return observed(job, now);
    });
    expect(await collectDataJobs()).toMatchObject({ collected: 8, unavailable: 7 });
    expect(m.n8n).toHaveBeenCalledOnce();
    expect(m.save.mock.calls.filter((call) => call[1].code === "collector_budget_exceeded")).toHaveLength(7);
  });
  it("cannot mark a failed persistence cycle completed", async () => {
    m.save.mockRejectedValue(new Error("synthetic-fenced-lease-loss"));
    await expect(collectDataJobs()).rejects.toThrow("job_collection_failed");
    expect(m.finish).not.toHaveBeenCalled();
  });
  it("rechecks the write pause before collection workers proceed", async () => {
    m.paused.mockReturnValueOnce(false).mockReturnValue(true);
    await expect(collectDataJobs()).rejects.toThrow("job_collection_failed");
    expect(m.n8n).not.toHaveBeenCalled(); expect(m.cloud).not.toHaveBeenCalled(); expect(m.save).not.toHaveBeenCalled(); expect(m.finish).not.toHaveBeenCalled();
  });

  it("fails closed on malformed capability proof instead of silently selecting an optimistic mode", async () => {
    vi.stubEnv("DATA_JOB_N8N_COVERAGE_EVIDENCE", "not-json");
    expect(await collectDataJobs()).toMatchObject({ unavailable: 1 });
    expect(m.states).toHaveBeenCalledWith("dev"); expect(m.n8n).not.toHaveBeenCalled();
    expect(m.save.mock.calls[0][1]).toMatchObject({ coverage: "unavailable", code: "provider_capability_evidence_unverified" });
  });

  it("persists checkpoint separately and reads source evidence once without inventing provider correlation", async () => {
    const prodJob = { ...second, id: "prod-account-aum", environment: "prod" as const };
    const evidence = { sourceKey: "ACCOUNT_AUM", coverage: "snapshot_only", correlation: "source_only" };
    m.environment.mockReturnValue("prod"); m.getJobs.mockReturnValue([prodJob, { ...prodJob, id: "prod-account-aum-stale-only" }]);
    m.application.mockResolvedValue([evidence]);
    expect(await collectDataJobs()).toMatchObject({ collected: 2, unavailable: 0 });
    expect(m.application).toHaveBeenCalledOnce();
    expect(m.save.mock.calls.every((call) => call[4].applicationEvidence === evidence)).toBe(true);
    expect(m.save.mock.calls.every((call) => call[1].runs.length === 0)).toBe(true);
  });

  it("does not count a missing required application snapshot as complete collection", async () => {
    m.environment.mockReturnValue("prod"); m.getJobs.mockReturnValue([{ ...second, id: "prod-review-queue", environment: "prod" }]);
    expect(await collectDataJobs()).toMatchObject({ collected: 1, unavailable: 1 });
  });
});

describe("collection route result semantics", () => {
  it("reserves HTTP200 for an actual completed collection, never a disabled or empty cycle", async () => {
    expect((await POST(request())).status).toBe(200);
    m.enabled.mockReturnValue(false); expect((await POST(request())).status).toBe(503);
    m.enabled.mockReturnValue(true); m.getJobs.mockReturnValue([]); expect((await POST(request())).status).toBe(503);
  });
  it("requires authenticated POST before obtaining credentials or claiming a lease", async () => {
    m.auth.mockResolvedValue(false);
    const result = await POST(request());
    expect(result.status).toBe(401); expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(m.claim).not.toHaveBeenCalled(); expect(m.token).not.toHaveBeenCalled();
    expect((await GET()).status).toBe(405);
  });
  it("returns503 for unavailable providers,202 when busy, and never exposes raw errors", async () => {
    vi.stubEnv("DATA_JOB_N8N_API_KEY", "");
    expect((await POST(request())).status).toBe(503);
    m.claim.mockResolvedValue(null);
    expect((await POST(request())).status).toBe(202);
    m.claim.mockRejectedValue(new Error("synthetic-private-stacktrace"));
    const failed = await POST(request());
    expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: "job_collection_failed" });
  });
});
