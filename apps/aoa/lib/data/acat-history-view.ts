import { resolveAcatBookStatus } from "@/lib/data/acat-book";

// Field history on the open transfer (ticket). A port of the Transfer Tracker's
// RecordHistoryTab (tracker `src/components/RecordHistoryTab.tsx`): same copy,
// same field labels, same value rendering, same headline per action. Pure and
// client-safe: no server-only import.

export type HistoryEntry = {
  id: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  performedBy: string | null;
  timestamp: string;
};

export type HistoryResult =
  | { ok: true; entries: HistoryEntry[] }
  | { ok: false; reason: "off" | "forbidden" | "invalid" | "unavailable" };

/** The tracker returns at most this many changes and no paging; mirrored here. */
export const HISTORY_LIMIT = 100;

export const HISTORY_TEXT = {
  title: "History",
  listLabel: "Record change history",
  loading: "Loading history…",
  empty: "No recorded changes yet",
  emptyHint: "Future edits will appear here with who made them.",
  failure: "History could not be loaded.",
  retry: "Try again",
  blank: "blank",
  system: "System",
} as const;

// Tracker `RECORD_S` keys and labels (`src/lib/record-fields.ts`, tracker `main`,
// checked 2026-10-13). `test/acat-history-view.test.ts` pins this table to the
// book's TRANSFER_TRACKER_COLUMNS so the two cannot drift.
const FIELD_LABELS: Readonly<Record<string, string>> = {
  id: "ID", cedarRidgeUserId: "Cedar Ridge User ID", cedarRidgeUserIds: "Cedar Ridge User IDs",
  needsClientLink: "Needs client link", clientName: "Client", status: "Status",
  transferringContra: "Contra", custodianName: "Custodian", custodianId: "Custodian ID",
  direction: "Direction", type: "Type", accountType: "Account Type",
  methodRequested: "Method Requested", transferWorkflow: "Transfer Workflow",
  wealthAdvisor: "Advisor", crwEe: "CRW EE?", controlNumber: "Control #",
  associatedControlNumber: "Associated Control #", acatTransferId: "ACAT Transfer ID",
  apexAccountId: "Apex Acct", statementAccountNumber: "Statement Account #",
  statementAmount: "Statement Amount", dtccNumber: "DTCC #", acatDate: "ACAT Reference Date",
  originalClientRequestDate: "Original Client Request Date",
  opsSubmissionDateToApex: "Ops Submission Date to Apex", apexCompletionDate: "Apex Completion Date",
  residualMonitoringRequired: "Monitor for Residual", residualFollowUpDate: "Residual Follow-Up Date",
  lastUpdated: "Last Updated", feeCharged: "Fee Charged", feeAmount: "Fee Amount",
  feeMemo: "Fee Memo", feeRequestSubmitted: "Fee Request Submitted",
  feeRequestCompleted: "Fee Request Completed", feeApexTicket: "Fee Apex Ticket",
  feeCreditRequestId: "Fee Credit Req ID", crmTicket: "CRM Ticket",
  crmDealId: "CRM Deal ID", apexTicket: "Apex Ticket", rejectionReason: "Rejection Reason",
  additionalResources: "Additional Resources", tradeRequestId: "Trade Request ID",
  tradeRequestUrl: "Trade Request Link", tradeInstructions: "Trade Instructions", notes: "Notes",
  mappingSource: "Mapping Source", apexSource: "Apex Source", deletedAt: "Deleted At",
  reconCompletedAt: "Recon Completed At", daysOpen: "Days Open", assetCount: "Assets",
  issueCount: "Issues", reconStatus: "Recon", expectedCompletionDate: "Expected Completion",
};

export const HISTORY_FIELD_LABELS = FIELD_LABELS;

export function historyFieldLabel(field: string | null): string {
  if (!field) return "Record";
  return Object.hasOwn(FIELD_LABELS, field) ? FIELD_LABELS[field] : field.replace(/([A-Z])/g, " $1").trim();
}

/** The status name the ACAT book shows (`resolveAcatBookStatus`, which names WaitingForStatement "Waiting for Statement" as the tracker does). */
export function historyStatusName(raw: string): string {
  return resolveAcatBookStatus(raw).label;
}

export function historyValue(field: string | null, value: string | null): string {
  if (value == null || value === "") return HISTORY_TEXT.blank;
  if (field === "status") return historyStatusName(value);
  if (field === "residualMonitoringRequired") return value === "true" ? "Yes" : "No";
  return value;
}

const FIXED_HEADLINES: Readonly<Record<string, string>> = {
  DELETE: "Record deleted",
  RESTORE: "Record restored",
  "fee-auto-apply": "Fee schedule applied",
  "recon-auto-complete": "Security recon completed",
  "recon-auto-uncomplete": "Security recon reopened",
  "manual-form-generated": "Transfer form generated",
};

/** The headline above each change. The tracker renders it with CSS capitalize. */
export function historyHeadline(entry: Pick<HistoryEntry, "action" | "field">): string {
  if (entry.action === "update" && entry.field) return `${historyFieldLabel(entry.field)} changed`;
  if (Object.hasOwn(FIXED_HEADLINES, entry.action)) return FIXED_HEADLINES[entry.action];
  return entry.action.replace(/[-_]/g, " ");
}

/** Only an update with a field shows the old → new line. */
export function showsChange(entry: Pick<HistoryEntry, "action" | "field">): boolean {
  return entry.action === "update" && !!entry.field;
}

export function historyPerson(performedBy: string | null): string {
  return performedBy || HISTORY_TEXT.system;
}

/** "Oct 13, 2026, 10:32 AM" in the viewer's time zone, as the tracker shows it. */
export function formatHistoryTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

const nullableText = (v: unknown) => v === null || typeof v === "string";

function entryFrom(raw: unknown): HistoryEntry | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.action !== "string" || typeof r.timestamp !== "string") return null;
  if (!nullableText(r.field) || !nullableText(r.oldValue) || !nullableText(r.newValue) || !nullableText(r.performedBy)) return null;
  return {
    id: r.id, action: r.action, field: r.field as string | null, oldValue: r.oldValue as string | null,
    newValue: r.newValue as string | null, performedBy: r.performedBy as string | null, timestamp: r.timestamp,
  };
}

/**
 * Turn one tracker answer into a result. Only a 200 with a well-formed array is
 * data (an empty array is the empty state). Every other answer — a refusal, an
 * absent route, a transport failure, a malformed body — is `unavailable`, which
 * the screen shows as the failure with "Try again", never as the empty state.
 * Order is the tracker's (newest first), "read" actions are omitted as on the tracker, and its cap is kept, with no paging.
 */
export function parseHistoryResponse(status: number | null, data: unknown): HistoryResult {
  if (status !== 200 || !Array.isArray(data)) return { ok: false, reason: "unavailable" };
  const entries: HistoryEntry[] = [];
  for (const raw of data.slice(0, HISTORY_LIMIT)) {
    const entry = entryFrom(raw);
    if (!entry) return { ok: false, reason: "unavailable" };
    // The tracker already omits "read"; keep the same rule if one ever arrives.
    if (entry.action !== "read") entries.push(entry);
  }
  return { ok: true, entries };
}
