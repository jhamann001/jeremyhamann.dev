import { describe, expect, it } from "vitest";
import {
  TAX_BUDGET_AMOUNT_MAX,
  TAX_BUDGET_NOTE_MAX,
  canWriteTaxBudget,
  validateTaxBudgetValues,
} from "@/lib/data/tax-budget-write";

describe("canWriteTaxBudget", () => {
  it.each([
    "ADMIN",
    "OPERATIONS",
    "ADVISOR",
    "CLIENT_SERVICE",
  ])("allows the reviewed human write role %s", (role) => {
    expect(canWriteTaxBudget(role)).toBe(true);
  });

  it.each(["HEAD_OF_ADVISORY", "VIEWER", "UNKNOWN", "", null, undefined])(
    "fails closed for %s",
    (role) => {
      expect(canWriteTaxBudget(role)).toBe(false);
    },
  );
});

describe("validateTaxBudgetValues", () => {
  it("normalizes numeric strings and trims the planning note", () => {
    expect(
      validateTaxBudgetValues({
        budget: "150000",
        realized: "42000.50",
        note: "  Harvest only after review.  ",
      }),
    ).toEqual({
      ok: true,
      values: {
        budget: 150000,
        realized: 42000.5,
        note: "Harvest only after review.",
      },
    });
  });

  it("accepts exact dollar amounts with comma and currency formatting", () => {
    expect(
      validateTaxBudgetValues({
        budget: "33,333",
        realized: "$1,500.25",
        note: "",
      }),
    ).toEqual({
      ok: true,
      values: { budget: 33333, realized: 1500.25, note: "" },
    });
  });

  it("allows a deliberate zero budget and zero realized amount", () => {
    expect(validateTaxBudgetValues({ budget: 0, realized: 0, note: "" })).toEqual({
      ok: true,
      values: { budget: 0, realized: 0, note: "" },
    });
  });

  it.each([
    { budget: -1, realized: 0, note: "" },
    { budget: Number.NaN, realized: 0, note: "" },
    { budget: TAX_BUDGET_AMOUNT_MAX + 1, realized: 0, note: "" },
    { budget: 0, realized: -1, note: "" },
    { budget: 0, realized: Number.POSITIVE_INFINITY, note: "" },
    { budget: "", realized: 0, note: "" },
    { budget: "not a number", realized: 0, note: "" },
    { budget: "1,500.123", realized: 0, note: "" },
  ])("rejects invalid money values: %j", (input) => {
    expect(validateTaxBudgetValues(input).ok).toBe(false);
  });

  it("rejects a note over the stored limit", () => {
    const result = validateTaxBudgetValues({
      budget: 1,
      realized: 0,
      note: "x".repeat(TAX_BUDGET_NOTE_MAX + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.field).toBe("note");
  });
});
