// Client-safe projections for the asset-transfer Fee review. Each source has
// its own availability; a missing value is never interpreted as a zero charge
// or as evidence that a reimbursement has been credited.
import type { TransferFee, FeeFailureCode } from "./acat-fee-view";
import type { TransferFeeRequest } from "./acat-fee-requests-view";
import type { CustodianProfile } from "./custodian-library-contract";

export type TransferFeeReviewCustodian = Pick<CustodianProfile,
  "id" | "name" | "reviewStatus" | "acatFeeAmount" | "documentationStatus" | "fees" | "feeSchedules"
>;

export type TransferFeeReviewLibrary =
  | { state: "ready"; custodian: TransferFeeReviewCustodian; retrievedAt: string; matchedBy: "id" }
  | { state: "restricted" | "unavailable" | "not_linked" }
  | { state: "unmatched"; reason: "missing_custodian" | "not_found" | "ambiguous" | "conflict" };

export type TransferFeeReviewActual =
  | { state: "ready"; fee: TransferFee }
  | { state: "partial"; fee: TransferFee; code: FeeFailureCode }
  | { state: "restricted" | "off" | "not_linked" | "unavailable" };

export type TransferFeeReviewRequests =
  | { state: "ready"; accountLabel: string; requests: TransferFeeRequest[]; truncated: boolean; scope: "account" }
  | { state: "restricted" | "off" | "not_linked" | "unavailable" }
  | { state: "unmatched"; reason: "client" | "account" };

/** Compatible with the existing fee editor, without a raw tracker record or full account number. */
export type TransferFeeReviewRecord = {
  clientName: string | null;
  direction: string | null;
  type: string | null;
  status: string | null;
  transferringContra: string | null;
  custodianName: string;
  controlNumber: string | null;
  apexAccountId: string | null;
  custodianId: string | null;
  transferWorkflow: string | null;
  cedarRidgeUserId: string | null;
};

export type TransferFeeReview = {
  library: TransferFeeReviewLibrary;
  actual: TransferFeeReviewActual;
  requests: TransferFeeReviewRequests;
  record: TransferFeeReviewRecord | null;
  recordId: string | null;
};
