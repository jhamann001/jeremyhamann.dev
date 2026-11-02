import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = verify; } }));
import { requireAcatLinkCronAuth } from "@/lib/cron/acat-link-auth";

const email = "Gtyiwf9bRptzzwuy-account@example-project.iam.gserviceaccount.com";
const audience = "https://synthetic.example.invalid/api/cron/acat-link-sync";
const request = (header = "Bearer synthetic-jwt", method = "POST", path = "/api/cron/acat-link-sync") => new Request(`http://internal.invalid${path}`, { method, headers: { authorization: header } });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("ACAT_LINK_SCHEDULER_AUDIENCE", audience);
  vi.stubEnv("ACAT_LINK_SCHEDULER_SERVICE_ACCOUNT", email);
  vi.stubEnv("AOA_WRITES_PAUSED", "0");
  vi.stubEnv("INGEST_TOKEN", "synthetic-manual-token");
  verify.mockResolvedValue({ getPayload: () => ({ iss: "https://accounts.google.com", email_verified: true, email }) });
});
afterEach(() => vi.unstubAllEnvs());

describe("ACAT scheduler authentication", () => {
  it("verifies the exact audience and dedicated service identity behind a reverse proxy", async () => {
    expect(await requireAcatLinkCronAuth(request())).toBe(true);
    expect(verify).toHaveBeenCalledWith({ idToken: "synthetic-jwt", audience });
  });
  it("retains the manual ingest bearer without calling Google", async () => {
    expect(await requireAcatLinkCronAuth(request("Bearer synthetic-manual-token"))).toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(["", "bearer synthetic-jwt", "Bearer", "Bearer synthetic-jwt extra", "Bearer  synthetic-jwt"])("rejects malformed headers %j before verification", async (header) => {
    expect(await requireAcatLinkCronAuth(request(header))).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it("honors the global write pause for both credentials", async () => {
    vi.stubEnv("AOA_WRITES_PAUSED", "1");
    expect(await requireAcatLinkCronAuth(request())).toBe(false);
    expect(await requireAcatLinkCronAuth(request("Bearer synthetic-manual-token"))).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(["GET", "PUT"])("rejects %s and prevents cross-route replay", async (method) => {
    expect(await requireAcatLinkCronAuth(request(undefined, method))).toBe(false);
    expect(await requireAcatLinkCronAuth(request(undefined, "POST", "/api/cron/review-queue"))).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each([
    { iss: "https://attacker.invalid", email_verified: true, email },
    { iss: "https://accounts.google.com", email_verified: false, email },
    { iss: "https://accounts.google.com", email_verified: true, email: "service-account@example-project.iam.gserviceaccount.com" },
    undefined,
  ])("rejects invalid verified claims", async (payload) => {
    verify.mockResolvedValue({ getPayload: () => payload });
    expect(await requireAcatLinkCronAuth(request())).toBe(false);
  });
  it("does not expose signature failures", async () => {
    verify.mockRejectedValue(new Error("private token payload"));
    expect(await requireAcatLinkCronAuth(request())).toBe(false);
  });
  it.each(["", "http://synthetic.invalid/api/cron/acat-link-sync", "https://synthetic.invalid/api/cron/review-queue", `${audience}?scope=all`])("fails closed for invalid audience %j", async (value) => {
    vi.stubEnv("ACAT_LINK_SCHEDULER_AUDIENCE", value);
    expect(await requireAcatLinkCronAuth(request())).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
});
