// Pure, client-safe contract for the reimbursement preview and confirm in the ACAT
// drawer's fee section (ticket). The server actions, the server data layer, the
// dialog, and the tests all import from here. Nothing in this file reads a flag,
// a session, a database, or the tracker.

import { FEE_CREDIT_TYPES } from "@/lib/operations/fee-request";

export const REIMBURSEMENT_REASON_MAX = 2000;
export const REIMBURSEMENT_TICKET_COUNT_MAX = 50;
export const REIMBURSEMENT_TICKET_LENGTH_MAX = 80;
export const REIMBURSEMENT_SEARCH_MIN = 2;
export const REIMBURSEMENT_SEARCH_MAX = 80;
export const REIMBURSEMENT_SEARCH_DEBOUNCE_MS = 250;
export const REIMBURSEMENT_RECORD_ID_MAX = 200;
export const REIMBURSEMENT_PENDING_LIMIT = 10;

export const REIMBURSEMENT_FEE_TYPES: readonly string[] = FEE_CREDIT_TYPES;

/** One of the client's Apex accounts as the preview shows it. */
export type ReimbursementAccount = {
  id: string;
  label: string;
  status: string | null;
  /** True when this account's last four characters equal the transfer's masked Apex account. */
  matchesTransfer: boolean;
};

export type ReimbursementClient = {
  clientSfId: string;
  name: string;
  householdName: string | null;
  accounts: ReimbursementAccount[];
};

/** A Pending Operations Tools fee request already on file for the same client and account. */
export type PendingReimbursement = {
  id: string;
  feeAmount: string | null;
  feeTypes: string[];
  submittedAt: string;
};

export type ReimbursementClientSource = "transfer-link" | "directory" | "none" | "conflict";

export type ReimbursementPrefill = {
  client: ReimbursementClient | null;
  clientSource: ReimbursementClientSource;
  /** Set only when exactly one of the client's accounts matches the transfer's masked account. */
  accountId: string | null;
  pending: PendingReimbursement[];
};

/** What the user has in the preview. `feeAmount` and `tickets` are the text as typed. */
export type ReimbursementDraft = {
  clientSfId: string;
  accountId: string;
  feeAmount: string;
  feeTypes: string[];
  reason: string;
  tickets: string;
};

export type ReimbursementSubmitInput = ReimbursementDraft & {
  /** A version 4 UUID the dialog creates once per preview; the same key never creates a second request. */
  submissionKey: string;
};

export type ReimbursementRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | "CREDITED";

export type SubmittedReimbursement = {
  id: string;
  /** Pending for a new request; a replay of the same key reports the row's current status. */
  status: ReimbursementRequestStatus;
  /** As saved, read back after the write; null when the read-back failed (the dialog then shows what the user confirmed). */
  clientName: string | null;
  accountLabel: string | null;
  feeAmount: string | null;
  feeTypes: string[];
  submittedAt: string;
};

export type ReimbursementFailureCode =
  | "off" | "forbidden" | "invalid" | "identity" | "conflict" | "failed" | "unavailable";

export type ReimbursementField = "client" | "account" | "amount" | "feeTypes" | "reason" | "tickets";

export type ReimbursementPreviewResult =
  | { ok: true; prefill: ReimbursementPrefill }
  | { ok: false; code: ReimbursementFailureCode };

export type ReimbursementSubmitResult =
  | { ok: true; request: SubmittedReimbursement }
  | { ok: false; code: ReimbursementFailureCode; field: ReimbursementField | null };

export type ReimbursementPendingResult =
  | { ok: true; pending: PendingReimbursement[] }
  | { ok: false; code: ReimbursementFailureCode };

export const REIMBURSEMENT_COPY = {
  logReimbursement: "Log Reimbursement",
  logAnother: "Log Another Reimbursement",
  linkNote: "Log Reimbursement opens a preview. Nothing is submitted until you confirm it.",
  title: "Review Reimbursement Request",
  subtitle: "Nothing is submitted until you confirm. Every field can be edited first.",
  loading: "Loading the reimbursement details...",
  loadFailed: "The reimbursement details could not be loaded.",
  retry: "Retry",
  client: "Client",
  household: "Household",
  changeClient: "Change client",
  clientSearch: "Search for a client",
  clientSearchHint: "Type at least 2 characters of the client's name.",
  clientSearching: "Searching...",
  clientNoMatch: "No client matches.",
  clientSearchFailed: "The client search could not be completed.",
  noClient: "No client is chosen yet.",
  conflictClient: "The transfer's client link and the client directory point to different clients, so none is chosen. Choose the client.",
  directoryClient: "Prefilled from the client's Cedar Ridge user id on this transfer.",
  linkedClient: "Prefilled from the client linked to this transfer.",
  account: "Apex account",
  chooseAccount: "Choose an account",
  accountMatch: "matches this transfer",
  accountNone: "This client has no accounts on file.",
  accountHelp: "This transfer's Apex account is",
  accountNotResolved: "The account could not be resolved from this transfer. Choose the account.",
  amount: "Fee amount",
  feeTypes: "Fee types",
  reason: "Reason",
  tickets: "Relevant tickets",
  ticketsHint: "Separate references with commas or new lines.",
  pendingTitle: "Pending requests already on file for this client and account",
  pendingNote: "You can still submit another request.",
  pendingOpen: "Open",
  confirm: "Confirm and Submit",
  confirming: "Submitting...",
  cancel: "Cancel",
  closePreview: "Close preview",
  successTitle: "Reimbursement Submitted",
  successBody: "A Pending fee request was created in Operations Tools.",
  successOpen: "Open this request in Operations Tools",
} as const;

export const REIMBURSEMENT_FAILURE_COPY: Record<ReimbursementFailureCode, string> = {
  off: "Reimbursement requests are turned off.",
  forbidden: "You do not have access to submit reimbursement requests.",
  invalid: "Check the marked fields and try again.",
  identity: "The client or account could not be verified. Choose the client and account again.",
  conflict: "A request from this form was already submitted with different values. Review it in Operations Tools before submitting another.",
  failed: "The request could not be submitted. Try again; submitting again will not create a second request from this form.",
  unavailable: "The reimbursement details are not available right now.",
};

export const REIMBURSEMENT_FIELD_COPY: Record<ReimbursementField, string> = {
  client: "Choose a client.",
  account: "Choose one of the client's accounts.",
  amount: "Enter a fee amount greater than zero with no more than two decimal places.",
  feeTypes: "Choose at least one fee type.",
  reason: `Keep the reason to ${REIMBURSEMENT_REASON_MAX.toLocaleString("en-US")} characters or fewer.`,
  tickets: `Use at most ${REIMBURSEMENT_TICKET_COUNT_MAX} references, each ${REIMBURSEMENT_TICKET_LENGTH_MAX} characters or fewer.`,
};

export type ReimbursementStatusChip = { label: string; tone: "warning" | "info" | "success" | "danger" | "neutral" };

/** The tracker's status hues: Pending warning, Approved info, Credited success, Rejected danger, Cancelled neutral. */
export function reimbursementStatusChip(status: ReimbursementRequestStatus): ReimbursementStatusChip {
  switch (status) {
    case "APPROVED": return { label: "Approved", tone: "info" };
    case "CREDITED": return { label: "Credited", tone: "success" };
    case "REJECTED": return { label: "Rejected", tone: "danger" };
    case "CANCELLED": return { label: "Cancelled", tone: "neutral" };
    default: return { label: "Pending", tone: "warning" };
  }
}

const SALESFORCE_ID = /^[a-zA-Z0-9]{15,18}$/;

/** The intake's own synthetic dev id grammar (`DEV-` then hyphen-separated A-Z and 0-9 groups, at most 64 characters), checked without a regular expression. */
function isSyntheticDevId(value: string): boolean {
  if (value.length < 5 || value.length > 64 || !value.startsWith("DEV-")) return false;
  const suffix = value.slice(4);
  if (suffix.startsWith("-") || suffix.endsWith("-") || suffix.includes("--")) return false;
  for (const character of suffix) {
    if (character === "-") continue;
    const code = character.charCodeAt(0);
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90))) return false;
  }
  return true;
}

export function isSalesforceId(value: unknown): value is string {
  return typeof value === "string" && SALESFORCE_ID.test(value);
}

/**
 * True for the shape of a client id the Operations Tools intake accepts: a Salesforce id, or a
 * synthetic `DEV-` id that the intake itself accepts only in the dev environment. The server
 * re-checks the environment; this is the browser's earlier, looser check.
 */
export function isClientSfId(value: unknown): value is string {
  return isSalesforceId(value) || (typeof value === "string" && isSyntheticDevId(value));
}

/** The last four letters or digits of a masked Apex account such as `********ZHLK`, or null. */
export function maskedAccountSuffix(masked: string | null | undefined): string | null {
  const match = /([A-Za-z0-9]{4})$/.exec((masked ?? "").trim());
  return match ? match[1].toUpperCase() : null;
}

/** True when a full Apex account number ends with the transfer's masked suffix. */
export function accountNumberMatchesSuffix(accountNumber: string | null | undefined, suffix: string | null): boolean {
  if (!suffix) return false;
  return (accountNumber ?? "").trim().toUpperCase().endsWith(suffix);
}

/** ACAT in for an incoming transfer, ACAT out for an outgoing one; empty when the direction is unknown. */
export function defaultReimbursementFeeTypes(direction: string | null | undefined): string[] {
  const value = (direction ?? "").trim().toLowerCase();
  if (value === "in") return ["ACAT in"];
  if (value === "out") return ["ACAT out"];
  return [];
}

export function defaultReimbursementReason(input: {
  recordId: string;
  controlNumber: string | null;
  contraName: string | null;
}): string {
  const contra = input.contraName?.trim();
  const control = input.controlNumber?.trim();
  return [
    `ACAT transfer fee reimbursement${contra ? ` for the ${contra} transfer` : ""}.`,
    control ? `Control # ${control}.` : null,
    `ACAT record ${input.recordId}.`,
  ].filter(Boolean).join(" ");
}

/** The same money rule the Operations Tools intake applies (`parseMoney`): a positive amount, at most two decimals. */
export function normalizeReimbursementAmount(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().replaceAll(",", "").replace(/^\$/, "");
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents <= 0n || cents > 99_999_999_999_999n) return null;
  return `${BigInt(match[1])}.${(match[2] ?? "").padEnd(2, "0")}`;
}

/** Comma or newline separated ticket references, trimmed and without repeats. */
export function parseReimbursementTickets(text: string | null | undefined): string[] {
  return [...new Set(String(text ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean))];
}

/** The fields that block Confirm, each with its fixed copy. Empty means the draft may be confirmed. */
export function reimbursementDraftErrors(draft: ReimbursementDraft, clientAccountIds: readonly string[]): Partial<Record<ReimbursementField, string>> {
  const errors: Partial<Record<ReimbursementField, string>> = {};
  if (!isClientSfId(draft.clientSfId)) errors.client = REIMBURSEMENT_FIELD_COPY.client;
  if (!draft.accountId || !clientAccountIds.includes(draft.accountId)) errors.account = REIMBURSEMENT_FIELD_COPY.account;
  if (normalizeReimbursementAmount(draft.feeAmount) === null) errors.amount = REIMBURSEMENT_FIELD_COPY.amount;
  const allowed = new Set<string>(REIMBURSEMENT_FEE_TYPES);
  if (draft.feeTypes.length === 0 || draft.feeTypes.some((type) => !allowed.has(type))) {
    errors.feeTypes = REIMBURSEMENT_FIELD_COPY.feeTypes;
  }
  if (draft.reason.trim().length > REIMBURSEMENT_REASON_MAX) errors.reason = REIMBURSEMENT_FIELD_COPY.reason;
  const tickets = parseReimbursementTickets(draft.tickets);
  if (tickets.length > REIMBURSEMENT_TICKET_COUNT_MAX
    || tickets.some((ticket) => ticket.length > REIMBURSEMENT_TICKET_LENGTH_MAX || /[\u0000-\u001f]/.test(ticket))) {
    errors.tickets = REIMBURSEMENT_FIELD_COPY.tickets;
  }
  return errors;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A fresh version 4 UUID for one preview (Web Crypto; `randomUUID` needs a secure context, so it falls back to random bytes). */
export function newSubmissionKey(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isSubmissionKey(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID_V4.test(value);
}

export function validReimbursementRecordId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length < REIMBURSEMENT_RECORD_ID_MAX;
}

export function validCedarRidgeUserHint(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length >= 1 && value.length <= 120 && !/[\u0000-\u001f]/.test(value));
}

export function validMaskedAccountHint(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length >= 1 && value.length <= 64 && !/[\u0000-\u001f]/.test(value));
}

/** The destination for one request in Operations Tools (the page's own `request` parameter). */
export function reimbursementRequestHref(base: string, requestId: string): string {
  return `${base}?request=${encodeURIComponent(requestId)}#request-${encodeURIComponent(requestId)}`;
}
