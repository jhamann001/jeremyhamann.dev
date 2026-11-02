// Pure, client-safe fee rules and copy for the transfer drawer's fee section
// (ticket). Ported from the tracker's fee workspace (transfer-tracker
// `FeesTab.tsx` and `acat-fee-contract.ts` at 00babb7). The server adapter, the
// server actions, the client section, and the tests all import from here.

export const FEE_FIELD_KEYS = [
  "feeCharged", "feeAmount", "feeMemo", "feeRequestSubmitted", "feeRequestCompleted", "feeApexTicket", "feeCreditRequestId",
] as const;
export type FeeField = (typeof FEE_FIELD_KEYS)[number];
export type TransferFee = Record<FeeField, string | null>;

export const FEE_LOG_STATUSES = ["Pending", "Approved", "Credited", "Denied"] as const;
export type FeeLogStatus = (typeof FEE_LOG_STATUSES)[number];
export type FeeLogRow = {
  id: string | null;
  status: FeeLogStatus;
  feeAmount: number;
  feeType: string | null;
  submissionDate: string | null;
};

/** One custodian fee rule as the section needs it (a projection of the custodian library fee). */
export type FeeRule = {
  id: string;
  feeType: string;
  accountType: string;
  transferType: string;
  direction: string;
  amount: number | null;
  amountText: string | null;
  notes: string | null;
};

export const FEE_RULE_ID_MAX = 64;
export const FEE_RULE_COUNT_MAX = 50;
export const FEE_RECORD_ID_MAX = 200;

export type FeeFieldDef = { key: FeeField; label: string; type: "text" | "select" | "date"; options?: readonly string[] };

/** The tracker's seven rows, in order, with identical labels and types. */
export const FEE_FIELDS: readonly FeeFieldDef[] = [
  { key: "feeCharged", label: "Fee Charged?", type: "select", options: ["Yes", "No"] },
  { key: "feeAmount", label: "Fee Amount", type: "text" },
  { key: "feeMemo", label: "Fee Memo", type: "text" },
  { key: "feeRequestSubmitted", label: "Fee Request Submitted", type: "date" },
  { key: "feeRequestCompleted", label: "Fee Request Completed", type: "date" },
  { key: "feeApexTicket", label: "Fee Apex Ticket", type: "text" },
  { key: "feeCreditRequestId", label: "Fee Credit Req ID", type: "text" },
];

export const FEE_COPY = {
  title: "Fee Details",
  fullOutTitle: "Full ACAT Out — verify the automatic fee credit",
  fullOutBody: "Confirm the charge and reimbursement in Apex, record the fee amount and fee-specific Apex ticket, then log the request so its Fee Crediting Req ID is tied back here.",
  loadingSchedule: "Loading custodian fee schedule...",
  scheduleTitle: "Fee Schedule",
  applySelected: "Apply Selected to Record",
  checkingReimbursement: "Checking reimbursement status...",
  logTitle: "Reimbursement Log",
  refresh: "Refresh",
  actionRequired: "Review fee reimbursement",
  reimbursementReviewBody: "Review the existing Operations Tools request and its status before submitting another reimbursement.",
  confirmSelectedAmount: "Selected fees have a variable or qualified amount. Confirm the actual charge and enter its amount above.",
  logAnother: "Log Another Reimbursement",
  logReimbursement: "Log Reimbursement",
  logging: "Logging...",
  enterAmountFirst: "Enter Fee Amount First",
  enterAmountTitle: "Enter the charged fee amount first",
  noFeeTitle: "No Fee Charged",
  noFeeBody: "No ACAT transfer fee was charged for this record. No reimbursement action needed.",
  pendingTitle: "Fee Status Pending",
  pendingBody: "The charged fee has not been documented. Confirm the charge before recording a fee or reimbursement.",
  reviewTitle: "Fee Details Need Review",
  reviewBody: "The charged flag and amount do not agree. Confirm the actual charge before recording a reimbursement.",
  amountNotRecorded: "Amount not recorded",
  duplicateTitle: "Possible Duplicate",
  duplicateSubtitle: "Please confirm this is not a duplicate submission",
  duplicateUnknown: "A reimbursement may already exist for this account. Are you sure this is a new reimbursement?",
  cancel: "Cancel",
  submitAnyway: "Submit Anyway",
  cardLabel: "ACAT Transfer Fee",
  anyAccount: "Applies to all account types",
  noScheduleSet: "Set a transferring contra to see its fee schedule.",
  rulesFailed: "The custodian fee schedule could not be loaded.",
  retry: "Retry",
  retryLog: "Retry reimbursement log",
  loadingFee: "Loading fee details...",
  saveTitle: "Update Failed",
  saveMessage: "Could not save changes",
  applyTitle: "Update Failed",
  applyMessage: "Could not apply fee schedule",
  logFailTitle: "Failed to Log Reimbursement",
  // ticket Stage 1: reimbursement status, history and logging live in Operations Tools.
  requestsTitle: "Reimbursement Requests",
  requestsBody: "Reimbursement status and history are tracked in Operations Tools fee requests.",
  requestsLink: "Open Operations Tools fee requests",
  logLinkLabel: "Log Reimbursement in Operations Tools",
  logLinkNote: "Log Reimbursement opens Operations Tools fee requests. Select this client and account there to submit the request.",
  logUnavailable: "Reimbursement requests are not available right now.",
} as const;

export function noScheduleOnFile(contra: string): string {
  return `No fee schedule on file for ${contra}. Add entries via the CustodianFee seed file.`;
}

export function duplicateCountCopy(count: number): string {
  return `There ${count === 1 ? "is" : "are"} already ${count} fee credit${count === 1 ? "" : "s"} on file for this account. Are you sure this is a new reimbursement?`;
}

export type FeeFailureCode =
  | "refused" | "no_rules" | "log_not_configured" | "log_unavailable" | "log_failed" | "credit_request_id_not_stored"
  | "log_row_retained" | "rate_limited" | "unauthorized" | "not_found" | "internal_error" | "transport"
  | "off" | "forbidden" | "invalid";

/** Fixed copy per code. The tracker's own `error` text is never shown. */
export const FAILURE_COPY: Record<FeeFailureCode, string> = {
  refused: "The tracker refused this change.",
  no_rules: "No fee rules are available for this custodian.",
  log_not_configured: "The reimbursement log is not configured.",
  log_unavailable: "The reimbursement log could not be read.",
  log_failed: "The reimbursement could not be logged.",
  credit_request_id_not_stored: "The reimbursement was not logged because its request ID could not be stored on this ACAT.",
  log_row_retained: "Reimbursement logged, but the request ID could not be linked to this ACAT",
  rate_limited: "Too many changes at once — wait a minute and try again.",
  unauthorized: "AoA is not allowed to change fees in the tracker.",
  not_found: "The tracker could not find this transfer or fee route.",
  internal_error: "The tracker could not complete this change.",
  transport: "The tracker did not answer — try again.",
  off: "The fee section is turned off.",
  forbidden: "You do not have access to change fees.",
  invalid: "This change could not be sent.",
};

const KNOWN_CODES = new Set<string>(Object.keys(FAILURE_COPY));

/** Any code outside the contract reads as a transport failure. */
export function normalizeFailureCode(code: unknown): FeeFailureCode {
  return typeof code === "string" && KNOWN_CODES.has(code) ? (code as FeeFailureCode) : "transport";
}

export type FeeAction = "save" | "apply" | "log" | "load";

/** Codes after which a log row may exist that the section cannot see. */
export const LOG_UNCERTAIN_CODES: ReadonlySet<FeeFailureCode> = new Set<FeeFailureCode>([
  "transport", "internal_error", "log_row_retained",
]);

export function feeFailureMessage(action: FeeAction, code: unknown): { title: string; message: string } {
  const copy = FAILURE_COPY[normalizeFailureCode(code)];
  if (action === "save") return { title: FEE_COPY.saveTitle, message: `${FEE_COPY.saveMessage}. ${copy}` };
  if (action === "apply") return { title: FEE_COPY.applyTitle, message: `${FEE_COPY.applyMessage}. ${copy}` };
  if (action === "log") return { title: FEE_COPY.logFailTitle, message: copy };
  return { title: FEE_COPY.saveTitle, message: copy };
}

/** Missing, free-form or malformed amounts are unknown, never an inferred zero. */
export function parseFeeAmount(value: string | null | undefined): number | null {
  const text = value?.trim().replace(/^\$\s*/, "") ?? "";
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const amount = Number(text.replaceAll(",", ""));
  return Number.isFinite(amount) ? amount : null;
}

export type FeeChargeState = "charged" | "no-fee" | "pending" | "review";

/** Only the stored charged flag and actual amount establish a charge. */
export function feeChargeState(fee: Pick<TransferFee, "feeCharged" | "feeAmount"> | null | undefined): FeeChargeState {
  const flag = fee?.feeCharged?.trim().toLowerCase() ?? "";
  const amount = parseFeeAmount(fee?.feeAmount);
  if (flag === "no" && amount === null && fee?.feeAmount?.trim()) return "review";
  if ((flag === "no" && amount !== null && amount > 0) || (flag === "yes" && amount === 0)) return "review";
  if (flag === "yes" || (amount !== null && amount > 0)) return "charged";
  if ((flag === "no" || amount === 0) && (!flag || flag === "no")) return "no-fee";
  return "pending";
}

type OperationalShape = { direction?: string | null; type?: string | null; transferWorkflow?: string | null };

/** The tracker's `defaultFeeCharged(record) === "Yes"`: DRS never; otherwise a Full outgoing transfer. */
export function isFullOutgoing(record: OperationalShape): boolean {
  if (record.transferWorkflow?.trim().toUpperCase() === "DRS") return false;
  return record.direction?.trim().toLowerCase() === "out" && record.type?.trim().toLowerCase() === "full";
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["Completed", "Rejected", "Purged", "Canceled", "Deferred"]);

export type HeaderBadge = { label: "Fee Charged" | "No Fee" | "Pending" | "Unavailable" | "Review needed"; tone: "warning" | "success" | "neutral" };

export function headerBadge({ state, unavailable = false }: { state: FeeChargeState; unavailable?: boolean }): HeaderBadge {
  if (unavailable) return { label: "Unavailable", tone: "neutral" };
  if (state === "review") return { label: "Review needed", tone: "warning" };
  if (state === "charged") return { label: "Fee Charged", tone: "warning" };
  if (state === "no-fee") return { label: "No Fee", tone: "success" };
  return { label: "Pending", tone: "neutral" };
}

export function selectedTotals(rules: readonly FeeRule[], selectedIds: ReadonlySet<string>): {
  total: number; hasUnknownAmount: boolean; requiresAmountConfirmation: boolean; feeAmount: string | null; feeMemo: string; feeCharged: "Yes" | "No" | null;
} {
  const chosen = rules.filter((rule) => selectedIds.has(rule.id));
  const knownAmount = (rule: FeeRule) => rule.amount != null && Number.isFinite(rule.amount) && rule.amount >= 0;
  const total = chosen.reduce((sum, rule) => sum + (knownAmount(rule) ? rule.amount! : 0), 0);
  const hasUnknownAmount = chosen.some((rule) => !knownAmount(rule));
  const requiresAmountConfirmation = hasUnknownAmount || chosen.some((rule) => Boolean(rule.amountText?.trim()));
  const feeMemo = chosen
    .map((rule) => `${rule.feeType}: ${rule.amount != null ? `$${rule.amount.toFixed(2)}` : (rule.amountText ?? "?")}`)
    .join(" + ");
  return {
    total, hasUnknownAmount, requiresAmountConfirmation, feeAmount: requiresAmountConfirmation ? null : `$${total.toFixed(2)}`, feeMemo,
    feeCharged: requiresAmountConfirmation ? null : total > 0 ? "Yes" : "No",
  };
}

export type StatusStyle = { tone: "warning" | "info" | "success" | "danger"; icon: "clock" | "dot" | "check" | "ban" };

/** Pending warning, Approved info, Credited success, Denied danger; unknown reads as Pending. */
export const STATUS_STYLE: Record<FeeLogStatus, StatusStyle> = {
  Pending: { tone: "warning", icon: "clock" },
  Approved: { tone: "info", icon: "dot" },
  Credited: { tone: "success", icon: "check" },
  Denied: { tone: "danger", icon: "ban" },
};

export function statusStyle(status: string | null | undefined): { status: FeeLogStatus; style: StatusStyle } {
  const known = (FEE_LOG_STATUSES as readonly string[]).includes(status ?? "") ? (status as FeeLogStatus) : "Pending";
  return { status: known, style: STATUS_STYLE[known] };
}

export function ruleDetail(rule: FeeRule): string {
  return [
    rule.accountType !== "ANY" ? rule.accountType : null,
    rule.transferType !== "ANY" ? rule.transferType : null,
    rule.direction !== "ANY" ? `Direction ${rule.direction}` : null,
    rule.notes,
  ].filter(Boolean).join(" · ") || FEE_COPY.anyAccount;
}

export function ruleAmountLabel(rule: FeeRule): string {
  return rule.amount != null ? `$${rule.amount.toFixed(2)}` : rule.amountText ?? "—";
}

export function isFeeField(value: unknown): value is FeeField {
  return typeof value === "string" && (FEE_FIELD_KEYS as readonly string[]).includes(value);
}

export function validRecordId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length < FEE_RECORD_ID_MAX;
}

export function validRuleIds(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length >= 1 && value.length <= FEE_RULE_COUNT_MAX
    && value.every((id) => typeof id === "string" && id !== "" && id.length <= FEE_RULE_ID_MAX)
    && new Set(value).size === value.length;
}

/** What the server actions hand the client. `log: null` means the log could not be read. */
export type FeeActionResult =
  | { ok: true; fee: TransferFee; log: FeeLogRow[] | null }
  | { ok: false; code: FeeFailureCode; fee: TransferFee | null; log: FeeLogRow[] | null };

export type FeeRulesResult = { ok: true; rules: FeeRule[] } | { ok: false; reason: "off" | "forbidden" | "unavailable" };

/** The two stored values the Mark Complete dialog's Fee review line is built from. */
export type FeeSnapshot = Pick<TransferFee, "feeCharged" | "feeAmount">;

function blankToNull(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text === "" ? null : text;
}

/** The label inputs of a stored fee, with blank values as null. */
export function feeSnapshotOf(fee: FeeSnapshot): FeeSnapshot {
  return { feeCharged: blankToNull(fee.feeCharged), feeAmount: blankToNull(fee.feeAmount) };
}

/** True when both snapshots would produce the same Fee review label inputs; a missing snapshot reads as empty. */
export function sameFeeSnapshot(a: FeeSnapshot | null | undefined, b: FeeSnapshot | null | undefined): boolean {
  return (a?.feeCharged ?? null) === (b?.feeCharged ?? null) && (a?.feeAmount ?? null) === (b?.feeAmount ?? null);
}
