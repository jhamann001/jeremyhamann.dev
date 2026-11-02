import { beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, flagSpy, stateSpy, runSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  flagSpy: vi.fn(),
  stateSpy: vi.fn(),
  runSpy: vi.fn(),
}));

vi.mock("@/lib/cron/trade-request-digest-auth", () => ({ requireTradeRequestDigestCronAuth: authSpy }));
vi.mock("@/lib/flags", () => ({ tradeRequestsDigestJobEnabled: flagSpy }));
vi.mock("@/lib/trade-requests/serving-state", () => ({ readServingState: stateSpy }));
vi.mock("@/lib/trade-requests/native/digest", () => ({ runDailyDigest: runSpy }));

import * as route from "@/app/api/cron/trade-request-digest/route";

const counts = { total: 3, urgent: 1, overdue48h: 0 };
const post = () => new Request("https://x/api/cron/trade-request-digest", { method: "POST", headers: { authorization: "Bearer synthetic-jwt" } });
const served = (digestSender: "standalone" | "aoa") => ({ servingSource: "aoa", digestSender, driftSender: "standalone" });

beforeEach(() => {
  vi.resetAllMocks();
  authSpy.mockResolvedValue(true);
  flagSpy.mockReturnValue(true);
  stateSpy.mockResolvedValue(served("aoa"));
  runSpy.mockResolvedValue({ sent: true, runDate: "2026-10-19", counts });
});

describe("POST /api/cron/trade-request-digest", () => {
  it("refuses a caller without the scheduler identity before any switch, state read or digest work", async () => {
    authSpy.mockResolvedValue(false);
    const res = await route.POST(post());
    expect(res.status).toBe(401);
    expect(flagSpy).not.toHaveBeenCalled();
    expect(stateSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });
  it("does nothing while the digest switch is off", async () => {
    flagSpy.mockReturnValue(false);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: false, reason: "switch_off" });
    expect(stateSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });
  it("posts nothing and claims nothing while AOA is not the digest sender", async () => {
    stateSpy.mockResolvedValue(served("standalone"));
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: false, reason: "not_sender" });
    expect(runSpy).not.toHaveBeenCalled();
  });
  it("runs the digest once while AOA is the digest sender", async () => {
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(await res.json()).toEqual({ sent: true, runDate: "2026-10-19", counts });
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
  it("returns already posted with 200", async () => {
    runSpy.mockResolvedValue({ sent: false, reason: "already_posted", runDate: "2026-10-19", counts });
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect((await res.json()).reason).toBe("already_posted");
  });
  it("reports a failed post in the run result with 503", async () => {
    runSpy.mockResolvedValue({ sent: false, reason: "post_failed", code: "channel_not_found", runDate: "2026-10-19", counts });
    const res = await route.POST(post());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ sent: false, reason: "post_failed", code: "channel_not_found", runDate: "2026-10-19", counts });
  });
  it("returns 503 without echoing an unexpected error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    runSpy.mockRejectedValue(new Error("private detail"));
    const res = await route.POST(post());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "digest_failed" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("private detail");
    errors.mockRestore();
  });
  it.each(["GET", "PUT", "PATCH", "DELETE"] as const)("answers %s with 405", async (method) => {
    const res = await route[method]();
    expect(res.status).toBe(405);
    expect(authSpy).not.toHaveBeenCalled();
  });
});
