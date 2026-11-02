import { beforeEach, describe, expect, it, vi } from "vitest";

const { scopeSpy, auditSpy } = vi.hoisted(() => ({
  scopeSpy: vi.fn(),
  auditSpy: vi.fn(async () => {}),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  writeAudit: auditSpy,
}));

import {
  appendTradeReconciliationReview,
  appendTradeReconciliationBulkReview,
} from "@/lib/data/trade-reconciliation";
import { MAX_TRADE_RECONCILIATION_BULK_REVIEW_ROWS } from "@/lib/operations/trade-reconciliation";

const RUN_ID = "cmrun123456";
const ROW_A = "a".repeat(64);
const ROW_B = "b".repeat(64);
const IDENTITY = { role: "OPERATIONS", email: "ops@example.com" };

function input(overrides: Partial<{
  runId: string;
  rowFingerprints: string[];
  classification: string;
  explanation: string;
}> = {}) {
  return {
    runId: RUN_ID,
    rowFingerprints: [ROW_A, ROW_B],
    classification: "Timing difference",
    explanation: "Custodian trades posted after the source cutoff.",
    ...overrides,
  };
}

describe("Trade Reconciliation bulk reviews", () => {
  let tx: {
    $queryRaw: ReturnType<typeof vi.fn>;
    tradeReconciliationRun: { findUnique: ReturnType<typeof vi.fn> };
    tradeReconciliationReviewEvent: {
      create: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    scopeSpy.mockReset();
    auditSpy.mockReset();
    tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ locked: "" }]),
      tradeReconciliationRun: {
        findUnique: vi.fn().mockResolvedValue({
          payload: [
            { id: ROW_A, symbol: "AAA", result: "APEX_ONLY" },
            { id: ROW_B, symbol: "BBB", result: "QUANTITY_BREAK" },
          ],
          review_events: [],
        }),
      },
      tradeReconciliationReviewEvent: {
        create: vi.fn().mockResolvedValue({ id: "cmreview123" }),
        createMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
    };
    scopeSpy.mockImplementation(async (_identity: unknown, fn: (value: typeof tx) => unknown) => fn(tx));
  });

  it("serializes an individual review with bulk eligibility checks while preserving append-only re-review", async () => {
    await expect(appendTradeReconciliationReview(IDENTITY, {
      runId: RUN_ID,
      rowFingerprint: ROW_A,
      classification: "Timing difference",
      explanation: "Explicit follow-up review.",
    })).resolves.toBe(true);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.tradeReconciliationRun.findUnique.mock.invocationCallOrder[0]!,
    );
    expect(tx.tradeReconciliationRun.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      tx.tradeReconciliationReviewEvent.create.mock.invocationCallOrder[0]!,
    );
    expect(tx.tradeReconciliationReviewEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        run_id: RUN_ID,
        row_fingerprint: ROW_A,
        explanation: "Explicit follow-up review.",
      }),
      select: { id: true },
    });
    // The single-row path deliberately does not query or reject prior events;
    // an operator can explicitly append a later correction after taking the lock.
    expect(tx.tradeReconciliationRun.findUnique).toHaveBeenCalledWith({
      where: { id: RUN_ID },
      select: { payload: true },
    });
  });

  it("rejects malformed, duplicate, and oversized selections before opening an RLS scope", async () => {
    const oversized = Array.from(
      { length: MAX_TRADE_RECONCILIATION_BULK_REVIEW_ROWS + 1 },
      (_value, index) => index.toString(16).padStart(64, "0"),
    );
    for (const invalid of [
      input({ runId: "../run" }),
      input({ rowFingerprints: [] }),
      input({ rowFingerprints: [ROW_A, ROW_A] }),
      input({ rowFingerprints: ["not-a-hash"] }),
      input({ rowFingerprints: oversized }),
      input({ classification: "Invented reason" }),
      input({ explanation: " " }),
      input({ explanation: "x".repeat(1001) }),
    ]) {
      await expect(appendTradeReconciliationBulkReview(IDENTITY, invalid)).resolves.toBe("invalid");
    }
    expect(scopeSpy).not.toHaveBeenCalled();
  });

  it("atomically creates one event per selected break and one metadata-only batch audit", async () => {
    await expect(appendTradeReconciliationBulkReview(IDENTITY, input())).resolves.toBe("saved");

    expect(scopeSpy).toHaveBeenCalledWith(IDENTITY, expect.any(Function), { timeout: 20_000 });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.tradeReconciliationReviewEvent.createMany).toHaveBeenCalledWith({
      data: [ROW_A, ROW_B].map((rowFingerprint) => ({
        run_id: RUN_ID,
        row_fingerprint: rowFingerprint,
        classification: "Timing difference",
        explanation: "Custodian trades posted after the source cutoff.",
        reviewer_email: "ops@example.com",
      })),
    });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const audit = (auditSpy.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { action: string; entityType: string; entityId: string; detail: Record<string, unknown> },
    ])?.[2];
    expect(audit).toMatchObject({
      action: "trade_reconciliation.break_review",
      entityType: "trade_reconciliation_review_batch",
      detail: {
        runId: RUN_ID,
        classification: "Timing difference",
        explanationPresent: true,
        reviewCount: 2,
      },
    });
    expect(audit?.entityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(audit)).not.toContain("Custodian trades posted");
    expect(JSON.stringify(audit)).not.toContain(ROW_A);
    expect(JSON.stringify(audit)).not.toContain(ROW_B);
  });

  it("rejects the whole batch when any selected row is already reviewed", async () => {
    tx.tradeReconciliationRun.findUnique.mockResolvedValueOnce({
      payload: [{ id: ROW_A, symbol: "AAA", result: "APEX_ONLY" }],
      review_events: [{ row_fingerprint: ROW_A }],
    });

    await expect(appendTradeReconciliationBulkReview(
      IDENTITY,
      input({ rowFingerprints: [ROW_A] }),
    )).resolves.toBe("already-reviewed");
    expect(tx.tradeReconciliationReviewEvent.createMany).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("rejects the whole batch when a fingerprint is absent or belongs to a matched row", async () => {
    tx.tradeReconciliationRun.findUnique.mockResolvedValueOnce({
      payload: [
        { id: ROW_A, symbol: "AAA", result: "APEX_ONLY" },
        { id: ROW_B, symbol: "BBB", result: "MATCHED" },
      ],
      review_events: [],
    });
    await expect(appendTradeReconciliationBulkReview(IDENTITY, input())).resolves.toBe("invalid");
    expect(tx.tradeReconciliationReviewEvent.createMany).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();

    tx.tradeReconciliationRun.findUnique.mockResolvedValueOnce({
      payload: [{ id: ROW_A, symbol: "AAA", result: "APEX_ONLY" }],
      review_events: [],
    });
    await expect(appendTradeReconciliationBulkReview(IDENTITY, input())).resolves.toBe("invalid");
    expect(tx.tradeReconciliationReviewEvent.createMany).not.toHaveBeenCalled();
  });

  it("throws if persistence does not create every event so the enclosing transaction rolls back", async () => {
    tx.tradeReconciliationReviewEvent.createMany.mockResolvedValueOnce({ count: 1 });
    await expect(appendTradeReconciliationBulkReview(IDENTITY, input()))
      .rejects.toThrow("trade_reconciliation_bulk_review_incomplete");
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
