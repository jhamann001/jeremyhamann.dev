import type { DealRow, DealStage } from "@/lib/data/deal-types";
import { STAGE_ORDER } from "@/lib/data/deal-types";

// Deals rollup for the funding picture (T4, TDD ADR-9) — pure fold over the
// REAL `dealsForHousehold` rows. "Top stage" (the mockup's undefined `$X ·
// stage`) is pinned here (blueprint §0.5): the stage with the LARGEST summed
// amount among the household's deals, ties broken by pipeline order
// (STAGE_ORDER). Unit-tested (test/funding-rollup.test.ts); amounts arrive
// Number()-coerced from the seam.

export type DealRollup = {
  count: number;
  total: number;
  topStage: DealStage | null;
};

export function dealRollup(rows: DealRow[]): DealRollup {
  const byStage = new Map<DealStage, number>();
  let total = 0;
  for (const row of rows) {
    const amount = Number(row.amount);
    total += amount;
    byStage.set(row.stage, (byStage.get(row.stage) ?? 0) + amount);
  }

  let topStage: DealStage | null = null;
  for (const stage of STAGE_ORDER) {
    const sum = byStage.get(stage);
    if (sum == null) continue;
    if (topStage == null || sum > (byStage.get(topStage) as number)) {
      topStage = stage;
    }
  }

  return { count: rows.length, total, topStage };
}
