import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeSpy, querySpy, transactionSpy } = vi.hoisted(() => {
  const execute = vi.fn(async () => 0);
  const query = vi.fn();
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => callback({
    $executeRaw: execute,
    $queryRaw: query,
  }));
  return { executeSpy: execute, querySpy: query, transactionSpy: transaction };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/crm/reconciler-db", () => ({
  crmReconcilerClient: () => ({ $transaction: transactionSpy }),
}));

import { runCrmIdentityCoverageDiagnostics } from "@/lib/crm/coverage";

describe("CRM identity coverage diagnostics", () => {
  beforeEach(() => {
    executeSpy.mockClear();
    querySpy.mockReset();
    transactionSpy.mockClear();
  });

  it("returns counts-only totals and source-coordinate detail", async () => {
    querySpy.mockResolvedValueOnce([
      {
        identity_type: "HOUSEHOLD",
        source_system: "CRM",
        source_namespace: "household",
        source_rows: 3n,
        mapped_sources: 3n,
        unmapped_sources: 0n,
        stale_mappings: 1n,
        inactive_mappings: 0n,
        open_exceptions: 0n,
        newest_source_at: new Date("2026-08-06T12:00:00Z"),
        oldest_unmapped_at: null,
      },
      {
        identity_type: "TASK",
        source_system: "CRM",
        source_namespace: "task",
        source_rows: 2n,
        mapped_sources: 1n,
        unmapped_sources: 1n,
        stale_mappings: 0n,
        inactive_mappings: 1n,
        open_exceptions: 1n,
        newest_source_at: new Date("2026-08-06T13:00:00Z"),
        oldest_unmapped_at: new Date("2026-08-05T11:00:00Z"),
      },
    ]);

    const result = await runCrmIdentityCoverageDiagnostics();

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(transactionSpy).toHaveBeenCalledOnce();
    expect(result).toEqual({
      summary: {
        source_rows: 5,
        mapped_sources: 4,
        unmapped_sources: 1,
        stale_mappings: 1,
        inactive_mappings: 1,
        open_exceptions: 1,
        coverage_percent: 80,
        newest_source_at: "2026-08-06T13:00:00.000Z",
        oldest_unmapped_at: "2026-08-05T11:00:00.000Z",
      },
      by_source: [
        expect.objectContaining({
          identity_type: "HOUSEHOLD",
          source_rows: 3,
          mapped_sources: 3,
        }),
        expect.objectContaining({
          identity_type: "TASK",
          unmapped_sources: 1,
          oldest_unmapped_at: "2026-08-05T11:00:00.000Z",
        }),
      ],
    });
  });

  it("treats an empty approved-source snapshot as fully covered", async () => {
    querySpy.mockResolvedValueOnce([]);
    const result = await runCrmIdentityCoverageDiagnostics();
    expect(result.summary).toMatchObject({
      source_rows: 0,
      mapped_sources: 0,
      unmapped_sources: 0,
      coverage_percent: 100,
    });
    expect(result.by_source).toEqual([]);
  });

  it("rejects counts that cannot be represented safely", async () => {
    querySpy.mockResolvedValueOnce([{
      identity_type: "TASK",
      source_system: "CRM",
      source_namespace: "task",
      source_rows: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      mapped_sources: 0n,
      unmapped_sources: 0n,
      stale_mappings: 0n,
      inactive_mappings: 0n,
      open_exceptions: 0n,
      newest_source_at: null,
      oldest_unmapped_at: null,
    }]);

    await expect(runCrmIdentityCoverageDiagnostics()).rejects.toThrow(
      "crm_coverage_invalid_source_rows",
    );
  });
});
