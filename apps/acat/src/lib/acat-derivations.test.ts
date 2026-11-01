import { describe, it, expect } from "vitest";
import {
  AGING_HIGH_MULTIPLIER,
  AGING_WARN_MULTIPLIER,
  DEFAULT_PROCESSING_DAYS,
  classifyAsset,
  getAgingTier,
  getAssetCounts,
  getDaysOpen,
  getExpectedCompletionDate,
  getExpectedProcessingDays,
  getIssueCount,
  getReconRate,
  getReconStatus,
  hasApexUpload,
  hasGcpPositions,
  hasIssues,
  isAging,
  needsFeeSubmission,
  needsTradeInstructions,
  RECON_AUTO_COMPLETE_THRESHOLD,
  shouldAutoCompleteRecon,
  sumStatementAmount,
} from "./acat-derivations";
import { AcatRecord, AcatStatus, Asset, Custodian } from "./types";

function makeAsset(overrides: Partial<Asset>): Asset {
  return {
    id: "a1",
    symbol: "AAPL",
    description: "Apple Inc.",
    expectedQty: 100,
    actualQty: 100,
    mapStatus: "Mapped",
    ...overrides,
  };
}

function makeRecord(overrides: Partial<AcatRecord>): AcatRecord {
  return {
    id: "REC",
    clientName: "Test",
    status: "PendingReview",
    apexAccountId: "BLU",
    lastUpdated: "2026-04-10T00:00:00Z",
    crmDealId: "",
    custodianId: "",
    custodianName: "",
    acatDate: "2026-04-01",
    slackAlerted: false,
    mappingSource: "",
    apexSource: "",
    assets: [],
    ...overrides,
  };
}

describe("classifyAsset", () => {
  it("is matched when mapStatus is Mapped", () => {
    expect(
      classifyAsset(
        makeAsset({ expectedQty: 10, actualQty: 10, mapStatus: "Mapped" }),
        "PendingReview"
      )
    ).toBe("matched");
  });

  it("is matched for a Apex surplus saved as Mapped (actual > expected)", () => {
    // Regression: the recon engine collapses surpluses onto Mapped. If
    // classifyAsset reverted to a qty-delta heuristic this case would
    // wrongly flip back to mismatch and re-light the red Issues bubble
    // on the Records row after a clean save.
    expect(
      classifyAsset(
        makeAsset({ expectedQty: 100, actualQty: 112, mapStatus: "Mapped" }),
        "PendingReview"
      )
    ).toBe("matched");
  });

  it("is pending when mapStatus is Pending", () => {
    expect(
      classifyAsset(
        makeAsset({ expectedQty: 10, actualQty: 0, mapStatus: "Pending" }),
        "Submitted"
      )
    ).toBe("pending");
  });

  it("is mismatch when mapStatus is Unmapped", () => {
    expect(
      classifyAsset(
        makeAsset({ expectedQty: 10, actualQty: 0, mapStatus: "Unmapped" }),
        "PendingReview"
      )
    ).toBe("mismatch");
  });

  it("is ignored for 0=0 placeholder assets regardless of mapStatus", () => {
    expect(
      classifyAsset(
        makeAsset({ expectedQty: 0, actualQty: 0, mapStatus: "Mapped" }),
        "Completed"
      )
    ).toBe("ignored");
    expect(
      classifyAsset(
        makeAsset({ expectedQty: 0, actualQty: 0, mapStatus: "Unmapped" }),
        "Completed"
      )
    ).toBe("ignored");
  });

  it("is ignored for assets on a Rejected/Canceled/Purged/Deferred ACAT", () => {
    const deadEnds: AcatStatus[] = ["Rejected", "Canceled", "Purged", "Deferred"];
    for (const status of deadEnds) {
      expect(
        classifyAsset(
          makeAsset({ expectedQty: 10, actualQty: 0, mapStatus: "Unmapped" }),
          status
        )
      ).toBe("ignored");
    }
  });
});

describe("getAssetCounts", () => {
  it("buckets assets across matched / pending / mismatch by mapStatus", () => {
    const r = makeRecord({
      status: "PendingReview" satisfies AcatStatus,
      assets: [
        makeAsset({ id: "1", mapStatus: "Mapped" }),
        makeAsset({ id: "2", mapStatus: "Pending" }),
        makeAsset({ id: "3", mapStatus: "Unmapped" }),
      ],
    });
    expect(getAssetCounts(r)).toEqual({ matched: 1, pending: 1, mismatch: 1 });
  });

  it("counts Unmapped assets as mismatch regardless of ACAT status", () => {
    const r = makeRecord({
      status: "Completed" satisfies AcatStatus,
      assets: [makeAsset({ expectedQty: 10, actualQty: 0, mapStatus: "Unmapped" })],
    });
    expect(getAssetCounts(r)).toEqual({ matched: 0, pending: 0, mismatch: 1 });
  });

  it("counts Pending assets as pending even on a settled record", () => {
    // Option A: we trust the recon tab's persisted decision. A Pending
    // asset on a Completed record means the user hasn't reconciled it
    // yet — that's a queue problem, not a reconciliation mismatch.
    const r = makeRecord({
      status: "Completed" satisfies AcatStatus,
      assets: [makeAsset({ expectedQty: 10, actualQty: 0, mapStatus: "Pending" })],
    });
    expect(getAssetCounts(r)).toEqual({ matched: 0, pending: 1, mismatch: 0 });
  });

  it("drops 0=0 placeholder assets from every bucket", () => {
    const r = makeRecord({
      status: "Completed" satisfies AcatStatus,
      assets: [
        makeAsset({ id: "1", expectedQty: 0, actualQty: 0, mapStatus: "Pending" }),
        makeAsset({ id: "2", expectedQty: 10, actualQty: 10, mapStatus: "Mapped" }),
      ],
    });
    expect(getAssetCounts(r)).toEqual({ matched: 1, pending: 0, mismatch: 0 });
  });

  it("drops every asset on a dead-end ACAT (Rejected)", () => {
    const r = makeRecord({
      status: "Rejected" satisfies AcatStatus,
      assets: [
        makeAsset({ id: "1", mapStatus: "Unmapped" }),
        makeAsset({ id: "2", mapStatus: "Mapped" }),
      ],
    });
    expect(getAssetCounts(r)).toEqual({ matched: 0, pending: 0, mismatch: 0 });
  });
});

describe("getIssueCount", () => {
  it("returns 0 when every asset is Mapped", () => {
    const r = makeRecord({
      assets: [makeAsset({ mapStatus: "Mapped" })],
    });
    expect(getIssueCount(r)).toBe(0);
  });

  it("counts Unmapped assets as issues", () => {
    const r = makeRecord({
      assets: [
        makeAsset({ id: "1", mapStatus: "Mapped" }),
        makeAsset({ id: "2", mapStatus: "Unmapped" }),
      ],
    });
    expect(getIssueCount(r)).toBe(1);
  });

  it("does NOT count Pending assets as issues", () => {
    const r = makeRecord({
      status: "PendingReview" satisfies AcatStatus,
      assets: [makeAsset({ mapStatus: "Pending" })],
    });
    expect(getIssueCount(r)).toBe(0);
  });

  it("does NOT count a Mapped surplus as an issue (post-save regression)", () => {
    // After `SecurityReconTab.saveReconResults` writes `mapStatus: Mapped`
    // for a Apex surplus, the records row must show 0 issues.
    const r = makeRecord({
      assets: [
        makeAsset({ expectedQty: 100, actualQty: 112, mapStatus: "Mapped" }),
      ],
    });
    expect(getIssueCount(r)).toBe(0);
  });

  it("returns 0 for records with no assets", () => {
    expect(getIssueCount(makeRecord({ assets: [] }))).toBe(0);
  });
});

describe("hasIssues", () => {
  it("returns true when there is at least one Unmapped asset", () => {
    const r = makeRecord({
      assets: [makeAsset({ mapStatus: "Unmapped" })],
    });
    expect(hasIssues(r)).toBe(true);
  });

  it("returns false when all Mapped", () => {
    const r = makeRecord({
      assets: [makeAsset({ mapStatus: "Mapped" })],
    });
    expect(hasIssues(r)).toBe(false);
  });

  it("returns false for Pending assets (awaiting reconciliation)", () => {
    const r = makeRecord({
      status: "Submitted" satisfies AcatStatus,
      assets: [makeAsset({ mapStatus: "Pending" })],
    });
    expect(hasIssues(r)).toBe(false);
  });
});

describe("needsFeeSubmission", () => {
  it("returns true when a fee was charged but the request isn't completed", () => {
    const r = makeRecord({ feeCharged: "Yes", feeRequestCompleted: "" });
    expect(needsFeeSubmission(r)).toBe(true);
  });

  it("returns true when feeRequestCompleted is undefined", () => {
    const r = makeRecord({ feeCharged: "Yes" });
    expect(needsFeeSubmission(r)).toBe(true);
  });

  it("returns false once the request has been completed", () => {
    const r = makeRecord({
      feeCharged: "Yes",
      feeRequestCompleted: "2026-05-01",
    });
    expect(needsFeeSubmission(r)).toBe(false);
  });

  it("returns false when no fee was charged", () => {
    const r = makeRecord({ feeCharged: "No", feeRequestCompleted: "" });
    expect(needsFeeSubmission(r)).toBe(false);
  });

  it("matches feeCharged case-insensitively", () => {
    const r = makeRecord({ feeCharged: "yes", feeRequestCompleted: "" });
    expect(needsFeeSubmission(r)).toBe(true);
  });

  it("excludes residual-credit records even when a fee is charged", () => {
    const r = makeRecord({
      type: "Residual Credit",
      feeCharged: "Yes",
      feeRequestCompleted: "",
    });
    expect(needsFeeSubmission(r)).toBe(false);
  });

  it("queues a full ACAT Out even when historical feeCharged data is blank", () => {
    const r = makeRecord({ direction: "Out", type: "Full", feeCharged: "" });
    expect(needsFeeSubmission(r)).toBe(true);
  });

  it.each(["", "No"])("does not assume a full outgoing DRS fee when the answer is %s", (feeCharged) => {
    expect(needsFeeSubmission(makeRecord({
      direction: "Out",
      type: "Full",
      transferWorkflow: "DRS",
      feeCharged,
    }))).toBe(false);
  });

  it("still queues an explicitly recorded DRS fee", () => {
    expect(needsFeeSubmission(makeRecord({
      direction: "Out",
      type: "Full",
      transferWorkflow: "DRS",
      feeCharged: "Yes",
    }))).toBe(true);
  });

  it("excludes rejected and purged transfers from the fee queue", () => {
    expect(needsFeeSubmission(makeRecord({ status: "Rejected", feeCharged: "Yes" }))).toBe(false);
    expect(needsFeeSubmission(makeRecord({
      status: "Purged",
      direction: "Out",
      type: "Full",
      feeCharged: "",
    }))).toBe(false);
  });
});

describe("needsTradeInstructions", () => {
  it("flags blank instructions for full and partial transfers", () => {
    expect(needsTradeInstructions(makeRecord({ type: "Full", tradeInstructions: "" }))).toBe(true);
    expect(needsTradeInstructions(makeRecord({ type: "Partial" }))).toBe(true);
  });

  it("does not flag populated, residual, or dead-end transfers", () => {
    expect(needsTradeInstructions(makeRecord({ type: "Full", tradeInstructions: "Sell all" }))).toBe(false);
    expect(needsTradeInstructions(makeRecord({ type: "Residual Credit" }))).toBe(false);
    expect(needsTradeInstructions(makeRecord({ type: "Full", status: "Rejected" }))).toBe(false);
  });
});

describe("getDaysOpen", () => {
  const now = new Date("2026-04-15T00:00:00Z").getTime();

  it("uses originalClientRequestDate when present", () => {
    const r = makeRecord({
      originalClientRequestDate: "2026-04-10",
      acatDate: "2026-04-01",
    });
    expect(getDaysOpen(r, now)).toBe(5);
  });

  it("falls back to acatDate when originalClientRequestDate is missing", () => {
    const r = makeRecord({ acatDate: "2026-04-01" });
    expect(getDaysOpen(r, now)).toBe(14);
  });

  it("returns 0 for future dates, never negative", () => {
    const r = makeRecord({ acatDate: "2026-04-20" });
    expect(getDaysOpen(r, now)).toBe(0);
  });

  it("returns 0 when date is unparseable", () => {
    const r = makeRecord({ acatDate: "not-a-date" });
    expect(getDaysOpen(r, now)).toBe(0);
  });
});

describe("sumStatementAmount", () => {
  it("sums statementAmount (cents) across records", () => {
    const records = [
      makeRecord({ statementAmount: 100 }),
      makeRecord({ statementAmount: 250 }),
      makeRecord({ statementAmount: undefined }),
    ];
    expect(sumStatementAmount(records)).toBe(350);
  });

  it("returns 0 for empty input", () => {
    expect(sumStatementAmount([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ticket: Recon auto-complete helpers. The rule from the ticket:
//   - After positions pull (mappingSource = "GCP Project API") AND apex
//     file is uploaded (apexSource = "Uploaded"), evaluate recon rate.
//   - >= 90% matched → mark the recon (not the ACAT) as complete.
//   - <  90%         → flag "needs review".
//   - Either signal missing → "pending".
// ---------------------------------------------------------------------------

describe("hasGcpPositions", () => {
  it("returns true for default GCP Project API source", () => {
    expect(hasGcpPositions(makeRecord({ mappingSource: "GCP Project API" }))).toBe(true);
  });

  it("returns true for Mock / Local Fixture so demo data behaves like real data", () => {
    expect(hasGcpPositions(makeRecord({ mappingSource: "Mock / Local Fixture" }))).toBe(true);
  });

  it("returns false for empty/unknown mapping sources", () => {
    expect(hasGcpPositions(makeRecord({ mappingSource: "" }))).toBe(false);
    expect(hasGcpPositions(makeRecord({ mappingSource: "Manual Entry" }))).toBe(false);
  });
});

describe("hasApexUpload", () => {
  it("returns true when apexSource is Uploaded", () => {
    expect(hasApexUpload(makeRecord({ apexSource: "Uploaded" }))).toBe(true);
  });

  it("returns false for the Pending Upload default", () => {
    expect(hasApexUpload(makeRecord({ apexSource: "Pending Upload" }))).toBe(false);
  });
});

describe("getReconRate", () => {
  it("returns 0 when there are no non-ignored assets", () => {
    expect(getReconRate(makeRecord({ assets: [] }))).toBe(0);
  });

  it("returns matched / (matched + mismatch + pending)", () => {
    const r = makeRecord({
      status: "PendingReview",
      assets: [
        makeAsset({ id: "1", mapStatus: "Mapped" }),
        makeAsset({ id: "2", mapStatus: "Mapped" }),
        makeAsset({ id: "3", mapStatus: "Mapped" }),
        makeAsset({ id: "4", mapStatus: "Unmapped" }),
      ],
    });
    expect(getReconRate(r)).toBeCloseTo(0.75, 5);
  });

  it("ignores 0=0 placeholder rows", () => {
    const r = makeRecord({
      status: "PendingReview",
      assets: [
        makeAsset({ id: "1", expectedQty: 0, actualQty: 0, mapStatus: "Pending" }),
        makeAsset({ id: "2", mapStatus: "Mapped" }),
      ],
    });
    expect(getReconRate(r)).toBe(1);
  });
});

describe("getReconStatus", () => {
  function reconRecord(overrides: Partial<AcatRecord> = {}): AcatRecord {
    return makeRecord({
      status: "PendingReview",
      mappingSource: "GCP Project API",
      apexSource: "Uploaded",
      ...overrides,
    });
  }

  it("returns 'complete' when reconCompletedAt is already stamped", () => {
    const r = reconRecord({
      reconCompletedAt: "2026-04-12T00:00:00Z",
      // Even with zero matched assets, an explicit stamp wins so manual
      // overrides aren't second-guessed.
      assets: [makeAsset({ mapStatus: "Unmapped" })],
    });
    expect(getReconStatus(r)).toBe("complete");
  });

  it("returns 'pending' when GCP positions are missing", () => {
    const r = reconRecord({
      mappingSource: "Manual Entry",
      assets: [makeAsset({ mapStatus: "Mapped" })],
    });
    expect(getReconStatus(r)).toBe("pending");
  });

  it("returns 'pending' when the Apex upload is still missing", () => {
    const r = reconRecord({
      apexSource: "Pending Upload",
      assets: [makeAsset({ mapStatus: "Mapped" })],
    });
    expect(getReconStatus(r)).toBe("pending");
  });

  it("returns 'complete' when both sources are in and rate >= 90%", () => {
    // 9 matched out of 10 = 0.9, exactly at the threshold.
    const matched = Array.from({ length: 9 }, (_, i) =>
      makeAsset({ id: `m${i}`, mapStatus: "Mapped" })
    );
    const r = reconRecord({
      assets: [...matched, makeAsset({ id: "u", mapStatus: "Unmapped" })],
    });
    expect(getReconRate(r)).toBeCloseTo(RECON_AUTO_COMPLETE_THRESHOLD, 5);
    expect(getReconStatus(r)).toBe("complete");
  });

  it("returns 'needs_review' when both sources are in but rate < 90%", () => {
    // 8 matched out of 10 = 0.8.
    const matched = Array.from({ length: 8 }, (_, i) =>
      makeAsset({ id: `m${i}`, mapStatus: "Mapped" })
    );
    const unmapped = Array.from({ length: 2 }, (_, i) =>
      makeAsset({ id: `u${i}`, mapStatus: "Unmapped" })
    );
    const r = reconRecord({ assets: [...matched, ...unmapped] });
    expect(getReconStatus(r)).toBe("needs_review");
  });
});

describe("shouldAutoCompleteRecon", () => {
  function reconReady(overrides: Partial<AcatRecord> = {}): AcatRecord {
    return makeRecord({
      status: "PendingReview",
      mappingSource: "GCP Project API",
      apexSource: "Uploaded",
      assets: [
        ...Array.from({ length: 9 }, (_, i) =>
          makeAsset({ id: `m${i}`, mapStatus: "Mapped" })
        ),
        makeAsset({ id: "u", mapStatus: "Unmapped" }),
      ],
      ...overrides,
    });
  }

  it("is true when all three conditions are met and not yet stamped", () => {
    expect(shouldAutoCompleteRecon(reconReady())).toBe(true);
  });

  it("is false when reconCompletedAt is already set (don't double-stamp)", () => {
    expect(
      shouldAutoCompleteRecon(reconReady({ reconCompletedAt: "2026-04-12T00:00:00Z" }))
    ).toBe(false);
  });

  it("is false when GCP positions are missing", () => {
    expect(
      shouldAutoCompleteRecon(reconReady({ mappingSource: "Manual Entry" }))
    ).toBe(false);
  });

  it("is false when Apex upload is missing", () => {
    expect(
      shouldAutoCompleteRecon(reconReady({ apexSource: "Pending Upload" }))
    ).toBe(false);
  });

  it("is false when rate is just below 90%", () => {
    // 8 matched of 10 = 0.8.
    const matched = Array.from({ length: 8 }, (_, i) =>
      makeAsset({ id: `m${i}`, mapStatus: "Mapped" })
    );
    const unmapped = Array.from({ length: 2 }, (_, i) =>
      makeAsset({ id: `u${i}`, mapStatus: "Unmapped" })
    );
    expect(
      shouldAutoCompleteRecon(reconReady({ assets: [...matched, ...unmapped] }))
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ticket / ticket: per-custodian aging + expected completion
// ---------------------------------------------------------------------------

function makeCustodian(overrides: Partial<Custodian> = {}): Custodian {
  return {
    id: "CUST-LKS",
    name: "Fidelity",
    acatFeeAmount: 0,
    avgProcessingDays: 5,
    ...overrides,
  };
}

describe("getExpectedProcessingDays", () => {
  it("returns the linked custodian's avgProcessingDays", () => {
    const r = makeRecord({ custodian: makeCustodian({ avgProcessingDays: 8 }) });
    expect(getExpectedProcessingDays(r)).toBe(8);
  });

  it("falls back to DEFAULT_PROCESSING_DAYS when no custodian is linked", () => {
    const r = makeRecord({ custodian: null });
    expect(getExpectedProcessingDays(r)).toBe(DEFAULT_PROCESSING_DAYS);
  });

  it("falls back when avgProcessingDays is zero (misconfigured custodian)", () => {
    const r = makeRecord({ custodian: makeCustodian({ avgProcessingDays: 0 }) });
    expect(getExpectedProcessingDays(r)).toBe(DEFAULT_PROCESSING_DAYS);
  });
});

describe("getAgingTier", () => {
  const now = new Date("2026-04-15T00:00:00Z").getTime();

  it("returns 'on-track' when daysOpen is within warn threshold", () => {
    // Fidelity SLA 5d, warn cutoff = 5 * 1.25 = 6.25d. 6 days in → on-track.
    const r = makeRecord({
      status: "Submitted",
      originalClientRequestDate: "2026-04-09",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(getAgingTier(r, now)).toBe("on-track");
  });

  it("returns 'warn' just past the warn threshold", () => {
    // SLA 5d, warn cutoff 6.25d. 7 days in → warn.
    const r = makeRecord({
      status: "Submitted",
      originalClientRequestDate: "2026-04-08",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(getAgingTier(r, now)).toBe("warn");
  });

  it("returns 'high' past the high threshold", () => {
    // SLA 5d, high cutoff 5 * 1.75 = 8.75d. 10 days in → high.
    const r = makeRecord({
      status: "Submitted",
      originalClientRequestDate: "2026-04-05",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(getAgingTier(r, now)).toBe("high");
  });

  it("returns 'none' for terminal records regardless of age", () => {
    const r = makeRecord({
      status: "Completed",
      originalClientRequestDate: "2025-01-01",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(getAgingTier(r, now)).toBe("none");
  });

  it("uses the per-custodian threshold (slow contra forgives more days)", () => {
    // 9 days in. BNY SLA 8d → warn cutoff 10d → still on-track.
    // Fidelity SLA 5d → warn cutoff 6.25d → would be warn/high.
    const slow = makeRecord({
      status: "Submitted",
      originalClientRequestDate: "2026-04-06",
      custodian: makeCustodian({ name: "BNY Investments", avgProcessingDays: 8 }),
    });
    const fast = makeRecord({
      status: "Submitted",
      originalClientRequestDate: "2026-04-06",
      custodian: makeCustodian({ name: "Fidelity", avgProcessingDays: 5 }),
    });
    expect(getAgingTier(slow, now)).toBe("on-track");
    expect(getAgingTier(fast, now)).toBe("high");
  });

  it("falls back to the default SLA when no custodian is linked", () => {
    // Default 7d, warn cutoff 7 * 1.25 = 8.75d. 9 days in → warn.
    const r = makeRecord({
      status: "Submitted",
      originalClientRequestDate: "2026-04-06",
      custodian: null,
    });
    expect(getAgingTier(r, now)).toBe("warn");
  });

  it("multipliers are conservative (1.25 / 1.75)", () => {
    // Locks the public constants so a future change is intentional.
    expect(AGING_WARN_MULTIPLIER).toBe(1.25);
    expect(AGING_HIGH_MULTIPLIER).toBe(1.75);
  });
});

describe("isAging", () => {
  const now = new Date("2026-04-15T00:00:00Z").getTime();

  it("is true for warn-tier records", () => {
    const r = makeRecord({
      status: "Submitted",
      originalClientRequestDate: "2026-04-08",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(isAging(r, now)).toBe(true);
  });

  it("is true for high-tier records", () => {
    const r = makeRecord({
      status: "Submitted",
      originalClientRequestDate: "2026-04-05",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(isAging(r, now)).toBe(true);
  });

  it("is false for on-track records", () => {
    const r = makeRecord({
      status: "Submitted",
      originalClientRequestDate: "2026-04-12",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(isAging(r, now)).toBe(false);
  });

  it("is false for terminal records", () => {
    const r = makeRecord({
      status: "Completed",
      originalClientRequestDate: "2025-01-01",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(isAging(r, now)).toBe(false);
  });
});

describe("getExpectedCompletionDate", () => {
  it("returns submission date + custodian SLA when both are present", () => {
    const r = makeRecord({
      opsSubmissionDateToApex: "2026-04-01",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(getExpectedCompletionDate(r)).toBe("2026-04-06");
  });

  it("returns null when opsSubmissionDateToApex is missing", () => {
    const r = makeRecord({
      opsSubmissionDateToApex: undefined,
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(getExpectedCompletionDate(r)).toBeNull();
  });

  it("falls back to default SLA when no custodian is linked", () => {
    // Default 7d → 2026-04-01 + 7d = 2026-04-08.
    const r = makeRecord({
      opsSubmissionDateToApex: "2026-04-01",
      custodian: null,
    });
    expect(getExpectedCompletionDate(r)).toBe("2026-04-08");
  });

  it("returns null for an unparseable submission date", () => {
    const r = makeRecord({
      opsSubmissionDateToApex: "not-a-date",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(getExpectedCompletionDate(r)).toBeNull();
  });

  it("still computes for terminal records (caller can compare vs actual)", () => {
    // Useful for a future slippage-vs-expected report; the UI hides the
    // value on terminal rows but the derivation doesn't.
    const r = makeRecord({
      status: "Completed",
      opsSubmissionDateToApex: "2026-04-01",
      custodian: makeCustodian({ avgProcessingDays: 5 }),
    });
    expect(getExpectedCompletionDate(r)).toBe("2026-04-06");
  });
});
