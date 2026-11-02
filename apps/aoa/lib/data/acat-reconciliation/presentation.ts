import type { Prisma } from "@prisma/client";
import type { AcatMatchAction, AcatMatchDecision } from "../acat-link-contract";

export const REVIEW_CATEGORIES = ["linked", "held", "proposed", "review", "excluded", "no_counterpart"] as const;
export type ReviewCategory = typeof REVIEW_CATEGORIES[number];
export const REVIEW_CATEGORY_LABELS: Record<ReviewCategory, string> = {
  linked: "Existing links",
  held: "Automatic linking on hold",
  proposed: "Proposed pairs",
  review: "Needs evidence or manual review",
  excluded: "Excluded from this matching run",
  no_counterpart: "Not yet matched in this run",
};
export type ReviewPopulation = { total: number; categories: Record<ReviewCategory, number> };
export type ReviewCoverage = { aoa: ReviewPopulation; tracker: ReviewPopulation };

type Decision = Pick<AcatMatchDecision, "transferId" | "recordId" | "reason" | "action">;

export function reviewCategory(decision: Pick<Decision, "reason" | "action">): ReviewCategory {
  if (decision.reason === "manual_hold" && decision.action === "exclude") return "held";
  return ({ preserve: "linked", propose: "proposed", review: "review", exclude: "excluded", no_counterpart: "no_counterpart" } as const)[decision.action];
}

function population(total: number): ReviewPopulation {
  return { total, categories: { linked: 0, held: 0, proposed: 0, review: 0, excluded: 0, no_counterpart: 0 } };
}

/** Prepared snapshot accounting only. Execution outcomes and later human reviews
 * do not rewrite these categories. A pair participates in both populations;
 * repeated source references still count as one Tracker record. */
export function reviewCoverage(input: {
  decisions: readonly Decision[]; sourceCount: number; targetCount: number;
}): ReviewCoverage | null {
  if (![input.sourceCount, input.targetCount].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const aoa = population(input.targetCount);
  const tracker = population(input.sourceCount);
  const targets = new Set<string>();
  const sources = new Map<string, Decision[]>();
  for (const decision of input.decisions) {
    if (!decision.transferId && !decision.recordId) return null;
    if (decision.transferId) {
      if (targets.has(decision.transferId)) return null;
      targets.add(decision.transferId);
      aoa.categories[reviewCategory(decision)] += 1;
    }
    if (decision.recordId) {
      const group = sources.get(decision.recordId) ?? [];
      group.push(decision);
      sources.set(decision.recordId, group);
    }
  }
  if (targets.size !== input.targetCount || sources.size !== input.sourceCount) return null;
  for (const decisions of sources.values()) {
    // Same precedence as prepared coverage: an existing valid link wins;
    // otherwise competing source references need review, never extra records.
    const category = decisions.some((row) => row.action === "preserve" && row.reason === "existing_link") ? "linked"
      : decisions.length > 1 ? "review" : reviewCategory(decisions[0]);
    tracker.categories[category] += 1;
  }
  return { aoa, tracker };
}

/** PENDING is a storage default, not a business disposition or a match count. */
export function reviewDecisionLabel(decision: { action: string; reason: string; outcome: string; disposition: string }): string {
  const resultLabels: Record<string, string> = {
    APPLIED: "Link applied", UNDONE: "Link undone", NOOP: "Link already satisfied", CONFLICT: "Link attempt conflicted", BLOCKED: "Link attempt blocked",
  };
  if (decision.outcome !== "PENDING") return resultLabels[decision.outcome] ?? "Result needs technical review";
  if (decision.disposition === "REJECT") return "Pair rejected";
  if (decision.disposition === "ACCEPT" && ["review", "propose"].includes(decision.action)) return "Pair confirmed — not applied";
  const category = reviewCategory({ action: decision.action as AcatMatchAction, reason: decision.reason as Decision["reason"] });
  return REVIEW_CATEGORY_LABELS[category] ?? "Needs technical review";
}


export const REVIEW_POPULATIONS = {
  aoa: "AOA transfers", tracker_only: "Tracker records without a selected AOA transfer", all: "All review entries",
} as const;
export type ReviewPopulationFilter = keyof typeof REVIEW_POPULATIONS;

/** Filters prepared dispositions only. The complete population projection and
 * all matching/application rules stay independent of this list query. */
export function reviewListFilter(population: string, category: string): {
  population: ReviewPopulationFilter; category: ReviewCategory | "all"; where: Prisma.AcatLinkDecisionWhereInput;
} {
  const selectedPopulation = Object.hasOwn(REVIEW_POPULATIONS, population) ? population as ReviewPopulationFilter : "aoa";
  const selectedCategory = REVIEW_CATEGORIES.includes(category as ReviewCategory) ? category as ReviewCategory : "all";
  const where: Prisma.AcatLinkDecisionWhereInput = {};
  if (selectedPopulation === "aoa") where.transfer_id = { not: null };
  if (selectedPopulation === "tracker_only") where.transfer_id = null;
  const actions: Record<ReviewCategory, AcatMatchAction> = {
    linked: "preserve", held: "exclude", proposed: "propose", review: "review", excluded: "exclude", no_counterpart: "no_counterpart",
  };
  if (selectedCategory !== "all") where.action = actions[selectedCategory];
  if (selectedCategory === "held") where.reason = "manual_hold";
  if (selectedCategory === "excluded") where.reason = { not: "manual_hold" };
  return { population: selectedPopulation, category: selectedCategory, where };
}
