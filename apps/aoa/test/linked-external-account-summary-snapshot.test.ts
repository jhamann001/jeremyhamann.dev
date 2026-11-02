import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { validateLinkedExternalSummarySnapshot } from "@/lib/data/linked-external-account-summary-snapshot";

const goodRow = {
  external_account_id: "ext-1",
  client_sf_id: "TPLAIDCLA000001",
  household_sf_id: "TPLAIDHHA000001",
  institution_name: "Bank A",
  account_subtype: "brokerage",
  mask: "2222",
  cash_amount: 1,
  securities_amount: 2,
  holdings_total: 3,
  institution_balance: 3,
  as_of: "2026-01-15T00:00:00.000Z",
  link_status: "ACTIVE",
  lineage_key: "lineage-1",
  prior_external_account_id: "TEST-PLAID-EXT-OLD",
};

describe("validateLinkedExternalSummarySnapshot", () => {
  it("accepts an active row and keeps lineage", () => {
    const result = validateLinkedExternalSummarySnapshot([goodRow]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0].externalAccountId).toBe("ext-1");
      expect(result.rows[0].linkStatus).toBe("ACTIVE");
      expect(result.rows[0].priorExternalAccountId).toBe("TEST-PLAID-EXT-OLD");
      expect(result.rows[0].asOf.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    }
  });

  it("rejects an inactive link", () => {
    const result = validateLinkedExternalSummarySnapshot([
      { ...goodRow, link_status: "DEACTIVATED" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ index: 0, reason: "inactive_link" }]);
    }
  });

  it("rejects a row missing as_of", () => {
    const result = validateLinkedExternalSummarySnapshot([
      { ...goodRow, as_of: null },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ index: 0, reason: "missing_as_of" }]);
    }
  });

  it("skips an active depository link with no as_of and no amounts", () => {
    const depository = {
      ...goodRow,
      external_account_id: "ext-2",
      account_subtype: "checking",
      cash_amount: null,
      securities_amount: null,
      holdings_total: null,
      institution_balance: null,
      as_of: null,
    };
    const result = validateLinkedExternalSummarySnapshot([goodRow, depository]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows.map((row) => row.externalAccountId)).toEqual(["ext-1"]);
      expect(result.skipped).toBe(1);
    }
  });

  it("still rejects a row with an amount but no as_of", () => {
    const result = validateLinkedExternalSummarySnapshot([
      { ...goodRow, cash_amount: null, securities_amount: null, holdings_total: null, as_of: null },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ index: 0, reason: "missing_as_of" }]);
    }
  });
});
