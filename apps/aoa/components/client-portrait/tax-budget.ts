import type { PillTone } from "@/components/ui";
import type { TaxBudget } from "@/lib/data/types";

// Pure state machine for the Tax Budget card (P1, ticket), mirroring the
// mockup's renderTaxBudget three states + bar/pill tones:
//   set   → figures + progress bar (green / amber ≥80% / red over) + status pill
//   stale → prior year on file but no current-year budget ("needs update")
//   unset → nothing on file ("not set")

export type TaxBudgetView =
  | {
      kind: "set";
      budget: number;
      realized: number;
      /** Remaining headroom; negative when over budget. */
      remaining: number;
      over: boolean;
      /** Bar fill percent, clamped to 0–100. */
      pct: number;
      tone: Extract<PillTone, "green" | "amber" | "red">;
      label: "on track" | "near limit" | "over budget";
      note: string;
    }
  | { kind: "stale"; priorYear: number; priorBudget: number }
  | { kind: "unset" };

export function taxBudgetView(tb: TaxBudget): TaxBudgetView {
  if (tb.current) {
    const { budget, realized, note } = tb.current;
    const over = realized > budget;
    const pct = budget > 0 ? Math.min(100, Math.round((realized / budget) * 100)) : 0;
    const tone = over ? "red" : pct >= 80 ? "amber" : "green";
    const label = over ? "over budget" : pct >= 80 ? "near limit" : "on track";
    return { kind: "set", budget, realized, remaining: budget - realized, over, pct, tone, label, note };
  }
  if (tb.prior) {
    return { kind: "stale", priorYear: tb.prior.year, priorBudget: tb.prior.budget };
  }
  return { kind: "unset" };
}
