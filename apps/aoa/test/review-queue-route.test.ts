import { beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy, flagSpy, sweepSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(() => true),
  flagSpy: vi.fn(() => true),
  sweepSpy: vi.fn(),
}));

vi.mock("@/lib/cron/review-queue-auth", () => ({ requireReviewQueueCronAuth: authSpy }));
vi.mock("@/lib/flags", () => ({ reviewQueueMaterializationEnabled: flagSpy }));
vi.mock("@/lib/data/review-queue-materialize", () => ({
  REVIEW_QUEUE_BATCH_MAX: 50,
  REVIEW_QUEUE_CRM_BATCH_MAX: 500,
  REVIEW_QUEUE_MATERIALIZATION_BUSY: "review_queue_materialization_already_running",
}));
vi.mock("@/lib/data/review-queue-sweep", () => ({ runReviewQueueSweepStep: sweepSpy }));

import * as route from "@/app/api/cron/review-queue/route";

function post(query = "", auth = "Bearer scheduler-or-ingest") {
  return new Request(`https://x/api/cron/review-queue${query}`, {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  authSpy.mockReset();
  authSpy.mockResolvedValue(true);
  flagSpy.mockReset();
  flagSpy.mockReturnValue(true);
  sweepSpy.mockReset();
  sweepSpy.mockResolvedValue({
    trade: { processed: 2, failed: false, hasMore: true, nextCursor: "003NEXT" },
    crm: { processed: 1, failed: false, hasMore: false, nextCursor: null },
    changes: { opened: 2, refreshed: 1, reopened: 0, autoResolved: 0, awakened: 0 },
    sweep: {
      completed: false, failed: false, failureSource: null,
      lastCompletedAt: null, lastFailureAt: null, lastFailureSource: null,
    },
  });
});

describe("POST /api/cron/review-queue", () => {
  it("rejects invalid bearer auth before flags or materialization", async () => {
    authSpy.mockResolvedValue(false);
    expect((await route.POST(post("", "Bearer wrong"))).status).toBe(401);
    expect(flagSpy).not.toHaveBeenCalled();
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it("returns a retryable failure when either source page fails", async () => {
    sweepSpy.mockResolvedValueOnce({
      trade: { processed: 0, failed: true, hasMore: false, nextCursor: null },
      crm: { processed: 1, failed: false, hasMore: false, nextCursor: null },
      changes: { opened: 0, refreshed: 0, reopened: 0, autoResolved: 0, awakened: 0 },
      sweep: {
        completed: false,
        failed: true,
        failureSource: "TRADE_REQUEST",
        lastCompletedAt: null,
        lastFailureAt: "2026-08-19T12:00:00.000Z",
        lastFailureSource: "TRADE_REQUEST",
      },
    });
    expect((await route.POST(post())).status).toBe(503);
  });

  it("returns a retryable failure for a derived cursor-integrity failure", async () => {
    sweepSpy.mockResolvedValueOnce({
      trade: { processed: 2, failed: false, hasMore: true, nextCursor: null },
      crm: { processed: 1, failed: false, hasMore: false, nextCursor: null },
      changes: { opened: 0, refreshed: 0, reopened: 0, autoResolved: 0, awakened: 0 },
      sweep: {
        completed: false,
        failed: true,
        failureSource: "TRADE_REQUEST",
        lastCompletedAt: null,
        lastFailureAt: "2026-08-19T12:00:00.000Z",
        lastFailureSource: "TRADE_REQUEST",
      },
    });
    expect((await route.POST(post())).status).toBe(503);
  });

  it("supports POST only", async () => {
    for (const handler of [route.GET, route.PUT, route.PATCH, route.DELETE]) {
      expect(handler().status).toBe(405);
    }
  });

  it("does no work while the independent materializer flag is off", async () => {
    flagSpy.mockReturnValue(false);
    const response = await route.POST(post());
    expect(await response.json()).toEqual({ materialized: 0, skipped: "flag_off" });
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it("validates hard bounds before calling the detector", async () => {
    for (const query of ["?limit=51", "?limit=0", "?crmLimit=501", "?crmLimit=1.5"]) {
      const response = await route.POST(post(query));
      expect(response.status).toBe(400);
    }
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it("advances a checkpointed bounded page and returns counts-only progress", async () => {
    const response = await route.POST(post("?limit=25&crmLimit=100"));
    expect(response.status).toBe(200);
    expect(sweepSpy).toHaveBeenCalledWith({ limit: 25, crmLimit: 100 });
    const body = await response.json();
    expect(body).toMatchObject({
      materialized: 3,
      trade: { processed: 2, hasMore: true },
      crm: { processed: 1, hasMore: false },
    });
    expect(JSON.stringify(body)).not.toContain("003NEXT");
  });

  it("returns 202 for the non-blocking concurrent-run guard", async () => {
    sweepSpy.mockRejectedValue(new Error("review_queue_materialization_already_running"));
    const response = await route.POST(post());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ materialized: 0, skipped: "already_running" });
  });

  it("fails closed with a static response when materialization fails", async () => {
    sweepSpy.mockRejectedValue(new Error("db down with identifiers"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await route.POST(post());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(errorSpy).toHaveBeenCalledWith("[review-queue] materialization_failed");
  });
});
