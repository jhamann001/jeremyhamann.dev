import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authSpy,
  bulkReviewSpy,
  flagSpy,
  accessSpy,
  revalidateSpy,
} = vi.hoisted(() => ({
  authSpy: vi.fn(),
  bulkReviewSpy: vi.fn(),
  flagSpy: vi.fn(),
  accessSpy: vi.fn(),
  revalidateSpy: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/flags", () => ({ operationsTradeReconciliationPreviewEnabled: flagSpy }));
vi.mock("@/lib/operations/authorization", () => ({ canAccessOperationsTools: accessSpy }));
vi.mock("@/lib/data/trade-reconciliation", () => ({
  appendTradeReconciliationBulkReview: bulkReviewSpy,
  appendTradeReconciliationNote: vi.fn(),
  appendTradeReconciliationReview: vi.fn(),
  persistCompletedTradeReconciliation: vi.fn(),
  tradeReconciliationHistory: vi.fn(),
}));
vi.mock("@/lib/market-calendar", () => ({
  isTradingDay: vi.fn(), previousTradingDay: vi.fn(), toDateStr: vi.fn(),
}));
vi.mock("@/lib/operations/trade-reconciliation-source", () => ({ fetchTradeReconciliationSources: vi.fn() }));

import { saveTradeReconciliationBulkReview } from "@/app/(authenticated)/operations/trade-reconciliation/actions";

const INPUT = {
  runId: "cmrun123456",
  rowFingerprints: ["a".repeat(64), "b".repeat(64)],
  classification: "Timing difference",
  explanation: "Shared operational explanation.",
};

describe("Trade Reconciliation bulk review action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSpy.mockResolvedValue({ user: { role: "OPERATIONS", email: "ops@example.com" } });
    flagSpy.mockReturnValue(true);
    accessSpy.mockReturnValue(true);
    bulkReviewSpy.mockResolvedValue("saved");
  });

  it("re-authenticates and refuses writes when the flag or Operations/Admin gate is closed", async () => {
    accessSpy.mockReturnValueOnce(false);
    await expect(saveTradeReconciliationBulkReview(INPUT)).resolves.toEqual({
      ok: false,
      message: "Not authorized.",
    });
    expect(bulkReviewSpy).not.toHaveBeenCalled();

    accessSpy.mockReturnValue(true);
    flagSpy.mockReturnValueOnce(false);
    await expect(saveTradeReconciliationBulkReview(INPUT)).resolves.toEqual({
      ok: false,
      message: "Not authorized.",
    });
    expect(bulkReviewSpy).not.toHaveBeenCalled();
  });

  it("passes the authenticated identity to the RLS-scoped writer and revalidates after success", async () => {
    await expect(saveTradeReconciliationBulkReview(INPUT)).resolves.toEqual({
      ok: true,
      message: "Review saved for 2 breaks.",
    });
    expect(bulkReviewSpy).toHaveBeenCalledWith(
      { role: "OPERATIONS", email: "ops@example.com" },
      INPUT,
    );
    expect(revalidateSpy).toHaveBeenCalledWith("/operations/trade-reconciliation");
  });

  it("surfaces a safe conflict when any selected break has already been reviewed", async () => {
    bulkReviewSpy.mockResolvedValueOnce("already-reviewed");
    const result = await saveTradeReconciliationBulkReview(INPUT);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/already reviewed/i);
    expect(result.message).not.toContain(INPUT.explanation);
    expect(revalidateSpy).not.toHaveBeenCalled();
  });
});
