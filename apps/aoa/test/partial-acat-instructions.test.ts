import { describe, expect, it } from "vitest";
import { partialAcatInstructionsChanged } from "@/lib/data/transfer-plan-approval";

const mapped = (positions: unknown[], sourceAccountFingerprint = "a".repeat(64)) => ({
  source: "asset-map", assetMap: { sourceAccountFingerprint, statementDate: "2026-09-20" }, positions,
});
const mappedRows = [
  { symbol: "TEST-A", isTransferring: true, marketValue: 100, costBasis: 90 },
  { symbol: "TEST-B", isTransferring: false, marketValue: 200, costBasis: 180 },
];
const basis = (positions: unknown[]) => ({ source: "transfer-decisions", positions });
const basisRows = [
  { decisionId: "a", symbol: "TEST-A", decision: "BRING_IN", value: 100 },
  { decisionId: "b", symbol: "TEST-B", decision: "LEAVE_GIFT", value: 200 },
];

describe("approved partial-ACAT instructions", () => {
  it("preserves work across order, valuation, descriptive and statement-date changes", () => {
    const revised = {
      ...mapped([...mappedRows].reverse().map((row) => ({ ...row, marketValue: 999, costBasis: 10, description: "New display text" }))),
      assetMap: { sourceAccountFingerprint: "a".repeat(64), statementDate: "2026-09-24" },
    };
    expect(partialAcatInstructionsChanged(mapped(mappedRows), revised)).toBe(false);
    expect(partialAcatInstructionsChanged(basis(basisRows), basis([...basisRows].reverse().map((row) => ({ ...row, value: 999 }))))).toBe(false);
  });

  it.each([
    ["selection", mapped([mappedRows[0], { ...mappedRows[1], isTransferring: true }])],
    ["added excluded security", mapped([...mappedRows, { symbol: "TEST-C", isTransferring: false }])],
    ["removed excluded security", mapped([mappedRows[0]])],
    ["source account", mapped(mappedRows, "b".repeat(64))],
    ["source mode", basis(basisRows)],
  ])("reopens work after changed %s", (_label, revised) => {
    expect(partialAcatInstructionsChanged(mapped(mappedRows), revised)).toBe(true);
  });

  it.each([
    ["instruction", [basisRows[0], { ...basisRows[1], decision: "BRING_IN" }]],
    ["security", [basisRows[0], { ...basisRows[1], symbol: "TEST-C" }]],
    ["row identity", [basisRows[0], { ...basisRows[1], decisionId: "c" }]],
  ])("reopens work after a basis %s changes", (_label, rows) => {
    expect(partialAcatInstructionsChanged(basis(basisRows), basis(rows))).toBe(true);
  });

  it.each([
    null,
    {},
    { source: "asset-map", positions: mappedRows, assetMap: { accountLast4: "1234" } },
    mapped([]),
    mapped([{ symbol: "TEST-A", isTransferring: "true" }]),
    mapped([mappedRows[0], mappedRows[0]]),
    mapped([{ ...mappedRows[0], isTransferring: false }]),
    mapped(mappedRows, "not-a-source-binding"),
    basis([{ ...basisRows[0], decision: "UNDECIDED" }]),
    basis([basisRows[0], basisRows[0]]),
  ])("requires review when historical instructions cannot establish equivalence: %j", (previous) => {
    expect(partialAcatInstructionsChanged(previous, mapped(mappedRows))).toBe(true);
  });
});
