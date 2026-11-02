import {
  STAGE_GATES,
  STAGE_LABEL,
  STAGE_ORDER,
  type TransferAccountStatus,
  type TransferDecisionChoice,
  type TransferStage,
} from "./transfer-types";

// Pure derivation helpers for the transfer domain (TDD ticket ADR-2/ADR-3).
// No Prisma import — unit-testable, consumed by the T2 seam and T3 screens.

// ---------------------------------------------------------------------------
// recommendPosition — the mockup's `recBadge` rule made total (ADR-3). The
// recommendation is DERIVED at read time, never stored.
// ---------------------------------------------------------------------------

export type RecommendationKind = "BRING_IN" | "LEAVE_GIFT" | "BASIS_NEEDED";

export type Recommendation = {
  kind: RecommendationKind;
  label: string;
};

export const RECOMMENDATION_LABEL: Record<RecommendationKind, string> = {
  LEAVE_GIFT: "Leave / gift — highly appreciated",
  BRING_IN: "Bring in — low basis enables TLH",
  BASIS_NEEDED: "Basis needed",
};

/**
 * Derive the per-position recommendation from market value and cost basis.
 *
 * - `basis === null` → BASIS_NEEDED (no call can be made without basis).
 * - Unrealized gain strictly greater than 300% of basis → LEAVE_GIFT
 *   (equivalently `value > 4 × basis`; exactly 300% is NOT "highly
 *   appreciated" — the strict `>` matches the mockup and is pinned by tests).
 * - Otherwise → BRING_IN (low basis enables TLH).
 * - Degenerate `basis <= 0` with `value > 0` is an unbounded gain →
 *   LEAVE_GIFT; `basis <= 0` with `value <= 0` has no meaningful gain →
 *   BRING_IN.
 */
export function recommendPosition(
  value: number,
  basis: number | null,
): Recommendation {
  if (basis === null) {
    return { kind: "BASIS_NEEDED", label: RECOMMENDATION_LABEL.BASIS_NEEDED };
  }
  const highlyAppreciated =
    basis <= 0 ? value > 0 : (value - basis) / basis > 3;
  const kind: RecommendationKind = highlyAppreciated
    ? "LEAVE_GIFT"
    : "BRING_IN";
  return { kind, label: RECOMMENDATION_LABEL[kind] };
}

// ---------------------------------------------------------------------------
// gateStatus — per-stage gate satisfaction, derived at read time (ADR-2).
// Gates are SOFT (locked, the owner 2026-07-02): this feeds the GateStepper and
// lane captions; it never blocks a transition.
// ---------------------------------------------------------------------------

export type GateDetail = {
  /** The record's current stage. */
  stage: TransferStage;
  tasks: readonly { done: boolean }[];
  decisions: readonly { decision: TransferDecisionChoice }[];
  accounts: readonly { status: TransferAccountStatus }[];
};

export type GateStatus = {
  stage: TransferStage;
  label: string;
  gate: string;
  /** Position relative to the record's current stage (stepper rendering). */
  state: "done" | "now" | "todo";
  /** Whether this stage's gate is satisfied by the structured data. */
  satisfied: boolean;
};

/**
 * Compute the three-step gate stepper for a transfer record (ticket Slice 1:
 * DECISION → IN_TRANSFER → FUNDED).
 *
 * Satisfaction is checklist completion (every task done) for all three stages.
 * DECISION's satisfaction is a deliberate `allTasksDone` PLACEHOLDER for
 * Slice 1: Slice 2 introduces the readiness columns (accounts_opened_at_apex /
 * funding_plan_complete / funding_initiated) and finalizes the DECISION rule to
 * "all three checklist booleans true". The columns do not exist yet, so the
 * stepper proxies on the checklist until then.
 *
 * Empty child sets are VACUOUSLY SATISFIED (`Array.every` semantics). Gates
 * stay SOFT (locked, the owner 2026-07-02): this feeds the GateStepper/lane
 * captions and never blocks a transition. Pinned by unit tests.
 */
export function gateStatus(detail: GateDetail): GateStatus[] {
  const currentIdx = STAGE_ORDER.indexOf(detail.stage);
  const allTasksDone = detail.tasks.every((t) => t.done);

  return STAGE_ORDER.map((stage, idx) => {
    // Slice 1: every stage proxies on checklist completion (DECISION is the
    // documented placeholder — finalized in Slice 2 once the columns land).
    const satisfied = allTasksDone;
    return {
      stage,
      label: STAGE_LABEL[stage],
      gate: STAGE_GATES[stage],
      state: idx < currentIdx ? "done" : idx === currentIdx ? "now" : "todo",
      satisfied,
    };
  });
}
