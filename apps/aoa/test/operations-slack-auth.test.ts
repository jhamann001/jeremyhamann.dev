import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verify, run } = vi.hoisted(() => ({ verify: vi.fn(), run: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = verify; } }));
vi.mock("@/lib/data/operations-slack-delivery", () => ({ runOperationsSlackDelivery: run }));
import { requireOperationsSlackCronAuth } from "@/lib/cron/operations-slack-auth";
import { POST, GET } from "@/app/api/cron/operations-slack/route";

const origin = "https://aoa.jeremyhamann.dev";
const path = "/api/cron/operations-slack";
const account = "operations-slack-scheduler@ops-portal.iam.gserviceaccount.com";
const req = (url = origin + path, token = "Bearer synthetic-token") => new Request(url, { method: "POST", headers: { authorization: token } });

describe("dedicated Operations Slack scheduler authentication", () => {
  beforeEach(() => {
    vi.stubEnv("APP_ENV", "prod");
    vi.stubEnv("AOA_WRITES_PAUSED", "0");
    vi.stubEnv("OPERATIONS_SLACK_SCHEDULER_SERVICE_ACCOUNT", account);
    verify.mockReset().mockResolvedValue({ getPayload: () => ({ email: account, email_verified: true, iss: "https://accounts.google.com" }) });
    run.mockReset().mockResolvedValue({ processed: 0, sent: 0, failed: 0, uncertain: 0, expired: 0, skipped: true });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("binds a signed token to the exact production audience and dedicated identity", async () => {
    expect(await requireOperationsSlackCronAuth(req())).toBe(true);
    expect(verify).toHaveBeenCalledWith({ idToken: "synthetic-token", audience: origin + path });
  });
  it("accepts a proxy-reconstructed origin but never trusts it for the token audience", async () => {
    expect(await requireOperationsSlackCronAuth(req("http://internal:3000" + path))).toBe(true);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ audience: origin + path }));
  });
  it.each(["dev", "local", "production", ""])("denies environment %s before token verification", async (env) => {
    vi.stubEnv("APP_ENV", env);
    expect(await requireOperationsSlackCronAuth(req())).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(["", "someone@example.com", "Gtyiwf9bRptzzwuy-account@example-project.iam.gserviceaccount.com"])("denies missing or out-of-project account %s", async (email) => {
    vi.stubEnv("OPERATIONS_SLACK_SCHEDULER_SERVICE_ACCOUNT", email);
    expect(await requireOperationsSlackCronAuth(req())).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(["", "synthetic-token", "Basic synthetic-token", "Bearer synthetic-token extra"])("rejects malformed authorization", async (token) => {
    expect(await requireOperationsSlackCronAuth(req(undefined, token))).toBe(false);
  });
  it("does not accept a shared ingest bearer as an alternative", async () => {
    vi.stubEnv("INGEST_TOKEN", "synthetic-ingest-secret");
    verify.mockRejectedValue(new Error("not a signed Google token"));
    expect(await requireOperationsSlackCronAuth(req(undefined, "Bearer synthetic-ingest-secret"))).toBe(false);
  });
  it.each([
    { email: "service-account@example-project.iam.gserviceaccount.com", email_verified: true, iss: "https://accounts.google.com" },
    { email: account, email_verified: false, iss: "https://accounts.google.com" },
    { email: account, email_verified: true, iss: "https://attacker.test" },
    undefined,
  ])("fails closed on incorrect signed claims", async (payload) => {
    verify.mockResolvedValue({ getPayload: () => payload });
    expect(await requireOperationsSlackCronAuth(req())).toBe(false);
  });
  it("cannot replay an audience-bound token onto another path", async () => {
    expect(await requireOperationsSlackCronAuth(req(origin + "/api/cron/review-queue"))).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it("honors write pause", async () => {
    vi.stubEnv("AOA_WRITES_PAUSED", "1");
    expect(await requireOperationsSlackCronAuth(req())).toBe(false);
  });
  it("refuses unauthenticated delivery without touching the worker", async () => {
    expect((await POST(req(undefined, ""))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("requires POST", async () => expect((await GET()).status).toBe(405));
  it("reports disabled delivery without sending", async () => {
    const response = await POST(req());
    expect(response.status).toBe(200);
    expect((await response.json()).skipped).toBe(true);
  });
  it.each(["failed", "uncertain", "expired", "blocked"])("surfaces %s outcomes as scheduler failures", async (field) => {
    run.mockResolvedValue({ [field]: 1 });
    expect((await POST(req())).status).toBe(503);
  });
});
