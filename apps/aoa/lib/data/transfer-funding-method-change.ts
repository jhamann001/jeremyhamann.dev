import { FUNDING_TYPES, type FundingType } from "./transfer-types";
import type { BasisDecisionDraft, PartialPositionDraft } from "./transfer-plan-approval";
import type { TransferValidationError } from "./transfer-validate";

export const FUNDING_METHOD_CHANGE_STAGES = ["DECISION", "IN_TRANSFER", "FUNDED"] as const;
export type FundingMethodChangeStage = (typeof FUNDING_METHOD_CHANGE_STAGES)[number];
export type FundingMethodChangeInput = {
  expectedStage: FundingMethodChangeStage;
  basePlanVersion: number;
  baseMethodRevision: number;
  fundingType: FundingType;
  reason: string;
  affectedWorkReviewed: boolean;
  basisDecisions?: BasisDecisionDraft[];
  partialPositions?: PartialPositionDraft[];
  sourceFingerprint?: string;
};
export type FundingMethodChangeResult = { ok: true } | { ok: false; errors: TransferValidationError[] };
export type FundingMethodChangePreparation = {
  ok: true;
  sourceFingerprint: string;
  source: "asset-map" | "transfer-decisions" | "none";
  basisDecisions: Array<BasisDecisionDraft & { symbol: string }>;
  partialPositions: PartialPositionDraft[];
};
export type FundingMethodCorrectionRow = {
  id: string;
  revision: number;
  kind: "PLAN_REVISION" | "RECORDED_CORRECTION";
  previousFundingType: FundingType | null;
  fundingType: FundingType;
  stage: FundingMethodChangeStage;
  basePlanVersion: number;
  planVersion: number;
  reason: string;
  changedBy: string;
  changedAt: string;
};

/** Reporting overrides never reroute execution or amend an approval snapshot. */
export function recordedFundingMethod(input: {
  stage: string;
  funding_type: FundingType | null;
  recorded_funding_type?: FundingType | null;
}): FundingType | null {
  return input.stage === "FUNDED" ? input.recorded_funding_type ?? input.funding_type : input.funding_type;
}

export function validateFundingMethodChange(input: FundingMethodChangeInput): TransferValidationError[] {
  const errors: TransferValidationError[] = [];
  if (!FUNDING_METHOD_CHANGE_STAGES.includes(input?.expectedStage)) {
    errors.push({ field: "form", message: "Funding methods can change during Preparation, In transfer or Funded." });
  }
  if (!Number.isSafeInteger(input?.basePlanVersion) || input.basePlanVersion < 0 ||
      !Number.isSafeInteger(input?.baseMethodRevision) || input.baseMethodRevision < 0) {
    errors.push({ field: "form", message: "Refresh the transfer before changing its funding method." });
  }
  if (!FUNDING_TYPES.includes(input?.fundingType)) {
    errors.push({ field: "funding_type", message: "Choose a valid funding method." });
  }
  if (typeof input?.reason !== "string" || input.reason.trim().length < 1 || input.reason.trim().length > 500) {
    errors.push({ field: "reason", message: "Enter a reason of 1 to 500 characters." });
  }
  if (input?.affectedWorkReviewed !== true) {
    errors.push({ field: "affected_work", message: "Confirm that you reviewed the affected instructions, tasks and existing links." });
  }
  if (input?.basisDecisions !== undefined && (!Array.isArray(input.basisDecisions) || input.basisDecisions.some((row) =>
    !row || typeof row.decisionId !== "string" || typeof row.decision !== "string"))) {
    errors.push({ field: "positions", message: "Review the position decisions before saving." });
  }
  if (input?.partialPositions !== undefined && (!Array.isArray(input.partialPositions) || input.partialPositions.some((row) =>
    !row || typeof row.symbol !== "string" || typeof row.isTransferring !== "boolean"))) {
    errors.push({ field: "positions", message: "Review the partial-ACAT positions before saving." });
  }
  return errors;
}

/** A new rail needs fresh initiation facts; cash reclassification preserves progress. */
export function fundingRouteFamily(method: FundingType | null): "ACAT" | "DRS" | "CASH" | "MANUAL" | "NONE" {
  if (method == null) return "NONE";
  if (method === "ACAT_FULL" || method === "ACAT_PARTIAL") return "ACAT";
  if (method === "MANUAL") return "MANUAL";
  return method === "DRS" ? "DRS" : "CASH";
}

export type FundingMethodInitiationInput = Pick<FundingMethodChangeInput,
  "expectedStage" | "basePlanVersion" | "baseMethodRevision">;
