import { describe, expect, it } from "vitest";
import {
  EMPTY_PREVIEW_MESSAGE,
  INCOMPLETE_PREVIEW_MESSAGE,
  MISSING_AS_OF_MESSAGE,
  accountLabel,
  accountMatchesTransfer,
  holdingEligible,
  isCashHolding,
  mappingFinding,
  previewIssue,
  reasonPhrase,
  type LinkedHoldingRow,
} from "@/lib/transfers/linked-holdings";

const row = (over: Partial<LinkedHoldingRow> = {}): LinkedHoldingRow => ({
  symbol: "VTI", name: "Vanguard Total Stock Market ETF", quantity: 10, value: 2500,
  label: "likely_transferable", reason: "standard_security", ...over,
});
const AS_OF = "2026-10-20";

describe("linked holding findings", () => {
  it("treats cash lines as cash regardless of label", () => {
    expect(isCashHolding({ symbol: "CUR:USD", reason: "unknown" })).toBe(true);
    expect(isCashHolding({ symbol: "cash", reason: "x" })).toBe(true);
    expect(isCashHolding({ symbol: "VTI", reason: "cash" })).toBe(true);
    expect(isCashHolding({ symbol: "VTI", reason: "standard_security" })).toBe(false);
  });

  it("only the transferable label or cash is eligible; unknown never establishes eligibility", () => {
    expect(holdingEligible(row())).toBe(true);
    expect(holdingEligible(row({ label: "unknown", reason: "rules_unavailable" }))).toBe(false);
    expect(holdingEligible(row({ label: undefined, reason: undefined }))).toBe(false);
    expect(holdingEligible(row({ label: "likely_not", reason: "fixed_income" }))).toBe(false);
    expect(holdingEligible(row({ symbol: "CUR:USD", label: "unknown", reason: "cash" }))).toBe(true);
  });

  it("maps findings the way the mockup words them", () => {
    expect(mappingFinding(row())).toBe("Eligible for in-kind ACAT");
    expect(mappingFinding(row({ symbol: "CUR:USD", reason: "cash" }))).toBe("Cash balance");
    expect(mappingFinding(row({ label: "likely_not" }))).toBe("Needs a separate route / review");
  });

  it("phrases known reasons and falls back to Needs review", () => {
    expect(reasonPhrase("omni")).toBe("Omni mutual fund");
    expect(reasonPhrase("made_up")).toBe("Needs review");
    expect(reasonPhrase(undefined)).toBe("Needs review");
  });
});

describe("previewIssue", () => {
  it("flags empty, incomplete and undated previews", () => {
    expect(previewIssue([], AS_OF)).toBe(EMPTY_PREVIEW_MESSAGE);
    expect(previewIssue([row({ quantity: null })], AS_OF)).toBe(INCOMPLETE_PREVIEW_MESSAGE);
    expect(previewIssue([row({ symbol: " " })], AS_OF)).toBe(INCOMPLETE_PREVIEW_MESSAGE);
    expect(previewIssue([row()], null)).toBe(MISSING_AS_OF_MESSAGE);
    expect(previewIssue([row()], "not a date")).toBe(MISSING_AS_OF_MESSAGE);
  });

  it("accepts a complete dated preview", () => {
    expect(previewIssue([row(), row({ symbol: "CUR:USD", reason: "cash" })], AS_OF)).toBeNull();
  });
});

describe("account matching", () => {
  it("matches on the last four alphanumerics only", () => {
    expect(accountMatchesTransfer("4821", "4821")).toBe(true);
    expect(accountMatchesTransfer("x-4821", "AB4821")).toBe(true);
    expect(accountMatchesTransfer("4821", "4822")).toBe(false);
    expect(accountMatchesTransfer(null, "4821")).toBe(false);
    expect(accountMatchesTransfer("4821", null)).toBe(false);
    expect(accountMatchesTransfer("21", "21")).toBe(false);
  });

  it("labels an account with client, institution, type and mask", () => {
    expect(accountLabel({ clientName: "Avery Stone", institution: "Fidelity", accountType: "IRA", mask: "4821" }))
      .toBe("Avery Stone · Fidelity · IRA •••• 4821");
    expect(accountLabel({ clientName: "Avery Stone", institution: "Fidelity", accountType: "IRA", mask: null }))
      .toBe("Avery Stone · Fidelity · IRA");
  });
});
