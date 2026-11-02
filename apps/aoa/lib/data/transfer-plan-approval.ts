import {
  FUNDING_TYPES,
  TRANSFER_DECISION_CHOICES,
  type FundingType,
  type TransferDecisionChoice,
} from "./transfer-types";
import type { TransferValidationError } from "./transfer-validate";
import { includedInInstructions } from "@/lib/transfers/holding-eligibility";

export type BasisDecisionDraft = {
  decisionId: string;
  decision: TransferDecisionChoice;
};

export type PartialPositionDraft = {
  symbol: string;
  isTransferring: boolean;
};

export type FundingPlanApprovalMode = "PREPARATION" | "LEGACY_IN_TRANSFER_REVIEW";

export type FundingPlanDraftInput = {
  approvalMode?: FundingPlanApprovalMode;
  baseVersion: number;
  fundingType: FundingType | null;
  basisDecisions: BasisDecisionDraft[];
  partialPositions: PartialPositionDraft[];
  note: string;
};

export type FundingPlanApprovalExpectation =
  | { mode: "none" }
  | { mode: "basis"; decisionIds: string[] }
  | { mode: "asset-map"; symbols: string[] };

export type FundingPlanValidationResult = {
  ok: boolean;
  errors: TransferValidationError[];
};

const sameMembers = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return expected.size === right.length && left.every((value) => expected.has(value));
};

export function normalizeFundingPlanNote(note: string): string | null {
  const normalized = note.trim();
  return normalized === "" ? null : normalized;
}

function snapshotObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Compare instructions, not changing valuations or display order. */
function partialAcatInstructionKey(value: unknown): string | null {
  const snapshot = snapshotObject(value);
  if (!snapshot || !Array.isArray(snapshot.positions) || snapshot.positions.length === 0) return null;
  const source = snapshot.source;
  if (source !== "asset-map" && source !== "transfer-decisions") return null;

  const positions: Array<[string, string, boolean]> = [];
  const ids = new Set<string>();
  for (const entry of snapshot.positions) {
    const row = snapshotObject(entry);
    if (!row || typeof row.symbol !== "string" || !row.symbol) return null;
    const id = source === "asset-map" ? row.symbol : row.decisionId;
    if (typeof id !== "string" || !id || ids.has(id)) return null;
    ids.add(id);
    if (source === "asset-map") {
      if (typeof row.isTransferring !== "boolean") return null;
      positions.push([id, row.symbol, includedInInstructions({ isTransferring: row.isTransferring })]);
    } else {
      if (row.decision !== "BRING_IN" && row.decision !== "LEAVE_GIFT") return null;
      positions.push([id, row.symbol, includedInInstructions({ decision: row.decision })]);
    }
  }
  if (!positions.some((position) => position[2])) return null;
  positions.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

  let account: unknown = null;
  if (source === "asset-map") {
    const map = snapshotObject(snapshot.assetMap);
    // A masked last four is not enough to establish that this is the same
    // account. Historical snapshots lacking a full-source binding need review.
    if (!map || typeof map.sourceAccountFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(map.sourceAccountFingerprint)) return null;
    account = map.sourceAccountFingerprint;
  }
  return JSON.stringify({ source, account, positions });
}

/**
 * Only immutable approvals can establish that paperwork still matches a plan.
 * Missing/unrecognized historical facts require review rather than assuming
 * completed preparation remains valid. Notes, market values, cost basis and
 * statement dates do not change the approved securities instructions.
 */
export function partialAcatInstructionsChanged(previous: unknown, next: unknown): boolean {
  const previousKey = partialAcatInstructionKey(previous);
  const nextKey = partialAcatInstructionKey(next);
  return previousKey == null || nextKey == null || previousKey !== nextKey;
}

/**
 * A material plan edit consumes a revision, even before the first approval, so
 * drafts opened before that edit cannot approve the new source accidentally.
 * Approval history stays immutable; its version numbers may have gaps because
 * the transfer version is the monotonic plan revision, not an approval count.
 * Call only after a writer's no-op check, in the same locked transaction.
 */
export function fundingPlanInvalidation() {
  return {
    funding_plan_complete: false,
    funding_plan_version: { increment: 1 },
    funding_plan_approved_at: null,
    funding_plan_approved_by: null,
  };
}

/**
 * Validate the browser draft against the server's current source rows. Exact
 * membership is intentional: if the asset map changed while the page was open,
 * Operations must review the refreshed list before approving it.
 */
export function validateFundingPlanApproval(
  input: FundingPlanDraftInput,
  expectation: FundingPlanApprovalExpectation,
): FundingPlanValidationResult {
  const errors: TransferValidationError[] = [];
  const error = (field: string, message: string) => errors.push({ field, message });

  if (input.fundingType == null || !FUNDING_TYPES.includes(input.fundingType)) {
    error("funding_type", "Choose a funding type before approving the plan.");
  }

  if (input.note.trim().length > 500) {
    error("approval_note", "Approval note must be 500 characters or fewer.");
  }

  if (input.fundingType === "ACAT_PARTIAL") {
    if (expectation.mode === "none") {
      error(
        "positions",
        "Add or link position data before approving a partial ACAT.",
      );
    } else if (expectation.mode === "asset-map") {
      const submitted = input.partialPositions.map((position) => position.symbol);
      if (new Set(submitted).size !== submitted.length) {
        error("positions", "Each mapped position may appear only once.");
      } else if (!sameMembers(submitted, expectation.symbols)) {
        error(
          "positions",
          "The asset map changed. Review the refreshed positions and approve again.",
        );
      } else if (!input.partialPositions.some((position) => position.isTransferring)) {
        error("positions", "Select at least one position for the partial ACAT.");
      }
    } else {
      const submitted = input.basisDecisions.map((decision) => decision.decisionId);
      if (new Set(submitted).size !== submitted.length) {
        error("positions", "Each position decision may appear only once.");
      } else if (!sameMembers(submitted, expectation.decisionIds)) {
        error(
          "positions",
          "The position list changed. Review the refreshed positions and approve again.",
        );
      } else if (
        input.basisDecisions.some(
          (decision) => !TRANSFER_DECISION_CHOICES.includes(decision.decision),
        )
      ) {
        error("positions", "One or more position decisions is invalid.");
      } else if (
        input.basisDecisions.some((decision) => decision.decision === "UNDECIDED")
      ) {
        error("positions", "Resolve every position before approving the plan.");
      } else if (
        !input.basisDecisions.some((decision) => decision.decision === "BRING_IN")
      ) {
        error("positions", "Select at least one position to bring in.");
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
