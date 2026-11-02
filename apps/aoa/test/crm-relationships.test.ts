import { beforeEach, describe, expect, it, vi } from "vitest";

const { transactionSpy, querySpy, executeSpy } = vi.hoisted(() => {
  const query = vi.fn();
  const execute = vi.fn();
  return {
    querySpy: query,
    executeSpy: execute,
    transactionSpy: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ $queryRaw: query, $executeRaw: execute })),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/crm/reconciler-db", () => ({
  crmReconcilerClient: () => ({ $transaction: transactionSpy }),
}));

import {
  CRM_RELATIONSHIP_RECONCILIATION_TIMEOUT_MS,
  CRM_RELATIONSHIP_STATEMENT_HEADROOM_MS,
  CRM_RELATIONSHIP_LOCK_TIMEOUT_MS,
  runCrmRelationshipSnapshot,
} from "@/lib/crm/relationships";

const rows = [
  "CRM_CONTACT_HOUSEHOLD",
  "AOA_DEAL_HOUSEHOLD",
  "AOA_TRANSFER_HOUSEHOLD",
].map((derivation_code) => ({
  derivation_code,
  snapshot_complete: true,
  candidates: 4n,
  created: 3n,
  refreshed: 1n,
  reactivated: 0n,
  inactivated: 0n,
  missing_endpoint: 1n,
  ambiguous_endpoint: 0n,
  rejected_type: 0n,
}));

describe("CRM relationship reconciliation seam", () => {
  beforeEach(() => {
    transactionSpy.mockClear();
    querySpy.mockReset();
    querySpy.mockResolvedValue(rows);
    executeSpy.mockReset();
    executeSpy.mockResolvedValue(1);
  });

  it.each([true, false])("maps counts for dryRun=%s with a bounded transaction", async (dryRun) => {
    await expect(runCrmRelationshipSnapshot(
      "40000000-0000-4000-8000-000000000001",
      dryRun,
      { contact: true, deal: true, transfer: true },
    )).resolves.toEqual(rows.map((row) => ({
      derivation: row.derivation_code,
      snapshotComplete: true,
      candidates: 4,
      created: 3,
      refreshed: 1,
      reactivated: 0,
      inactivated: 0,
      missingEndpoint: 1,
      ambiguousEndpoint: 0,
      rejectedType: 0,
    })));

    expect(CRM_RELATIONSHIP_RECONCILIATION_TIMEOUT_MS).toBe(240_000);
    expect(transactionSpy).toHaveBeenCalledOnce();
    const [, options] = transactionSpy.mock.calls[0] as unknown as [
      unknown,
      { timeout: number; maxWait: number },
    ];
    expect(options).toEqual({
      timeout: 240_000,
      maxWait: 15_000,
    });
    expect(querySpy).toHaveBeenCalledOnce();
    expect(CRM_RELATIONSHIP_STATEMENT_HEADROOM_MS).toBe(30_000);
    expect(CRM_RELATIONSHIP_LOCK_TIMEOUT_MS).toBe(5_000);
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(executeSpy.mock.calls[0][0].join("")).toContain("'statement_timeout'");
    expect(executeSpy.mock.calls[0][0].join("")).toContain(", true");
    expect(executeSpy.mock.calls[0][1]).toBe("210000");
    expect(executeSpy.mock.calls[1][0].join("")).toContain("'lock_timeout'");
    expect(executeSpy.mock.calls[1][0].join("")).toContain(", true");
    expect(executeSpy.mock.calls[1][1]).toBe("5000");
    expect(executeSpy.mock.invocationCallOrder[1]).toBeLessThan(querySpy.mock.invocationCallOrder[0]);
    const sql = querySpy.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join("")).toContain(dryRun
      ? "app.preview_crm_relationship_snapshot("
      : "app.reconcile_crm_relationship_snapshot(");
    expect(sql.values).toEqual(["40000000-0000-4000-8000-000000000001", true, true, true]);
  });

  it("fails closed on a partial or duplicate derivation result", async () => {
    querySpy.mockResolvedValueOnce(rows.slice(0, 2));
    await expect(runCrmRelationshipSnapshot(
      "40000000-0000-4000-8000-000000000002",
      true,
      { contact: false, deal: false, transfer: false },
    )).rejects.toThrow("crm_relationship_reconciliation_incomplete_result");

    querySpy.mockResolvedValueOnce([rows[0], rows[0], rows[1]]);
    await expect(runCrmRelationshipSnapshot(
      "40000000-0000-4000-8000-000000000003",
      true,
      { contact: false, deal: false, transfer: false },
    )).rejects.toThrow("crm_relationship_reconciliation_incomplete_result");
  });

  it("accepts a shorter transaction budget for best-effort callers", async () => {
    await runCrmRelationshipSnapshot(
      "40000000-0000-4000-8000-000000000004",
      false,
      { contact: true, deal: true, transfer: true },
      100_000,
    );

    const [, options] = transactionSpy.mock.calls[0] as unknown as [
      unknown,
      { timeout: number; maxWait: number },
    ];
    expect(options).toEqual({ timeout: 100_000, maxWait: 15_000 });
    expect(executeSpy.mock.calls[0][1]).toBe("70000");
  });

  it("retains a one-second statement floor for short best-effort budgets", async () => {
    await runCrmRelationshipSnapshot(
      "40000000-0000-4000-8000-000000000005", true,
      { contact: false, deal: true, transfer: false }, 20_000,
    );
    expect(executeSpy.mock.calls[0][1]).toBe("1000");
    expect(querySpy.mock.calls[0][0].values).toEqual([
      "40000000-0000-4000-8000-000000000005", false, true, false,
    ]);
  });

  it("propagates SQL cancellation without retrying the snapshot", async () => {
    const canceled = new Error("synthetic statement canceled");
    querySpy.mockRejectedValueOnce(canceled);
    await expect(runCrmRelationshipSnapshot(
      "40000000-0000-4000-8000-000000000006", false,
      { contact: true, deal: true, transfer: true },
    )).rejects.toBe(canceled);
    expect(transactionSpy).toHaveBeenCalledOnce();
    expect(querySpy).toHaveBeenCalledOnce();
  });

  it("does not start snapshot work when a database bound cannot be installed", async () => {
    const failed = new Error("synthetic settings failure");
    executeSpy.mockRejectedValueOnce(failed);
    await expect(runCrmRelationshipSnapshot(
      "40000000-0000-4000-8000-000000000007", false,
      { contact: true, deal: true, transfer: true },
    )).rejects.toBe(failed);
    expect(querySpy).not.toHaveBeenCalled();
  });
});
