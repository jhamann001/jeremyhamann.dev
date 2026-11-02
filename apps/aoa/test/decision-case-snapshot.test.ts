import { describe, expect, it } from "vitest";
import { mapDecisionCaseSourceSnapshot } from "@/lib/data/decision-cases";

describe("decision case source snapshots", () => {
  it("keeps rich asset context for the Decision Center", () => {
    expect(mapDecisionCaseSourceSnapshot({
      fundingPlanVersion: 2,
      included: ["VTI"],
      excluded: ["XYZIX"],
      includedCount: 1,
      excludedCount: 1,
      positions: [
        {
          symbol: "XYZIX",
          description: "Legacy mutual fund",
          marketValue: 15_000,
          costBasis: 9_000,
          ineligible: true,
          isTransferring: false,
        },
      ],
    })).toMatchObject({
      fundingPlanVersion: 2,
      excludedCount: 1,
      positions: [
        {
          symbol: "XYZIX",
          description: "Legacy mutual fund",
          marketValue: 15_000,
          costBasis: 9_000,
          ineligible: true,
          isTransferring: false,
        },
        {
          symbol: "VTI",
          description: null,
          marketValue: null,
          costBasis: null,
          ineligible: null,
          isTransferring: true,
        },
      ],
    });
  });

  it("backfills symbol-only rows from decisions saved before rich snapshots", () => {
    expect(mapDecisionCaseSourceSnapshot({
      included: ["VTI"],
      excluded: ["DEVNX"],
      includedCount: 1,
      excludedCount: 1,
    }).positions).toEqual([
      {
        symbol: "VTI",
        description: null,
        marketValue: null,
        costBasis: null,
        ineligible: null,
        isTransferring: true,
      },
      {
        symbol: "DEVNX",
        description: null,
        marketValue: null,
        costBasis: null,
        ineligible: null,
        isTransferring: false,
      },
    ]);
  });
});
