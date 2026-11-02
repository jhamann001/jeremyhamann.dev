import { describe, expect, it } from "vitest";
import { feeChargeState, headerBadge, parseFeeAmount, selectedTotals, type FeeRule } from "@/lib/data/acat-fee-view";

describe("stored transfer fee evidence", () => {
  it.each([null, undefined, "", " ", "varies", "$0-$75", "fee $75", "12.3.4", "1,00", "-75"])("keeps an unknown or malformed amount unknown: %s", (value) => {
    expect(parseFeeAmount(value)).toBeNull();
  });

  it.each([["0", 0], ["$0.00", 0], [" $75.00 ", 75], ["$1,234.50", 1234.5]])("reads an explicit amount: %s", (value, expected) => {
    expect(parseFeeAmount(String(value))).toBe(expected);
  });

  it("requires stored evidence and preserves contradictory details for review", () => {
    expect(feeChargeState(null)).toBe("pending");
    expect(feeChargeState({ feeCharged: null, feeAmount: null })).toBe("pending");
    expect(feeChargeState({ feeCharged: "No", feeAmount: null })).toBe("no-fee");
    expect(feeChargeState({ feeCharged: null, feeAmount: "0" })).toBe("no-fee");
    expect(feeChargeState({ feeCharged: "Yes", feeAmount: null })).toBe("charged");
    expect(feeChargeState({ feeCharged: "No", feeAmount: "75" })).toBe("review");
    expect(feeChargeState({ feeCharged: "Yes", feeAmount: "0" })).toBe("review");
    expect(headerBadge({ state: "no-fee", unavailable: true }).label).toBe("Unavailable");
  });

  it("does not manufacture a definitive amount or charged flag from variable rules", () => {
    const rule: FeeRule = { id: "fee-1", feeType: "ACAT", accountType: "ANY", transferType: "ANY", direction: "ANY", amount: null, amountText: "varies", notes: null };
    for (const candidate of [rule, { ...rule, amount: 75, amountText: "per position" }]) {
      expect(selectedTotals([candidate], new Set([candidate.id]))).toMatchObject({
        requiresAmountConfirmation: true, feeAmount: null, feeCharged: null,
      });
    }
    expect(selectedTotals([{ ...rule, amount: 0, amountText: null }], new Set([rule.id]))).toMatchObject({
      requiresAmountConfirmation: false, feeAmount: "$0.00", feeCharged: "No",
    });
  });
});
