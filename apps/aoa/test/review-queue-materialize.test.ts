import { beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy, tradeBatchSpy } = vi.hoisted(() => ({
  scopeSpy: vi.fn(),
  tradeBatchSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("@/lib/data/trade-requests", () => ({
  getAuthoritativeTradeRequestsForUsers: tradeBatchSpy,
}));

import { runReviewQueueMaterialization } from "@/lib/data/review-queue-materialize";

describe("review queue materializer failure isolation", () => {
  beforeEach(() => {
    scopeSpy.mockReset();
    tradeBatchSpy.mockReset();
  });

  it.each(["404", "malformed 200"])(
    "does not clear existing Trade Request work after a non-authoritative %s batch",
    async (failure) => {
    const tradeRead = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ sf_id: "003SAFE", cedar_ridge_user_id: "external-user" }])
        .mockResolvedValueOnce([]),
      tradeProfileSelection: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const crmRead = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const queueWrite = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([]),
      reviewQueueItem: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        updateMany: vi.fn(),
      },
      reviewQueueEvent: { create: vi.fn() },
    };
    scopeSpy
      .mockImplementationOnce(async (_identity, fn) => fn(tradeRead))
      .mockImplementationOnce(async (_identity, fn) => fn(crmRead))
      .mockImplementationOnce(async (_identity, fn) => fn(queueWrite));
    tradeBatchSpy.mockRejectedValue(new Error(`${failure} external payload with identifiers`));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runReviewQueueMaterialization({ limit: 1, crmLimit: 1 });

    expect(result.trade).toMatchObject({ processed: 0, failed: true });
    expect(queueWrite.reviewQueueItem.updateMany).not.toHaveBeenCalled();
    expect(queueWrite.reviewQueueEvent.create).not.toHaveBeenCalled();
    expect(queueWrite.reviewQueueItem.findMany).toHaveBeenCalledOnce();
    expect(queueWrite.reviewQueueItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "SNOOZED" }),
    }));
    expect(errorSpy).toHaveBeenCalledWith("[review-queue] trade_batch_failed");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("external payload");
    errorSpy.mockRestore();
    },
  );

  it("may clear prior Trade work after a legitimate authoritative empty 200 batch", async () => {
    const tradeRead = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ sf_id: "003SAFE", cedar_ridge_user_id: "external-user" }])
        .mockResolvedValueOnce([]),
      tradeProfileSelection: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const crmRead = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const prior = {
      id: "queue-prior", detector_key: "a".repeat(64), status: "IN_REVIEW",
      exception_type: "TRADE_PROFILE_MULTIPLE_UNCONFIRMED",
      updated_at: new Date("2026-08-17T12:00:00.000Z"),
    };
    const queueWrite = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([]),
      reviewQueueItem: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([prior]),
        create: vi.fn(), update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      reviewQueueEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    scopeSpy
      .mockImplementationOnce(async (_identity, fn) => fn(tradeRead))
      .mockImplementationOnce(async (_identity, fn) => fn(crmRead))
      .mockImplementationOnce(async (_identity, fn) => fn(queueWrite));
    tradeBatchSpy.mockResolvedValue([]);

    const result = await runReviewQueueMaterialization({ limit: 1, crmLimit: 1 });

    expect(result.trade).toMatchObject({ processed: 1, failed: false });
    expect(result.changes.autoResolved).toBe(1);
    expect(queueWrite.reviewQueueItem.updateMany).toHaveBeenCalledWith({
      where: {
        id: "queue-prior", source_active: true,
        updated_at: new Date("2026-08-17T12:00:00.000Z"),
      },
      data: expect.objectContaining({ source_active: false, status: "RESOLVED" }),
    });
    expect(queueWrite.reviewQueueEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "SOURCE_CLEARED", item_id: "queue-prior" }),
    });
  });

  it("preserves the authoritative CRM exception detection date on first materialization", async () => {
    const detectedAt = new Date("2026-08-10T15:26:00.000Z");
    const crmRead = { $queryRaw: vi.fn().mockResolvedValue([{
      exception_id: "c_exception", identity_id: "apt_identity",
      reason_code: "MISSING_PARENT_MAPPING", identity_type: "APPOINTMENT",
      detected_at: detectedAt,
    }]) };
    const created = { id: "queue-created" };
    const queueWrite = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ acquired: true }])
        .mockResolvedValueOnce([]),
      reviewQueueItem: {
        findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
        create: vi.fn().mockResolvedValue(created),
        updateMany: vi.fn(),
      },
      reviewQueueEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    scopeSpy
      .mockImplementationOnce(async (_identity, fn) => fn(crmRead))
      .mockImplementationOnce(async (_identity, fn) => fn(queueWrite));

    const result = await runReviewQueueMaterialization({ skipTrade: true, crmLimit: 1 });

    expect(result.crm).toMatchObject({ processed: 1, failed: false });
    expect(queueWrite.reviewQueueItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        detected_at: detectedAt,
        source_record_ref: "c_exception",
        resolution_href: "/crm/apt_identity?resolutionException=c_exception#resolve-parent-mapping",
      }),
    });
  });
});
