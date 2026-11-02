import { describe, expect, it } from "vitest";
import { validateFundingPlanApproval } from "@/lib/data/transfer-plan-approval";

describe("validateFundingPlanApproval", () => {
  it("requires a funding type", () => {
    const result = validateFundingPlanApproval(
      { baseVersion: 0, fundingType: null, basisDecisions: [], partialPositions: [], note: "" },
      { mode: "none" },
    );
    expect(result.errors).toContainEqual(
      expect.objectContaining({ field: "funding_type" }),
    );
  });

  it("requires an exact, non-empty asset-map selection for a partial ACAT", () => {
    const result = validateFundingPlanApproval(
      {
        fundingType: "ACAT_PARTIAL",
        baseVersion: 0,
        basisDecisions: [],
        partialPositions: [{ symbol: "VTI", isTransferring: false }],
        note: "",
      },
      { mode: "asset-map", symbols: ["VTI"] },
    );
    expect(result.errors[0]?.message).toMatch(/at least one position/i);
  });

  it("rejects unresolved seeded decisions", () => {
    const result = validateFundingPlanApproval(
      {
        fundingType: "ACAT_PARTIAL",
        baseVersion: 0,
        basisDecisions: [{ decisionId: "d1", decision: "UNDECIDED" }],
        partialPositions: [],
        note: "",
      },
      { mode: "basis", decisionIds: ["d1"] },
    );
    expect(result.errors[0]?.message).toMatch(/resolve every position/i);
  });

  it("does not require position choices for a manual transfer", () => {
    const result = validateFundingPlanApproval(
      { baseVersion: 0, fundingType: "MANUAL", basisDecisions: [], partialPositions: [], note: "" },
      { mode: "none" },
    );
    expect(result).toEqual({ ok: true, errors: [] });
  });
});
