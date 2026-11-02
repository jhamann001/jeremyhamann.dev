import { describe, expect, it } from "vitest";
import { taxBudgetView } from "@/components/client-portrait/tax-budget";
import type { TaxBudget } from "@/lib/data/types";

const YEAR = 2026;

function tb(partial: Partial<TaxBudget>): TaxBudget {
  return { year: YEAR, current: null, prior: null, ...partial };
}

describe("taxBudgetView", () => {
  it("maps a healthy budget to set/on track/green", () => {
    const v = taxBudgetView(
      tb({ current: { budget: 120000, realized: 46000, note: "n" } }),
    );
    expect(v).toEqual({
      kind: "set",
      budget: 120000,
      realized: 46000,
      remaining: 74000,
      over: false,
      pct: 38,
      tone: "green",
      label: "on track",
      note: "n",
    });
  });

  it("flips to near limit/amber at >=80%", () => {
    const v = taxBudgetView(
      tb({ current: { budget: 100000, realized: 80000, note: "" } }),
    );
    expect(v).toMatchObject({ kind: "set", pct: 80, tone: "amber", label: "near limit" });
  });

  it("stays green just under the 80% threshold", () => {
    const v = taxBudgetView(
      tb({ current: { budget: 100000, realized: 79400, note: "" } }),
    );
    expect(v).toMatchObject({ kind: "set", pct: 79, tone: "green", label: "on track" });
  });

  it("goes over budget/red with negative remaining and a clamped bar", () => {
    const v = taxBudgetView(
      tb({ current: { budget: 200000, realized: 214000, note: "" } }),
    );
    expect(v).toMatchObject({
      kind: "set",
      over: true,
      remaining: -14000,
      pct: 100,
      tone: "red",
      label: "over budget",
    });
  });

  it("treats a zero budget with realized gains as over, without dividing by zero", () => {
    const v = taxBudgetView(tb({ current: { budget: 0, realized: 5000, note: "" } }));
    expect(v).toMatchObject({ kind: "set", over: true, pct: 0, tone: "red" });
  });

  it("returns stale when only a prior year is on file", () => {
    const v = taxBudgetView(tb({ prior: { year: 2025, budget: 45000 } }));
    expect(v).toEqual({ kind: "stale", priorYear: 2025, priorBudget: 45000 });
  });

  it("prefers the current year over a prior year", () => {
    const v = taxBudgetView(
      tb({
        current: { budget: 10, realized: 0, note: "" },
        prior: { year: 2025, budget: 45000 },
      }),
    );
    expect(v.kind).toBe("set");
  });

  it("returns unset when nothing is on file", () => {
    expect(taxBudgetView(tb({}))).toEqual({ kind: "unset" });
  });
});
