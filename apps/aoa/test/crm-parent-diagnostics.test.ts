import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeSpy, querySpy, transactionSpy } = vi.hoisted(() => {
  const execute = vi.fn(async () => 0);
  const query = vi.fn(async () => [{
    result: {
      summary: {
        unresolved_records: 57,
        would_open: 57,
        would_reopen: 0,
        already_open: 0,
        would_resolve: 0,
        no_parent_key_records: 1,
        distinct_unresolved_household_keys: 2,
        distinct_unresolved_contact_keys: 0,
        source_key: "001SHOULDNEVERLEAVE",
      },
      by_source: [{
        identity_type: "EMAIL",
        source_system: "CRM",
        source_namespace: "email",
        exception_action: "WOULD_OPEN",
        parent_issue: "HOUSEHOLD_PARENT_UNRESOLVED",
        records: 43,
        distinct_household_keys: 2,
        distinct_contact_keys: 0,
        source_key: "001SHOULDNEVERLEAVE",
      }],
      household_key_findings: [{
        exception_action: "WOULD_OPEN",
        finding: "VALID_ACCOUNT_KEY_ABSENT",
        records: 56,
        distinct_keys: 2,
        source_key: "001SHOULDNEVERLEAVE",
      }],
      contact_key_findings: [],
      freshness: [{
        exception_action: "WOULD_OPEN",
        freshness: "LAST_24_HOURS",
        records: 57,
      }],
      household_cross_domain: [{
        exception_action: "WOULD_OPEN",
        coverage: "EMAIL_AND_ACTIVITY",
        records: 56,
        distinct_keys: 2,
      }],
      orphan_classification: [{
        parent_type: "HOUSEHOLD",
        classification: "MERGED_TO_ACTIVE_PARENT",
        exception_action: "WOULD_OPEN",
        freshness: "LAST_24_HOURS",
        records: 12,
        distinct_keys: 1,
        source_key: "001SHOULDNEVERLEAVE",
        replacement_key: "001REPLACEMENTNEVERLEAVES",
      }],
      source_key: "001SHOULDNEVERLEAVE",
    },
  }]);
  const transaction = vi.fn(async (
    callback: (tx: { $executeRaw: typeof execute; $queryRaw: typeof query }) => unknown,
  ) => callback({ $executeRaw: execute, $queryRaw: query }));
  return { executeSpy: execute, querySpy: query, transactionSpy: transaction };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/crm/reconciler-db", () => ({
  crmReconcilerClient: () => ({ $transaction: transactionSpy }),
}));

import {
  CRM_PARENT_DIAGNOSTICS_TIMEOUT_MS,
  runCrmMissingParentDiagnostics,
} from "@/lib/crm/parent-diagnostics";

describe("CRM missing-parent diagnostics", () => {
  beforeEach(() => {
    executeSpy.mockClear();
    querySpy.mockClear();
    transactionSpy.mockClear();
  });

  it("runs in a bounded read-only transaction and returns aggregate dimensions", async () => {
    const result = await runCrmMissingParentDiagnostics();

    expect(result.summary).toEqual({
      unresolved_records: 57,
      would_open: 57,
      would_reopen: 0,
      already_open: 0,
      would_resolve: 0,
      no_parent_key_records: 1,
      distinct_unresolved_household_keys: 2,
      distinct_unresolved_contact_keys: 0,
    });
    expect(result.by_source).toEqual([{
      identity_type: "EMAIL",
      source_system: "CRM",
      source_namespace: "email",
      exception_action: "WOULD_OPEN",
      parent_issue: "HOUSEHOLD_PARENT_UNRESOLVED",
      records: 43,
      distinct_household_keys: 2,
      distinct_contact_keys: 0,
    }]);
    expect(result.household_key_findings[0]).toEqual({
      exception_action: "WOULD_OPEN",
      finding: "VALID_ACCOUNT_KEY_ABSENT",
      records: 56,
      distinct_keys: 2,
    });
    expect(result.orphan_classification).toEqual([{
      parent_type: "HOUSEHOLD",
      classification: "MERGED_TO_ACTIVE_PARENT",
      exception_action: "WOULD_OPEN",
      freshness: "LAST_24_HOURS",
      records: 12,
      distinct_keys: 1,
    }]);
    expect(JSON.stringify(result)).not.toContain("001SHOULDNEVERLEAVE");
    expect(JSON.stringify(result)).not.toContain("001REPLACEMENTNEVERLEAVES");

    expect(executeSpy).toHaveBeenCalledOnce();
    expect(querySpy).toHaveBeenCalledOnce();
    expect(transactionSpy).toHaveBeenCalledOnce();
    const [, options] = transactionSpy.mock.calls[0] as unknown as [
      unknown,
      { timeout: number; maxWait: number },
    ];
    expect(CRM_PARENT_DIAGNOSTICS_TIMEOUT_MS).toBe(240_000);
    expect(options).toEqual({ timeout: 240_000, maxWait: 15_000 });
  });

  it("fails closed when a count is invalid instead of returning unreviewed data", async () => {
    querySpy.mockResolvedValueOnce([{
      result: {
        summary: {
          unresolved_records: "57" as unknown as number,
          would_open: 57,
          would_reopen: 0,
          already_open: 0,
          would_resolve: 0,
          no_parent_key_records: 1,
          distinct_unresolved_household_keys: 2,
          distinct_unresolved_contact_keys: 0,
          source_key: "001SHOULDNEVERLEAVE",
        },
        by_source: [],
        household_key_findings: [],
        contact_key_findings: [],
        freshness: [],
        household_cross_domain: [],
        orphan_classification: [],
        source_key: "001SHOULDNEVERLEAVE",
      },
    }]);

    await expect(runCrmMissingParentDiagnostics()).rejects.toThrow(
      "crm_parent_diagnostics_invalid_unresolved_records",
    );
  });
});
