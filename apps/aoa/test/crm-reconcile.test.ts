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
  CRM_RECONCILIATION_BUSY_ERROR,
  CRM_RECONCILIATION_LOCK_TIMEOUT_MS,
  CRM_RECONCILIATION_STATEMENT_HEADROOM_MS,
  CRM_RECONCILIATION_TIMEOUT_MS,
  runCrmIdentityReconciliation,
} from "@/lib/crm/reconcile";

describe("CRM identity reconciliation", () => {
  beforeEach(() => {
    delete process.env.CRM_DUPLICATE_DETECTOR_WRITES;
    transactionSpy.mockClear();
    querySpy.mockReset();
    executeSpy.mockReset();
    executeSpy.mockResolvedValue(1);
  });

  it("uses the rollback-backed exact preview while remaining below the request ceiling", async () => {
    querySpy.mockResolvedValueOnce([{ acquired: true }]).mockResolvedValueOnce([{
      sources_seen: 17n,
      identities_created: 3n,
      mappings_created: 5n,
      mappings_refreshed: 2n,
      exceptions_opened: 1n,
      exceptions_reopened: 0n,
      exceptions_resolved: 4n,
      duplicate_signals_seen: 2n,
      duplicate_candidates_would_open: 1n,
      duplicate_candidates_would_refresh: 1n,
      duplicate_candidates_would_inactivate: 0n,
    }]).mockResolvedValueOnce([{
      signals_seen: 1n,
      candidates_opened: 1n,
      candidates_refreshed: 0n,
      candidates_inactivated: 0n,
    }]);

    await expect(
      runCrmIdentityReconciliation("00000000-0000-4000-8000-000000000001", true),
    ).resolves.toEqual({
      sourcesSeen: 17,
      identitiesCreated: 3,
      mappingsCreated: 5,
      mappingsRefreshed: 2,
      exceptionsOpened: 1,
      exceptionsReopened: 0,
      exceptionsResolved: 4,
      duplicateSignalsSeen: 3,
      duplicateMode: "preview",
      duplicateCandidatesWouldOpen: 2,
      duplicateCandidatesWouldRefresh: 1,
      duplicateCandidatesWouldInactivate: 0,
    });

    expect(CRM_RECONCILIATION_TIMEOUT_MS).toBe(240_000);
    expect(CRM_RECONCILIATION_STATEMENT_HEADROOM_MS).toBe(30_000);
    expect(CRM_RECONCILIATION_LOCK_TIMEOUT_MS).toBe(5_000);
    expect(transactionSpy).toHaveBeenCalledOnce();
    const [, options] = transactionSpy.mock.calls[0] as unknown as [
      unknown,
      { timeout: number; maxWait: number },
    ];
    expect(options).toEqual({
      timeout: 240_000,
      maxWait: 15_000,
    });
    expect(querySpy).toHaveBeenCalledTimes(3);
    const previewSql = querySpy.mock.calls[1][0] as { strings: string[] };
    expect(previewSql.strings.join(" ")).toContain(
      "preview_crm_identity_duplicate_reconciliation",
    );
    const contactSql = querySpy.mock.calls[2][0] as { strings: string[] };
    expect(contactSql.strings.join(" ")).toContain(
      "preview_crm_contact_duplicate_candidates",
    );
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps the live parent and source phases explicit", async () => {
    querySpy
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([{
        sources_seen: 5n,
        identities_created: 1n,
        mappings_created: 2n,
        mappings_refreshed: 2n,
      }])
      .mockResolvedValueOnce([{
        sources_seen: 12n,
        identities_created: 2n,
        mappings_created: 3n,
        mappings_refreshed: 0n,
        exceptions_opened: 1n,
        exceptions_reopened: 0n,
        exceptions_resolved: 4n,
      }])
      .mockResolvedValueOnce([{
        signals_seen: 2n,
        candidates_opened: 1n,
        candidates_refreshed: 1n,
        candidates_inactivated: 0n,
      }])
      .mockResolvedValueOnce([{
        signals_seen: 1n,
        candidates_opened: 1n,
        candidates_refreshed: 0n,
        candidates_inactivated: 0n,
      }]);

    await expect(
      runCrmIdentityReconciliation("00000000-0000-4000-8000-000000000002", false),
    ).resolves.toEqual({
      sourcesSeen: 17,
      identitiesCreated: 3,
      mappingsCreated: 5,
      mappingsRefreshed: 2,
      exceptionsOpened: 1,
      exceptionsReopened: 0,
      exceptionsResolved: 4,
      duplicateSignalsSeen: 3,
      duplicateMode: "preview",
      duplicateCandidatesWouldOpen: 2,
      duplicateCandidatesWouldRefresh: 1,
      duplicateCandidatesWouldInactivate: 0,
    });
    expect(querySpy).toHaveBeenCalledTimes(5);
    const duplicateSql = querySpy.mock.calls[3][0] as { strings: string[] };
    expect(duplicateSql.strings.join(" ")).toContain("preview_crm_duplicate_candidates");
    const contactSql = querySpy.mock.calls[4][0] as { strings: string[] };
    expect(contactSql.strings.join(" ")).toContain("preview_crm_contact_duplicate_candidates");
  });

  it("writes duplicate candidates only when the independent detector flag is exact 1", async () => {
    process.env.CRM_DUPLICATE_DETECTOR_WRITES = "1";
    querySpy
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([{
        sources_seen: 0n,
        identities_created: 0n,
        mappings_created: 0n,
        mappings_refreshed: 0n,
      }])
      .mockResolvedValueOnce([{
        sources_seen: 0n,
        identities_created: 0n,
        mappings_created: 0n,
        mappings_refreshed: 0n,
        exceptions_opened: 0n,
        exceptions_reopened: 0n,
        exceptions_resolved: 0n,
      }])
      .mockResolvedValueOnce([{
        signals_seen: 0n,
        candidates_opened: 0n,
        candidates_refreshed: 0n,
        candidates_inactivated: 0n,
      }])
      .mockResolvedValueOnce([{
        signals_seen: 0n,
        candidates_opened: 0n,
        candidates_refreshed: 0n,
        candidates_inactivated: 0n,
      }]);

    await expect(runCrmIdentityReconciliation(
      "00000000-0000-4000-8000-000000000005",
      false,
    )).resolves.toMatchObject({
      duplicateMode: "persisted",
      duplicateCandidatesOpened: 0,
      duplicateCandidatesRefreshed: 0,
      duplicateCandidatesInactivated: 0,
    });

    const duplicateSql = querySpy.mock.calls[3][0] as { strings: string[] };
    expect(duplicateSql.strings.join(" ")).toContain("reconcile_crm_duplicate_candidates");
    expect(duplicateSql.strings.join(" ")).not.toContain("preview_");
    const contactSql = querySpy.mock.calls[4][0] as { strings: string[] };
    expect(contactSql.strings.join(" ")).toContain("reconcile_crm_contact_duplicate_candidates");
  });

  it("accepts a shorter transaction budget for best-effort callers", async () => {
    querySpy.mockResolvedValueOnce([{ acquired: true }]).mockResolvedValueOnce([{
      sources_seen: 0n,
      identities_created: 0n,
      mappings_created: 0n,
      mappings_refreshed: 0n,
      exceptions_opened: 0n,
      exceptions_reopened: 0n,
      exceptions_resolved: 0n,
      duplicate_signals_seen: 0n,
      duplicate_candidates_would_open: 0n,
      duplicate_candidates_would_refresh: 0n,
      duplicate_candidates_would_inactivate: 0n,
    }]).mockResolvedValueOnce([{
      signals_seen: 0n,
      candidates_opened: 0n,
      candidates_refreshed: 0n,
      candidates_inactivated: 0n,
    }]);

    await runCrmIdentityReconciliation(
      "00000000-0000-4000-8000-000000000003",
      true,
      100_000,
    );

    const [, options] = transactionSpy.mock.calls[0] as unknown as [
      unknown,
      { timeout: number; maxWait: number },
    ];
    expect(options).toEqual({ timeout: 100_000, maxWait: 15_000 });
  });

  it("skips immediately when another reconciliation owns the database guard", async () => {
    querySpy.mockResolvedValueOnce([{ acquired: false }]);

    await expect(
      runCrmIdentityReconciliation("00000000-0000-4000-8000-000000000004", false),
    ).rejects.toThrow(CRM_RECONCILIATION_BUSY_ERROR);

    expect(querySpy).toHaveBeenCalledOnce();
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
