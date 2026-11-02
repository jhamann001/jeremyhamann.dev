import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(), collectorAuth: vi.fn(), scope: vi.fn(), n8n: vi.fn(), cloud: vi.fn(),
  application: vi.fn(), token: vi.fn(), fetch: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/rls", () => ({ withUserScope: m.scope }));
vi.mock("@/lib/data-jobs/auth", () => ({ requireDataJobsCollectorAuth: m.collectorAuth }));
vi.mock("@/lib/data-jobs/providers/n8n", () => ({ collectN8nJob: m.n8n }));
vi.mock("@/lib/data-jobs/providers/cloud-scheduler", () => ({ collectCloudSchedulerJob: m.cloud }));
vi.mock("@/lib/data-jobs/application-evidence", () => ({ collectApplicationEvidence: m.application }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class { getAccessToken = m.token; } }));

// Keep the production flag functions and reader/collector gates real: turning
// on the screen must not accidentally grant permission to collect metadata.
import { dataJobCollectionEnabled, dataJobMonitoringEnabled } from "@/lib/flags";
import { canReadJobs } from "@/lib/data-jobs/store";
import { collectDataJobs } from "@/lib/data-jobs/collector";
import { GET as getJobs } from "@/app/api/data-health/jobs/route";
import { GET as getRuns } from "@/app/api/data-health/jobs/[jobId]/runs/route";
import { POST as collect } from "@/app/api/cron/data-jobs/route";

const identity = { role: "OPERATIONS", email: "screen-acceptance@example.test" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("APP_ENV", "dev");
  vi.stubEnv("DATA_HEALTH", "1");
  vi.stubEnv("DATA_JOB_MONITORING", "1");
  vi.stubEnv("DATA_JOB_COLLECTION", "0");
  vi.stubEnv("AOA_WRITES_PAUSED", "0");
  // Even configured synthetic provider access must remain untouched.
  vi.stubEnv("DATA_JOB_N8N_API_KEY", "synthetic-unused-key");
  vi.stubEnv("DATA_JOB_CLOUD_READS", "1");
  m.auth.mockResolvedValue({ user: identity });
  m.collectorAuth.mockResolvedValue(true);
  m.scope.mockRejectedValue(new Error("database_forbidden_in_screen_gate_test"));
  m.fetch.mockRejectedValue(new Error("network_forbidden_in_screen_gate_test"));
  vi.stubGlobal("fetch", m.fetch);
});

afterEach(() => {
  for (const forbidden of [m.scope, m.n8n, m.cloud, m.application, m.token, m.fetch]) {
    expect(forbidden).not.toHaveBeenCalled();
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("dev screen-only activation with real environment flags", () => {
  it.each(["OPERATIONS", "ADMIN"])("permits %s metadata reads without activating collection", (role) => {
    expect(dataJobMonitoringEnabled()).toBe(true);
    expect(canReadJobs({ ...identity, role })).toBe(true);
    expect(dataJobCollectionEnabled()).toBe(false);
  });

  it.each(["ADVISOR", "VIEWER", "CLIENT_SERVICE"])("denies %s at both metadata APIs before database work", async (role) => {
    m.auth.mockResolvedValue({ user: { ...identity, role } });
    expect(canReadJobs({ ...identity, role })).toBe(false);
    const list = await getJobs(new Request("https://ops-portal.example.test/api/data-health/jobs"));
    const history = await getRuns(new Request("https://ops-portal.example.test/api/data-health/jobs/dev-synthetic/runs"),
      { params: Promise.resolve({ jobId: "dev-synthetic" }) });
    expect(list.status).toBe(404);
    expect(history.status).toBe(404);
    expect(await list.json()).toEqual({ error: "not_found" });
    expect(await history.json()).toEqual({ error: "not_found" });
  });

  it.each(["DATA_HEALTH", "DATA_JOB_MONITORING"])("requires %s even for privileged readers", async (flag) => {
    vi.stubEnv(flag, "0");
    for (const role of ["OPERATIONS", "ADMIN"]) {
      expect(canReadJobs({ ...identity, role })).toBe(false);
      m.auth.mockResolvedValue({ user: { ...identity, role } });
      expect((await getJobs(new Request("https://ops-portal.example.test/api/data-health/jobs"))).status).toBe(404);
      expect((await getRuns(new Request("https://ops-portal.example.test/api/data-health/jobs/dev-synthetic/runs"),
        { params: Promise.resolve({ jobId: "dev-synthetic" }) })).status).toBe(404);
    }
  });

  it("requires an identified reader even when the dev screen is enabled", () => {
    expect(canReadJobs({ role: "ADMIN", email: "" })).toBe(false);
    expect(canReadJobs({ role: "OPERATIONS", email: "   " })).toBe(false);
  });

  it("refuses collection with the screen enabled, including an authenticated cron POST", async () => {
    expect(canReadJobs(identity)).toBe(true);
    const skipped = { skipped: true, busy: false, collected: 0, unavailable: 0 };
    expect(await collectDataJobs()).toEqual(skipped);
    const request = new Request("https://aoa.jeremyhamann.dev/api/cron/data-jobs", { method: "POST" });
    const response = await collect(request);
    expect(m.collectorAuth).toHaveBeenCalledWith(request);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(skipped);
  });
});
