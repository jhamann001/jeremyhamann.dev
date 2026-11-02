import { beforeEach, describe, expect, it, vi } from "vitest";
import { markCase } from "./acat-book-flywheel";

const { authSpy, flagSpy, runSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(),
  flagSpy: vi.fn(),
  runSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/cron/custodian-projection-auth", () => ({ requireCustodianProjectionCronAuth: authSpy }));
vi.mock("@/lib/flags", () => ({ custodianChangeDeliveryEnabled: flagSpy }));
vi.mock("@/lib/data/custodian-projection-dispatch", () => ({ runCustodianProjectionDelivery: runSpy }));

import * as route from "@/app/api/cron/custodian-projection/route";

const post = () => new Request("https://x/api/cron/custodian-projection", { method: "POST" });

beforeEach(() => {
  vi.resetAllMocks();
  authSpy.mockResolvedValue(true);
  flagSpy.mockReturnValue(true);
  runSpy.mockResolvedValue({ delivered: [1, 2], stoppedRevision: null, reason: "complete" });
});

describe("POST /api/cron/custodian-projection", () => {
  it("refuses an unauthorized caller before the switch or delivery", async () => {
    authSpy.mockResolvedValue(false);
    const res = await route.POST(post());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(flagSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    markCase("custodian-projection-route", "refuses an unauthorized caller before the switch or delivery");
  });

  it("does nothing while the delivery switch is off", async () => {
    flagSpy.mockReturnValue(false);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: false, reason: "switch_off" });
    expect(runSpy).not.toHaveBeenCalled();
    markCase("custodian-projection-route", "does nothing while the delivery switch is off");
  });

  it("returns the walk result while the switch is on", async () => {
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(await res.json()).toEqual({ delivered: [1, 2], stoppedRevision: null, reason: "complete" });
    markCase("custodian-projection-route", "returns the walk result while the switch is on");
  });

  it("answers GET with 405", async () => {
    const res = await route.GET();
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
    markCase("custodian-projection-route", "answers GET with 405");
  });

  it("returns 503 when delivery retries", async () => {
    const body = { delivered: [1], stoppedRevision: 2, reason: "retry" };
    runSpy.mockResolvedValue(body);
    const res = await route.POST(post());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(body);
    markCase("custodian-projection-route", "returns 503 when delivery retries");
  });

  it("returns 503 when delivery is unauthorized", async () => {
    const body = { delivered: [], stoppedRevision: 1, reason: "unauthorized" };
    runSpy.mockResolvedValue(body);
    const res = await route.POST(post());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(body);
    markCase("custodian-projection-route", "returns 503 when delivery is unauthorized");
  });

  it("returns 200 when delivery stops on a gap", async () => {
    const body = { delivered: [1], stoppedRevision: 2, reason: "gap" };
    runSpy.mockResolvedValue(body);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    markCase("custodian-projection-route", "returns 200 when delivery stops on a gap");
  });

  it("returns 200 when delivery stops on a mismatch", async () => {
    const body = { delivered: [1], stoppedRevision: 2, reason: "mismatch" };
    runSpy.mockResolvedValue(body);
    const res = await route.POST(post());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    markCase("custodian-projection-route", "returns 200 when delivery stops on a mismatch");
  });
});
