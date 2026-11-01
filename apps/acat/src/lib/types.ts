/** Source-reported pipeline context, refreshed only by a successful GCP sync. */
export interface AssetMappingContext {
  mappingTransferStatus?: string | null;
  mappingTransferNotes?: string | null;
  mappingTransferring?: boolean | null;
  mappingStatementDate?: string | null;
  mappingStatementAgeDays?: number | null;
  mappingStatementIsStale?: boolean | null;
  mappingSyncedAt?: string | null;
}

export interface Asset extends AssetMappingContext {
  id: string;
  symbol: string;
  description: string;
  cusip?: string;
  expectedQty: number;
  actualQty: number;
  mapStatus: "Mapped" | "Unmapped" | "Pending" | "Expected";
  issue?: string;
  notes?: string;
  amount?: number;
  assetClass?: string;
  settlingLocation?: string;
  settlingLocationReason?: string;
  includeInTransfer?: boolean | null;
}

export interface ApexPosition {
  cusip: string;
  symbol: string;
  description: string;
  assetClass: string;
  qty: number;
  amount: number;
  settlingLocation: string;
  settlingLocationReason: string;
}

export interface AcatRecord {
  id: string;
  deletedAt?: string | null;
  clientName: string;
  /** Compatibility projection: populated only for exactly one linked person. */
  cedarRidgeUserId?: string | null;
  /** Authoritative linked-person set; empty until explicitly verified. */
  cedarRidgeUserIds?: string[];
  linkedClients?: { cedarRidgeUserId: string; displayName: string }[];
  /** Database-owned optimistic concurrency token for identity changes. */
  identityVersion?: number;
  mappingAccountId?: string | null;
  acatTransferId?: string;
  accountType?: string;
  additionalResources?: string;
  apexAccountId: string;
  apexCompletionDate?: string;
  apexTicket?: string;
  associatedControlNumber?: string;
  controlNumber?: string;
  dtccNumber?: string;
  direction?: string;
  crwEe?: string;
  feeAmount?: string;
  feeCharged?: string;
  feeMemo?: string;
  feeRequestCompleted?: string;
  feeRequestSubmitted?: string;
  feeApexTicket?: string;
  feeCreditRequestId?: string;
  methodRequested?: string;
  transferWorkflow?: TransferWorkflow;
  notes?: string;
  opsSubmissionDateToApex?: string;
  originalClientRequestDate?: string;
  residualMonitoringRequired?: boolean;
  residualFollowUpDate?: string;
  crmTicket?: string;
  rejectionReason?: string;
  statementAccountNumber?: string;
  // Integer cents (see schema.prisma). Displayed via formatCentsAsDollar.
  statementAmount?: number;
  status: AcatStatus;
  transferringContra?: string;
  tradeRequestId?: string;
  tradeRequestUrl?: string;
  tradeInstructions?: string;
  type?: string;
  wealthAdvisor?: string;
  lastUpdated: string;

  // Legacy / internal fields used by recon engine
  crmDealId: string;
  custodianId: string;
  custodianName: string;
  acatDate: string;
  slackAlerted: boolean;
  mappingSource: string;
  mappingSyncedAt?: string | null;
  apexSource: string;
  assets: Asset[];

  // Recon completion stamp (see schema.prisma). Set automatically when
  // the ACAT's recon rate crosses the 90% threshold with both GCP
  // positions and a Apex CSV present. Cleared when conditions slip.
  reconCompletedAt?: string | null;

  // ticket: optional eager-load of the linked custodian. Populated by
  // GET /api/acats and GET /api/acats/[id] (`include: { custodian: true }`)
  // so per-custodian aging + expected-completion derivations work without
  // a second fetch. Null when the record has no custodianId or the
  // custodian row was deleted.
  custodian?: Custodian | null;
}

export type AcatStatus =
  | "WaitingForApex"
  | "PendingAccountOpening"
  | "WaitingOnClient"
  | "WaitingForStatement"
  | "AcatReceived"
  | "ToCome"
  | "Submitted"
  | "PendingReview"
  | "PendingContraResponse"
  | "Accepted"
  | "PendingSettlement"
  | "PendingBookkeeping"
  | "Matched"
  | "Mismatch"
  | "Pending"
  | "Completed"
  | "Rejected"
  | "Purged"
  | "Canceled"
  | "Deferred";

export type TransferWorkflow =
  | "ACAT"
  | "MANUAL"
  | "DRS"
  | "RESIDUAL"
  | "UNCLASSIFIED";

export const TRANSFER_WORKFLOWS: TransferWorkflow[] = [
  "ACAT",
  "MANUAL",
  "DRS",
  "RESIDUAL",
  "UNCLASSIFIED",
];

export const TRANSFER_WORKFLOW_LABELS: Record<TransferWorkflow, string> = {
  ACAT: "ACAT (API)",
  MANUAL: "Manual",
  DRS: "DRS",
  RESIDUAL: "Residual",
  UNCLASSIFIED: "Unclassified",
};

export const ACAT_STATUSES: AcatStatus[] = [
  "WaitingForApex",
  "PendingAccountOpening",
  "WaitingOnClient",
  "WaitingForStatement",
  "AcatReceived",
  "ToCome",
  "Submitted",
  "PendingReview",
  "PendingContraResponse",
  "Accepted",
  "PendingSettlement",
  "PendingBookkeeping",
  "Matched",
  "Mismatch",
  "Pending",
  "Completed",
  "Rejected",
  "Purged",
  "Canceled",
  "Deferred",
];

export const ACAT_STATUS_LABELS: Record<AcatStatus, string> = {
  WaitingForApex: "Waiting for Apex",
  PendingAccountOpening: "Pending Account Opening",
  WaitingOnClient: "Waiting on Client",
  WaitingForStatement: "Waiting for Statement",
  AcatReceived: "ACAT Received",
  ToCome: "To Come",
  Submitted: "Submitted",
  PendingReview: "Pending Review",
  PendingContraResponse: "Pending Contra Response",
  Accepted: "Accepted",
  PendingSettlement: "Pending Settlement",
  PendingBookkeeping: "Pending Bookkeeping",
  Matched: "Recon: Matched",
  Mismatch: "Recon: Mismatch",
  Pending: "Recon: Pending",
  Completed: "Completed",
  Rejected: "Rejected",
  Purged: "Purged",
  Canceled: "Canceled",
  Deferred: "Deferred",
};

export const ACAT_STATUS_GROUPS: { label: string; statuses: AcatStatus[] }[] = [
  {
    label: "In Progress",
    statuses: [
      "WaitingForApex",
      "PendingAccountOpening",
      "WaitingOnClient",
      "WaitingForStatement",
      "AcatReceived",
      "ToCome",
      "Submitted",
      "PendingReview",
      "PendingContraResponse",
      "Accepted",
      "PendingSettlement",
      "PendingBookkeeping",
      "Matched",
      "Mismatch",
      "Pending",
    ],
  },
  {
    label: "Finalized",
    statuses: ["Completed", "Rejected", "Purged", "Canceled", "Deferred"],
  },
];

export const TERMINAL_STATUSES: Set<AcatStatus> = new Set([
  "Completed",
  "Rejected",
  "Purged",
  "Canceled",
  "Deferred",
]);

/**
 * ticket item 4: statuses that describe the *asset reconciliation* outcome,
 * not the ACAT itself. These no longer belong in user-facing status pickers
 * — operators set the ACAT's lifecycle status; the recon state is derived
 * from the asset matching rate (see `getReconStatus` in
 * `acat-derivations.ts`) and surfaced in its own `Recon Status` column.
 *
 * We keep the enum members on `AcatStatus` so legacy records still render,
 * filter, and group correctly; we just stop offering them as choices for
 * new records or status changes.
 */
export const RECON_DERIVED_STATUSES: ReadonlySet<AcatStatus> = new Set([
  "Matched",
  "Mismatch",
  "Pending",
]);

/**
 * Statuses presented in the ACAT status dropdown (in the detail drawer and
 * the New ACAT modal). Derived from `ACAT_STATUSES` minus the recon-only
 * trio above so the picker only offers true ACAT lifecycle states.
 */
export const ACAT_STATUS_PICKER_OPTIONS: AcatStatus[] = ACAT_STATUSES.filter(
  (s) => !RECON_DERIVED_STATUSES.has(s)
);

export type CustodianContactMethod = "EMAIL" | "PHONE" | "PORTAL" | "OTHER";

export interface Custodian {
  id: string;
  name: string;
  acatFeeAmount: number;
  avgProcessingDays: number;
  contactEmail?: string;
  contactMethod?: CustodianContactMethod | null;
  contactDetails?: string | null;
  dtcNumber?: string | null;
  receivingAccountNumber?: string | null;
  transferType?: "ACAT_API" | "MANUAL" | "MIXED" | "INTERNAL" | "UNCONFIRMED" | null;
  documentationStatus?: "DOCUMENTED" | "PARTIAL" | "NEEDS_CALL" | null;
  signature?: string | null;
  letterOfAcceptance?: string | null;
  medallionRequired?: string | null;
  liquidationMethod?: string | null;
  returnMethod?: string | null;
  watchouts?: string | null;
  fees?: CustodianFee[];
}

export type CustodianFeeAccountType = "ANY" | "IRA" | "BROKERAGE";
export type CustodianFeeTransferType = "ANY" | "FULL" | "PARTIAL";
export type CustodianFeeDirection = "ANY" | "IN" | "OUT";

export interface CustodianFee {
  id: string;
  custodianId: string;
  feeType: string;
  accountType: CustodianFeeAccountType;
  transferType: CustodianFeeTransferType;
  direction: CustodianFeeDirection;
  amount: number | null;
  amountText: string | null;
  notes: string | null;
  documentation: string | null;
}

// ACAT record accountType values (string in DB) → fee-schedule category.
// Anything not listed here falls back to ANY-only fees.
export function mapAccountTypeToFeeCategory(
  accountType: string | null | undefined
): CustodianFeeAccountType {
  if (!accountType) return "ANY";
  const normalized = accountType.toLowerCase();
  if (normalized.includes("ira")) return "IRA";
  if (
    normalized === "individual" ||
    normalized === "joint" ||
    normalized === "trust" ||
    normalized === "corporate"
  ) {
    return "BROKERAGE";
  }
  return "ANY";
}

export function isResidualCreditTransfer(
  type: string | null | undefined
): boolean {
  return type?.trim().toLowerCase() === "residual credit";
}

export function mapTransferTypeToFeeCategory(
  type: string | null | undefined
): CustodianFeeTransferType {
  if (!type) return "ANY";
  const normalized = type.toLowerCase();
  if (normalized === "full") return "FULL";
  if (normalized === "partial") return "PARTIAL";
  return "ANY";
}

// Maps the ACAT record's `direction` field ("In" | "Out") to the
// CustodianFee.direction category. The filter semantics (see
// selectApplicableFees below) are intentionally inverted from intuition:
// the fee schedule shown in FeesTab is the CONTRA's schedule. A fee
// tagged OUT represents a charge the contra levies when it releases
// assets — which happens when the ACAT moves assets INTO our firm
// (record.direction === "In"). See the ACAT Out fee filter fix for full
// rationale.
export function mapDirectionToFeeCategory(
  direction: string | null | undefined
): CustodianFeeDirection {
  if (!direction) return "ANY";
  const normalized = direction.toLowerCase();
  if (normalized === "in") return "IN";
  if (normalized === "out") return "OUT";
  return "ANY";
}

export interface ApplicableFeeSummary {
  fees: CustodianFee[];
  total: number;
  hasUnknownAmount: boolean;
}

export function selectApplicableFees(
  all: CustodianFee[],
  accountType: string | null | undefined,
  transferType: string | null | undefined,
  direction?: string | null | undefined
): ApplicableFeeSummary {
  // Residual credits are follow-on cash movements, not chargeable ACAT
  // transfers. Returning before category mapping prevents "Residual Credit"
  // from falling through to ANY and matching every fee schedule row.
  if (isResidualCreditTransfer(transferType)) {
    return { fees: [], total: 0, hasUnknownAmount: false };
  }

  const acctCat = mapAccountTypeToFeeCategory(accountType);
  const transferCat = mapTransferTypeToFeeCategory(transferType);
  const directionCat = mapDirectionToFeeCategory(direction);

  const fees = all.filter((f) => {
    const acctOk = f.accountType === "ANY" || f.accountType === acctCat;
    const transferOk =
      f.transferType === "ANY" ||
      transferCat === "ANY" ||
      f.transferType === transferCat;
    // Direction filter. A CustodianFee row tagged IN or OUT represents a
    // fee the contra charges when the ACAT's direction is the OPPOSITE
    // (because the fee schedule is the contra's, not our firm's):
    //   - fee.direction === "OUT" means the contra releases assets, which
    //     on an ACAT record shows as direction === "In".
    //   - fee.direction === "IN" means the contra receives assets, which
    //     on an ACAT record shows as direction === "Out".
    // When either side is unspecified (fee ANY or record direction
    // missing) we include the fee — this preserves behaviour for legacy
    // rows and lets maintenance-style fees (IRA termination, etc.) show
    // regardless of direction.
    const feeDir = f.direction ?? "ANY";
    const directionOk =
      feeDir === "ANY" ||
      directionCat === "ANY" ||
      (feeDir === "OUT" && directionCat === "IN") ||
      (feeDir === "IN" && directionCat === "OUT");
    return acctOk && transferOk && directionOk;
  });

  const total = fees.reduce((sum, f) => sum + (f.amount ?? 0), 0);
  const hasUnknownAmount = fees.some((f) => f.amount == null);
  return { fees, total, hasUnknownAmount };
}

export type StatusFilter = "All" | AcatStatus;

export function parseMethodRequested(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

export function stringifyMethodRequested(methods: string[]): string {
  return methods.filter((m) => m.length > 0).join(", ");
}

export type FeeReimbursementStatus =
  | "Pending"
  | "Approved"
  | "Credited"
  | "Denied";

// Matches Fee Store DB table: fee_credits_submissions
export interface FeeRecord {
  id?: number;
  submission_date: string;
  user_role?: string;
  client_user_id?: string;
  fee_type?: string;
  fee_amount: number;
  account_numbers?: string;
  waiver_reason?: string;
  created_at?: string;
  status: FeeReimbursementStatus;
  credited_date?: string;
  client_name: string;
  apex_request?: string;
}
