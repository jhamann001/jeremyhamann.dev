// Tracker transfer-drawer rules for the AoA book: request builders, result
// shapes, field groups, and parsers. Pure and client-safe; the server actions
// and the drawer components share it.

import {
  ACCOUNT_TYPE_OPTIONS,
  ADVISOR_OPTIONS,
  METHOD_OPTIONS,
  parseStatementCents,
  signedStatementCents,
  YES_NO_OPTIONS,
  type AcatAccountHint,
  type AcatClientResult,
  type AcatDirectoryStatus,
} from "./acat-create-contract";
import { ACAT_CLIENT_REQUIRED, writeRejectionReason } from "./acat-book-edit";

export { ACAT_EDIT_FORBIDDEN, ACAT_WRITE_UNAVAILABLE } from "./acat-book-edit";

export const ACAT_DRAWER_OFF = "The transfer drawer is turned off.";
export const ACAT_DRAWER_LOAD_FAILURE = "Could not load this transfer.";
export const ACAT_DRAWER_BLANK = "Enter a value to save.";
export const ACAT_DRAWER_MASKED = "Enter the complete account number; a masked value cannot be saved.";
export const ACAT_DRAWER_ADMIN_ONLY = "Only an admin can delete a transfer.";
export const ACAT_DRAWER_REASON_SHORT = "Reason must be at least 3 characters";
export const ACAT_DRAWER_SEARCH_FAILURE = "Client search is unavailable — try again.";
export const ACAT_EXPORT_FAILURE = "The download could not be created — try again.";
export const ACAT_DRAWER_UNKNOWN_FIELD = "This field cannot be changed here.";
export const ACAT_DRAWER_DATE = "Enter a date as YYYY-MM-DD.";

export type DrawerTransfer = {
  id: string;
  identityVersion: number | null;
  clientName: string | null;
  status: string | null;
  controlNumber: string | null;
  acatTransferId: string | null;
  direction: string | null;
  type: string | null;
  accountType: string | null;
  wealthAdvisor: string | null;
  notes: string | null;
  associatedControlNumber: string | null;
  transferWorkflow: string | null;
  crwEe: string | null;
  originalClientRequestDate: string | null;
  opsSubmissionDateToApex: string | null;
  apexCompletionDate: string | null;
  residualMonitoringRequired: boolean | null;
  residualFollowUpDate: string | null;
  crmTicket: string | null;
  crmDealId: string | null;
  apexTicket: string | null;
  additionalResources: string | null;
  tradeInstructions: string | null;
  tradeRequestId: string | null;
  tradeRequestUrl: string | null;
  rejectionReason: string | null;
  apexAccountId: string | null;
  statementAccountNumber: string | null;
  transferringContra: string | null;
  dtccNumber: string | null;
  statementAmount: number | null;
  methodRequested: string | null;
  feeCharged: string | null;
  feeAmount: string | null;
  acatDate: string | null;
  assets: { mapStatus: string }[];
};

export type DrawerFailure = {
  ok: false;
  reason: string;
  retryable: boolean;
  code?: string;
  current?: DrawerTransfer;
};
export type DrawerReadResult = { ok: true; transfer: DrawerTransfer } | DrawerFailure;
export type DrawerWriteResult = { ok: true; transfer: DrawerTransfer; removed?: boolean } | DrawerFailure;
export type DrawerContraResult = { ok: true; contras: { name: string; dtcNumber: string | null }[] } | DrawerFailure;
export type DrawerClientSearchResult =
  | { ok: true; clients: AcatClientResult[]; hasMore: boolean; directory: AcatDirectoryStatus | null }
  | DrawerFailure;
export type DtccSuggestion = { status: "none" | "suggested" | "ambiguous" | "insufficient"; dtccNumber: string | null };

export function refusal(reason: string): DrawerFailure {
  return { ok: false, reason, retryable: false };
}

const STATUS_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["WaitingForApex", "Waiting for Apex"],
  ["PendingAccountOpening", "Pending Account Opening"],
  ["WaitingOnClient", "Waiting on Client"],
  ["WaitingForStatement", "Waiting for Statement"],
  ["AcatReceived", "ACAT Received"],
  ["ToCome", "To Come"],
  ["Submitted", "Submitted"],
  ["PendingReview", "Pending Review"],
  ["PendingContraResponse", "Pending Contra Response"],
  ["Accepted", "Accepted"],
  ["PendingSettlement", "Pending Settlement"],
  ["PendingBookkeeping", "Pending Bookkeeping"],
  ["Completed", "Completed"],
  ["Rejected", "Rejected"],
  ["Purged", "Purged"],
  ["Canceled", "Canceled"],
  ["Deferred", "Deferred"],
];

export const DRAWER_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  STATUS_LABELS.map(([value, label]) => ({ value, label }));

const LEGACY_RECON_LABELS: Record<string, string> = {
  Matched: "Recon: Matched",
  Mismatch: "Recon: Mismatch",
  Pending: "Recon: Pending",
};

export function drawerStatusOptions(current: string | null): { value: string; label: string }[] {
  const legacy = current ? LEGACY_RECON_LABELS[current] : undefined;
  return current && legacy
    ? [{ value: current, label: `${legacy} (legacy)` }, ...DRAWER_STATUS_OPTIONS]
    : [...DRAWER_STATUS_OPTIONS];
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "Completed", "Rejected", "Purged", "Canceled", "Deferred",
]);

export type DrawerFieldType = "text" | "date" | "select" | "multiselect" | "contra" | "textarea";
export type DrawerFieldDef = {
  key: keyof DrawerTransfer & string;
  label: string;
  type: DrawerFieldType;
  options?: ReadonlyArray<{ value: string; label: string }>;
  route: "drawer" | "general";
};

const plain = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

const WORKFLOW_FIELD_OPTIONS = [
  { value: "ACAT", label: "ACAT (API)" },
  { value: "MANUAL", label: "Manual" },
  { value: "DRS", label: "DRS" },
  { value: "RESIDUAL", label: "Residual" },
  { value: "UNCLASSIFIED", label: "Unclassified" },
] as const;

export const TRANSFER_FIELDS: readonly DrawerFieldDef[] = [
  { key: "controlNumber", label: "Control #", type: "text", route: "general" },
  { key: "associatedControlNumber", label: "Associated Control #", type: "text", route: "drawer" },
  { key: "acatTransferId", label: "ACAT Transfer ID", type: "text", route: "drawer" },
  { key: "transferWorkflow", label: "Transfer Workflow", type: "select", options: WORKFLOW_FIELD_OPTIONS, route: "drawer" },
  { key: "direction", label: "Direction", type: "select", options: plain(["In", "Out"]), route: "drawer" },
  { key: "type", label: "Type", type: "select", options: plain(["Full", "Partial", "Residual Credit"]), route: "drawer" },
  { key: "accountType", label: "Account Type", type: "select", options: plain(ACCOUNT_TYPE_OPTIONS), route: "drawer" },
  { key: "methodRequested", label: "Request Method", type: "multiselect", options: plain(METHOD_OPTIONS), route: "drawer" },
  { key: "wealthAdvisor", label: "Advisor", type: "select", options: plain(ADVISOR_OPTIONS), route: "drawer" },
  { key: "crwEe", label: "CRW EE?", type: "select", options: plain(YES_NO_OPTIONS), route: "drawer" },
];

export const ACCOUNT_FIELDS: readonly DrawerFieldDef[] = [
  { key: "apexAccountId", label: "Apex Account #", type: "text", route: "drawer" },
  { key: "statementAccountNumber", label: "Statement Account #", type: "text", route: "drawer" },
  { key: "transferringContra", label: "Transferring Contra", type: "contra", route: "drawer" },
  { key: "dtccNumber", label: "DTCC #", type: "text", route: "drawer" },
  { key: "statementAmount", label: "Statement Amount", type: "text", route: "drawer" },
];

export const DATE_FIELDS: readonly DrawerFieldDef[] = [
  { key: "originalClientRequestDate", label: "Original Client Request Date", type: "date", route: "drawer" },
  { key: "opsSubmissionDateToApex", label: "Ops Submission Date to Apex", type: "date", route: "drawer" },
  { key: "apexCompletionDate", label: "Apex Completion Date", type: "date", route: "drawer" },
  {
    key: "residualMonitoringRequired", label: "Monitor for Residual", type: "select", route: "drawer",
    options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }],
  },
  { key: "residualFollowUpDate", label: "Residual Follow-Up Date", type: "date", route: "drawer" },
];

export const TICKET_FIELDS: readonly DrawerFieldDef[] = [
  { key: "crmTicket", label: "CRM Ticket", type: "text", route: "drawer" },
  { key: "crmDealId", label: "CRM Deal ID", type: "text", route: "drawer" },
  { key: "apexTicket", label: "Apex Ticket", type: "text", route: "drawer" },
  { key: "additionalResources", label: "Additional Resources", type: "text", route: "drawer" },
];

export const REJECTION_FIELD: DrawerFieldDef =
  { key: "rejectionReason", label: "Rejection Reason", type: "text", route: "drawer" };

export const TRADE_REQUEST_FIELDS: readonly DrawerFieldDef[] = [
  { key: "tradeInstructions", label: "Trade Instructions", type: "textarea", route: "general" },
  { key: "tradeRequestId", label: "Trade Request ID", type: "text", route: "drawer" },
  { key: "tradeRequestUrl", label: "Trade Request Link", type: "text", route: "drawer" },
];

export function ticketFields(status: string | null): readonly DrawerFieldDef[] {
  return status === "Rejected" ? [...TICKET_FIELDS, REJECTION_FIELD] : TICKET_FIELDS;
}

export const DRAWER_FIELD_KEYS = [
  "associatedControlNumber", "acatTransferId", "transferWorkflow", "direction", "type", "accountType",
  "methodRequested", "wealthAdvisor", "crwEe", "apexAccountId", "statementAccountNumber",
  "transferringContra", "dtccNumber", "statementAmount", "originalClientRequestDate",
  "opsSubmissionDateToApex", "apexCompletionDate", "residualMonitoringRequired", "residualFollowUpDate",
  "crmTicket", "crmDealId", "apexTicket", "additionalResources", "tradeRequestId",
  "tradeRequestUrl", "rejectionReason",
] as const;
export type DrawerFieldKey = (typeof DRAWER_FIELD_KEYS)[number];

const DRAWER_FIELD_SET: ReadonlySet<string> = new Set(DRAWER_FIELD_KEYS);
const DATE_KEYS: ReadonlySet<string> = new Set([
  "originalClientRequestDate", "opsSubmissionDateToApex", "apexCompletionDate", "residualFollowUpDate",
]);
const MASKED_KEYS: ReadonlySet<string> = new Set(["apexAccountId", "statementAccountNumber", "dtccNumber"]);
const VERSIONED_KEYS: ReadonlySet<string> = new Set(["apexAccountId", "acatTransferId"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isDrawerField(key: string): key is DrawerFieldKey {
  return DRAWER_FIELD_SET.has(key);
}

export function isMaskedValue(value: string): boolean {
  const first = value.trim().charAt(0);
  return first === "*" || first === "•";
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function mapDrawerTransfer(raw: unknown): DrawerTransfer | null {
  const r = (raw ?? null) as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const id = str(r.id);
  if (id === null || id.trim() === "") return null;
  const version = r.identityVersion;
  const amount = r.statementAmount;
  const assets = Array.isArray(r.assets) ? r.assets : [];
  return {
    id,
    identityVersion: typeof version === "number" && Number.isInteger(version) ? version : null,
    clientName: str(r.clientName),
    status: str(r.status),
    controlNumber: str(r.controlNumber),
    acatTransferId: str(r.acatTransferId),
    direction: str(r.direction),
    type: str(r.type),
    accountType: str(r.accountType),
    wealthAdvisor: str(r.wealthAdvisor),
    notes: str(r.notes),
    associatedControlNumber: str(r.associatedControlNumber),
    transferWorkflow: str(r.transferWorkflow),
    crwEe: str(r.crwEe),
    originalClientRequestDate: str(r.originalClientRequestDate),
    opsSubmissionDateToApex: str(r.opsSubmissionDateToApex),
    apexCompletionDate: str(r.apexCompletionDate),
    residualMonitoringRequired: typeof r.residualMonitoringRequired === "boolean" ? r.residualMonitoringRequired : null,
    residualFollowUpDate: str(r.residualFollowUpDate),
    crmTicket: str(r.crmTicket),
    crmDealId: str(r.crmDealId),
    apexTicket: str(r.apexTicket),
    additionalResources: str(r.additionalResources),
    tradeInstructions: str(r.tradeInstructions),
    tradeRequestId: str(r.tradeRequestId),
    tradeRequestUrl: str(r.tradeRequestUrl),
    rejectionReason: str(r.rejectionReason),
    apexAccountId: str(r.apexAccountId),
    statementAccountNumber: str(r.statementAccountNumber),
    transferringContra: str(r.transferringContra),
    dtccNumber: str(r.dtccNumber),
    statementAmount: typeof amount === "number" && Number.isInteger(amount) ? amount : null,
    methodRequested: str(r.methodRequested),
    feeCharged: str(r.feeCharged),
    feeAmount: str(r.feeAmount),
    acatDate: str(r.acatDate),
    assets: assets.map((a) => ({ mapStatus: str((a as { mapStatus?: unknown } | null)?.mapStatus) ?? "" })),
  };
}

export function drawerStats(transfer: DrawerTransfer, nowMs: number): {
  totalAssets: number; matched: number; issues: number; daysSince: number | null;
} {
  const days = Math.floor((nowMs - Date.parse(transfer.acatDate ?? "")) / 86400000);
  return {
    totalAssets: transfer.assets.length,
    matched: transfer.assets.filter((a) => a.mapStatus === "Mapped" || a.mapStatus === "Expected").length,
    issues: transfer.assets.filter((a) => a.mapStatus === "Unmapped").length,
    daysSince: Number.isFinite(days) ? days : null,
  };
}

export function neighbours(ids: readonly string[], id: string): {
  index: number; total: number; previous: string | null; next: string | null;
} {
  const index = ids.indexOf(id);
  return {
    index,
    total: ids.length,
    previous: index > 0 ? ids[index - 1] : null,
    next: index >= 0 && index < ids.length - 1 ? ids[index + 1] : null,
  };
}

export type DrawerRequestResult<T> = { ok: true; body: T } | { ok: false; reason: string };

export type DrawerChangeBody = {
  action: "change";
  field: DrawerFieldKey;
  value: string | number | boolean;
  expectedIdentityVersion?: number;
};

export function buildChangeRequest(
  field: string,
  value: string,
  context: { direction?: string | null; identityVersion?: number | null } = {},
): DrawerRequestResult<DrawerChangeBody> {
  if (!isDrawerField(field)) return { ok: false, reason: ACAT_DRAWER_UNKNOWN_FIELD };
  const text = (value ?? "").trim();
  if (text === "") return { ok: false, reason: ACAT_DRAWER_BLANK };
  if (MASKED_KEYS.has(field) && isMaskedValue(text)) return { ok: false, reason: ACAT_DRAWER_MASKED };
  if (DATE_KEYS.has(field) && !ISO_DATE.test(text)) return { ok: false, reason: ACAT_DRAWER_DATE };

  let sent: string | number | boolean = text;
  if (field === "statementAmount") {
    const cents = parseStatementCents(text);
    if (cents === null) return { ok: false, reason: "Invalid Statement Amount" };
    sent = signedStatementCents(cents, context.direction ?? "");
  } else if (field === "residualMonitoringRequired") {
    if (text !== "true" && text !== "false") return { ok: false, reason: ACAT_DRAWER_BLANK };
    sent = text === "true";
  }
  const version = context.identityVersion;
  return {
    ok: true,
    body: {
      action: "change",
      field,
      value: sent,
      ...(VERSIONED_KEYS.has(field) && typeof version === "number" && Number.isInteger(version)
        ? { expectedIdentityVersion: version }
        : {}),
    },
  };
}

export function buildCompleteRequest(input: {
  apexCompletionDate: string; controlNumber: string;
}): DrawerRequestResult<{ action: "complete"; apexCompletionDate: string; controlNumber: string | null }> {
  const date = (input.apexCompletionDate ?? "").trim();
  if (date === "") return { ok: false, reason: "Apex Completion Date is required to complete a transfer" };
  if (!ISO_DATE.test(date)) return { ok: false, reason: ACAT_DRAWER_DATE };
  const control = (input.controlNumber ?? "").trim();
  return { ok: true, body: { action: "complete", apexCompletionDate: date, controlNumber: control === "" ? null : control } };
}

export function buildRejectRequest(reason: string): DrawerRequestResult<{ action: "reject"; reason: string }> {
  const text = (reason ?? "").trim();
  if (text === "") return { ok: false, reason: "A rejection reason is required" };
  return { ok: true, body: { action: "reject", reason: text } };
}

export function buildDeleteRequest(reason: string): DrawerRequestResult<{ reason: string }> {
  const text = (reason ?? "").trim();
  if (text.length < 3) return { ok: false, reason: ACAT_DRAWER_REASON_SHORT };
  if (text.length > 500) return { ok: false, reason: "Reason must be 500 characters or fewer" };
  return { ok: true, body: { reason: text } };
}

export const CLIENT_IDENTITY_REASON_MAX = 2000;
const CEDAR_RIDGE_USER = /^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DrawerReplaceBody = {
  action: "replaceClient";
  relink: {
    cedarRidgeUserIds: string[];
    expectedIdentityVersion: number;
    reason: string;
    replaceDisplayName: true;
    apexAccountId?: string;
    acknowledgeMappingInvalidation?: true;
  };
};

export function buildReplaceRequest(input: {
  cedarRidgeUserIds: string[];
  expectedIdentityVersion: number | null;
  reason: string;
  apexAccountId: string;
  acknowledgeMappingInvalidation: boolean;
}): DrawerRequestResult<DrawerReplaceBody> {
  const ids = input.cedarRidgeUserIds ?? [];
  if (ids.length < 1 || ids.length > 10 || new Set(ids).size !== ids.length || !ids.every((id) => CEDAR_RIDGE_USER.test(id))) {
    return { ok: false, reason: ACAT_CLIENT_REQUIRED };
  }
  const version = input.expectedIdentityVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { ok: false, reason: "Refresh this record before linking its client." };
  }
  const reason = (input.reason ?? "").trim();
  if (reason === "") return { ok: false, reason: "Enter the reason for this change." };
  if (reason.length > CLIENT_IDENTITY_REASON_MAX) return { ok: false, reason: "Reason must be 2000 characters or fewer" };
  const account = (input.apexAccountId ?? "").trim();
  if (account !== "" && isMaskedValue(account)) return { ok: false, reason: ACAT_DRAWER_MASKED };
  return {
    ok: true,
    body: {
      action: "replaceClient",
      relink: {
        cedarRidgeUserIds: ids,
        expectedIdentityVersion: version,
        reason,
        replaceDisplayName: true,
        ...(account !== "" ? { apexAccountId: account } : {}),
        ...(input.acknowledgeMappingInvalidation ? { acknowledgeMappingInvalidation: true as const } : {}),
      },
    },
  };
}

export function drawerFailureFrom(status: number | null, body: unknown, current?: DrawerTransfer | null): DrawerFailure {
  const record = (typeof body === "object" && body !== null ? body : {}) as { code?: unknown; transfer?: unknown };
  const mapped = current ?? mapDrawerTransfer(record.transfer);
  return {
    ok: false,
    reason: writeRejectionReason(status, body),
    retryable: status === null || status >= 500 || status === 429,
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(mapped ? { current: mapped } : {}),
  };
}

const textOrNull = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);

function directoryFrom(raw: unknown): AcatDirectoryStatus | null {
  const d = (raw ?? null) as Record<string, unknown> | null;
  if (!d || typeof d.writeEligible !== "boolean" || typeof d.enabled !== "boolean"
    || typeof d.health !== "string" || typeof d.pendingAccountPolicy !== "string") return null;
  return { writeEligible: d.writeEligible, enabled: d.enabled, health: d.health, pendingAccountPolicy: d.pendingAccountPolicy };
}

export function parseClientSearch(payload: unknown): {
  clients: AcatClientResult[]; hasMore: boolean; directory: AcatDirectoryStatus | null;
} {
  const p = (payload ?? {}) as { items?: unknown; hasMore?: unknown; directory?: unknown };
  const clients = (Array.isArray(p.items) ? p.items : []).flatMap((item) => {
    const row = (item ?? {}) as { cedarRidgeUserId?: unknown; displayName?: unknown; accountHints?: unknown };
    const cedarRidgeUserId = typeof row.cedarRidgeUserId === "string" ? row.cedarRidgeUserId : "";
    const displayName = typeof row.displayName === "string" ? row.displayName.trim() : "";
    if (!CEDAR_RIDGE_USER.test(cedarRidgeUserId) || displayName === "") return [];
    const accountHints: AcatAccountHint[] = (Array.isArray(row.accountHints) ? row.accountHints : []).map((hint) => {
      const h = (hint ?? {}) as Record<string, unknown>;
      return {
        custodian: textOrNull(h.custodian),
        maskedAccountNumber: textOrNull(h.maskedAccountNumber),
        relationshipType: textOrNull(h.relationshipType),
      };
    });
    return [{ cedarRidgeUserId, displayName, accountHints }];
  });
  return { clients, hasMore: p.hasMore === true, directory: directoryFrom(p.directory) };
}

export function dtccSuggestionFrom(payload: unknown): DtccSuggestion {
  const p = (payload ?? {}) as { status?: unknown; dtccNumber?: unknown };
  const status = p.status === "suggested" || p.status === "ambiguous" || p.status === "insufficient" ? p.status : "none";
  const number = typeof p.dtccNumber === "string" && p.dtccNumber.trim() !== "" ? p.dtccNumber.trim() : null;
  return { status, dtccNumber: status === "suggested" ? number : null };
}

export function finalizeReconLabel(value: string | null | undefined): string {
  if (value === "Complete") return "Complete";
  if (value === "Needs Review") return "Needs review";
  return "Pending";
}

export function finalizeFeeLabel(transfer: Pick<DrawerTransfer, "feeCharged" | "feeAmount">): string {
  if (transfer.feeCharged === "Yes") return transfer.feeAmount || "Fee recorded";
  if (transfer.feeCharged === "No") return "No fee";
  return "Not reviewed";
}

export function formatDrawerDate(value: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return match ? `${match[2]}-${match[3]}-${match[1]}` : "";
}
