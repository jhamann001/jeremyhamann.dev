import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const { verify, paused } = vi.hoisted(() => ({ verify: vi.fn(), paused: vi.fn(() => false) }));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = verify; } }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: paused }));
import { requireDataJobsCollectorAuth } from "@/lib/data-jobs/auth";
const audience = "https://aoa-dev.example/api/cron/data-jobs";
const email = "data-job-collector@ops-portal-dev.iam.gserviceaccount.com";
describe("dedicated job collector authorization", () => {
  beforeEach(() => { vi.stubEnv("APP_ENV", "dev"); vi.stubEnv("DATA_JOB_COLLECTOR_AUDIENCE", audience); vi.stubEnv("DATA_JOB_COLLECTOR_SERVICE_ACCOUNT", email); verify.mockReset(); paused.mockReturnValue(false); });
  afterEach(() => vi.unstubAllEnvs());
  const request = (url = audience, authorization = "Bearer synthetic") => new Request(url, { headers: { authorization } });
  it("accepts only a verified Google token for the exact configured service account and audience", async () => {
    verify.mockResolvedValue({ getPayload: () => ({ iss: "https://accounts.google.com", email_verified: true, email }) });
    expect(await requireDataJobsCollectorAuth(request())).toBe(true);
    expect(verify).toHaveBeenCalledWith({ idToken: "synthetic", audience });
  });
  it("rejects issuer/email verification failures, other service accounts and verification errors", async () => {
    for (const claims of [{ iss: "attacker", email, email_verified: true }, { iss: "accounts.google.com", email, email_verified: false }, { iss: "accounts.google.com", email: "other@example.test", email_verified: true }]) {
      verify.mockResolvedValue({ getPayload: () => claims }); expect(await requireDataJobsCollectorAuth(request())).toBe(false);
    }
    verify.mockRejectedValue(new Error("private")); expect(await requireDataJobsCollectorAuth(request())).toBe(false);
  });
  it("fails closed on missing config, malformed headers, replay paths and paused writes", async () => {
    expect(await requireDataJobsCollectorAuth(request(audience, "Bearer synthetic extra"))).toBe(false);
    expect(await requireDataJobsCollectorAuth(request("https://ops-portal.example.test/api/other"))).toBe(false);
    paused.mockReturnValue(true); expect(await requireDataJobsCollectorAuth(request())).toBe(false); paused.mockReturnValue(false);
    vi.stubEnv("DATA_JOB_COLLECTOR_AUDIENCE", ""); expect(await requireDataJobsCollectorAuth(request())).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it("rejects cross-environment configuration before token verification", async () => {
    vi.stubEnv("APP_ENV", "prod"); expect(await requireDataJobsCollectorAuth(request())).toBe(false);
    vi.stubEnv("APP_ENV", "dev"); vi.stubEnv("DATA_JOB_COLLECTOR_AUDIENCE", "https://attacker.example/api/cron/data-jobs");
    expect(await requireDataJobsCollectorAuth(request())).toBe(false); expect(verify).not.toHaveBeenCalled();
  });
});
