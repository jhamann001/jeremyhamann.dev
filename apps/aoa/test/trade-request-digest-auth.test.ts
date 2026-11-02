import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = verify; } }));
import { requireTradeRequestDigestCronAuth } from "@/lib/cron/trade-request-digest-auth";

const email = "Gtyiwf9bRptzzwuy-account@example-project.iam.gserviceaccount.com";
const audience = "https://synthetic.example.invalid/api/cron/trade-request-digest";
const request = (header = "Bearer synthetic-jwt", method = "POST", path = "/api/cron/trade-request-digest") =>
  new Request(`http://internal.invalid${path}`, { method, headers: { authorization: header } });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TRADE_REQUEST_DIGEST_SCHEDULER_AUDIENCE", audience);
  vi.stubEnv("TRADE_REQUEST_DIGEST_SCHEDULER_SERVICE_ACCOUNT", email);
  vi.stubEnv("AOA_WRITES_PAUSED", "0");
  vi.stubEnv("INGEST_TOKEN", "synthetic-manual-token");
  verify.mockResolvedValue({ getPayload: () => ({ iss: "https://accounts.google.com", email_verified: true, email }) });
});
afterEach(() => vi.unstubAllEnvs());

describe("Trade Request digest scheduler authentication", () => {
  it("verifies the exact audience and the dedicated scheduler identity", async () => {
    expect(await requireTradeRequestDigestCronAuth(request())).toBe(true);
    expect(verify).toHaveBeenCalledWith({ idToken: "synthetic-jwt", audience });
  });
  it.each(["", "bearer synthetic-jwt", "Bearer", "Bearer synthetic-jwt extra", "Bearer  synthetic-jwt"])("rejects malformed header %j before verification", async (header) => {
    expect(await requireTradeRequestDigestCronAuth(request(header))).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it("does not accept the shared ingest token", async () => {
    verify.mockRejectedValue(new Error("Wrong number of segments"));
    expect(await requireTradeRequestDigestCronAuth(request("Bearer synthetic-manual-token"))).toBe(false);
  });
  it("honors the global write pause", async () => {
    vi.stubEnv("AOA_WRITES_PAUSED", "1");
    expect(await requireTradeRequestDigestCronAuth(request())).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each([
    ["GET", "/api/cron/trade-request-digest"],
    ["POST", "/api/cron/review-queue"],
  ])("rejects %s %s (wrong method or cross-route replay)", async (method, path) => {
    expect(await requireTradeRequestDigestCronAuth(request(undefined, method, path))).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each([
    { iss: "https://attacker.invalid", email_verified: true, email },
    { iss: "https://accounts.google.com", email_verified: false, email },
    { iss: "https://accounts.google.com", email_verified: true, email: "service-account@example-project.iam.gserviceaccount.com" },
    undefined,
  ])("rejects invalid verified claims %#", async (payload) => {
    verify.mockResolvedValue({ getPayload: () => payload });
    expect(await requireTradeRequestDigestCronAuth(request())).toBe(false);
  });
  it("does not expose signature failures", async () => {
    verify.mockRejectedValue(new Error("private token payload"));
    expect(await requireTradeRequestDigestCronAuth(request())).toBe(false);
  });
  it.each(["", "http://synthetic.example.invalid/api/cron/trade-request-digest", "https://synthetic.example.invalid/api/cron/review-queue", `${audience}?scope=all`])("fails closed for audience %j", async (value) => {
    vi.stubEnv("TRADE_REQUEST_DIGEST_SCHEDULER_AUDIENCE", value);
    expect(await requireTradeRequestDigestCronAuth(request())).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(["", "not-an-email"])("fails closed for service account %j", async (value) => {
    vi.stubEnv("TRADE_REQUEST_DIGEST_SCHEDULER_SERVICE_ACCOUNT", value);
    expect(await requireTradeRequestDigestCronAuth(request())).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
});
