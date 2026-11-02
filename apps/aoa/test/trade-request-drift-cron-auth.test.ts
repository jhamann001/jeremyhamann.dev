import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({ verify: vi.fn(), paused: vi.fn(() => false) }));
vi.mock("server-only", () => ({}));
vi.mock("google-auth-library", () => ({ OAuth2Client: class { verifyIdToken = m.verify; } }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: m.paused }));

import { requireTradeRequestDriftCronAuth } from "@/lib/cron/trade-request-drift-auth";

const SA = "trade-drift-scheduler@ops-portal.iam.gserviceaccount.com";
const AUDIENCE = "https://aoa.jeremyhamann.dev/api/cron/trade-request-drift";
const req = (opts: { path?: string; method?: string; auth?: string } = {}) =>
  new Request(`https://internal.example.test${opts.path ?? "/api/cron/trade-request-drift"}`, {
    method: opts.method ?? "POST",
    headers: { authorization: opts.auth ?? "Bearer token" },
  });
const payload = (email = SA) => ({ getPayload: () => ({ iss: "https://accounts.google.com", email_verified: true, email }) });

beforeEach(() => {
  vi.clearAllMocks();
  m.paused.mockReturnValue(false);
  m.verify.mockResolvedValue(payload());
  process.env.TRADE_REQUEST_DRIFT_SCHEDULER_AUDIENCE = AUDIENCE;
  process.env.TRADE_REQUEST_DRIFT_SCHEDULER_SERVICE_ACCOUNT = SA;
});
afterEach(() => {
  delete process.env.TRADE_REQUEST_DRIFT_SCHEDULER_AUDIENCE;
  delete process.env.TRADE_REQUEST_DRIFT_SCHEDULER_SERVICE_ACCOUNT;
});

describe("requireTradeRequestDriftCronAuth", () => {
  it("accepts the dedicated scheduler identity for the exact audience", async () => {
    expect(await requireTradeRequestDriftCronAuth(req())).toBe(true);
    expect(m.verify).toHaveBeenCalledWith({ idToken: "token", audience: AUDIENCE });
  });
  it("rejects another path, another method and a malformed bearer before verifying", async () => {
    expect(await requireTradeRequestDriftCronAuth(req({ path: "/api/cron/other" }))).toBe(false);
    expect(await requireTradeRequestDriftCronAuth(req({ method: "PUT" }))).toBe(false);
    expect(await requireTradeRequestDriftCronAuth(req({ auth: "Bearer a b" }))).toBe(false);
    expect(m.verify).not.toHaveBeenCalled();
  });
  it("rejects a token issued to another service account", async () => {
    m.verify.mockResolvedValue(payload("service-account@example-project.iam.gserviceaccount.com"));
    expect(await requireTradeRequestDriftCronAuth(req())).toBe(false);
  });
  it("rejects a configured audience that is not https or names another path", async () => {
    process.env.TRADE_REQUEST_DRIFT_SCHEDULER_AUDIENCE = "http://aoa.jeremyhamann.dev/api/cron/trade-request-drift";
    expect(await requireTradeRequestDriftCronAuth(req())).toBe(false);
    process.env.TRADE_REQUEST_DRIFT_SCHEDULER_AUDIENCE = "https://aoa.jeremyhamann.dev/api/cron/other";
    expect(await requireTradeRequestDriftCronAuth(req())).toBe(false);
  });
  it("rejects a configured identity outside the AOA projects", async () => {
    process.env.TRADE_REQUEST_DRIFT_SCHEDULER_SERVICE_ACCOUNT = "service-account@example-project.iam.gserviceaccount.com";
    expect(await requireTradeRequestDriftCronAuth(req())).toBe(false);
  });
  it("rejects every request while application writes are paused", async () => {
    m.paused.mockReturnValue(true);
    expect(await requireTradeRequestDriftCronAuth(req())).toBe(false);
  });
  it("rejects when verification throws", async () => {
    m.verify.mockRejectedValue(new Error("bad token"));
    expect(await requireTradeRequestDriftCronAuth(req())).toBe(false);
  });
});
