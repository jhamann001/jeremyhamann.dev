import type { AcatListRow } from "./acat-status";
import {
  acatBookHue, humanizeStatus, resolveAcatStatus, UNKNOWN_STATUS_LABEL, type AcatBookHue,
} from "./acat-status-catalog";
import type { AcatWorkspaceView } from "./acat-workspace-contract";

/** Fee requests keep the tracker's masked account, including when the
 *  operations book row carries the full number. Already-masked values are stable. */
export function maskBookAccountForFee(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= 4) return "****";
  return `${"*".repeat(Math.min(8, normalized.length - 4))}${normalized.slice(-4)}`;
}

export const ACAT_BOOK_LIST_QUERY = "book=full";
export const ACAT_BOOK_REMOVED_QUERY = "book=full&removed=only";
export const ACAT_BOOK_REMOVED_LABEL = "Removed";
export const ACAT_BOOK_REMOVED_EMPTY = "No removed transfers.";

export const ACAT_BOOK_LOAD_FAILURE = "Unable to load transfers — try again";
export const ACAT_BOOK_EMPTY_MATCH = "No transfers match.";
export const ACAT_BOOK_TEXT_LOAD_FAILURE = "Notes and trade instructions could not be loaded.";

export type AcatBookRow = AcatListRow & {
  wealthAdvisor: string | null;
  crmDealId: string | null;
  tradeInstructionsBlank: boolean;
  notes: string | null;
  tradeInstructions: string | null;
  custodianName: string;
  textLoadError: string | null;
  feeCharged: string | null;
  feeRequestCompleted: string | null;
  hasIssue: boolean;
  removedAt: string | null;
  records?: Partial<Record<AcatBookRecordKey, AcatBookRecordValue>>;
};

// The tracker records-list values the book read returns flat on each row
// (tracker `BOOK_RECORD_COLUMN_KEYS`, same order).
export const ACAT_BOOK_RECORD_KEYS = [
  "cedarRidgeUserId", "cedarRidgeUserIds", "needsClientLink", "custodianId", "methodRequested",
  "transferWorkflow", "crwEe", "associatedControlNumber", "originalClientRequestDate",
  "opsSubmissionDateToApex", "apexCompletionDate", "residualMonitoringRequired", "residualFollowUpDate",
  "feeAmount", "feeMemo", "feeRequestSubmitted", "feeApexTicket", "feeCreditRequestId", "crmTicket",
  "apexTicket", "rejectionReason", "additionalResources", "tradeRequestId", "tradeRequestUrl",
  "mappingSource", "apexSource", "reconCompletedAt", "daysOpen", "issueCount", "reconStatus",
  "expectedCompletionDate",
] as const;
export type AcatBookRecordKey = (typeof ACAT_BOOK_RECORD_KEYS)[number];
export type AcatBookRecordValue = string | number | boolean | null;

function scalar(v: unknown): AcatBookRecordValue {
  if (typeof v === "string" || typeof v === "boolean") return v;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}
function amount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function flag(v: unknown): boolean {
  return v === true;
}

export function mapAcatBookRow(raw: unknown): AcatBookRow | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = text(r.id);
  if (!id) return null;
  const m = (r.assetMap ?? {}) as Record<string, unknown>;
  return {
    id,
    acatTransferId: text(r.acatTransferId) ?? "",
    clientName: text(r.clientName),
    controlNumber: text(r.controlNumber),
    direction: text(r.direction),
    type: text(r.type),
    accountType: text(r.accountType),
    status: text(r.status),
    transferringContra: text(r.transferringContra),
    statementAmount: amount(r.statementAmount),
    acatDate: text(r.acatDate),
    lastActivityAt: text(r.lastActivityAt),
    apexAccountId: text(r.apexAccountId),
    statementAccountNumber: text(r.statementAccountNumber),
    dtccNumber: text(r.dtccNumber),
    assetMap: {
      total: amount(m.total), mapped: amount(m.mapped), unmapped: amount(m.unmapped),
      pending: amount(m.pending), expected: amount(m.expected),
    },
    wealthAdvisor: text(r.wealthAdvisor),
    crmDealId: text(r.crmDealId),
    tradeInstructionsBlank: flag(r.tradeInstructionsBlank),
    notes: Object.prototype.hasOwnProperty.call(r, "notes") ? text(r.notes) : null,
    tradeInstructions: Object.prototype.hasOwnProperty.call(r, "tradeInstructions") ? text(r.tradeInstructions) : null,
    custodianName: text(r.custodianName) ?? "",
    textLoadError: Object.prototype.hasOwnProperty.call(r, "notes") && Object.prototype.hasOwnProperty.call(r, "tradeInstructions")
      ? null
      : ACAT_BOOK_TEXT_LOAD_FAILURE,
    feeCharged: text(r.feeCharged),
    feeRequestCompleted: text(r.feeRequestCompleted),
    hasIssue: flag(r.hasIssue),
    removedAt: text(r.removedAt),
    records: Object.fromEntries(ACAT_BOOK_RECORD_KEYS.map((key) => [key, scalar(r[key])])),
  };
}

export type AcatTrackingSurface = "legacy" | "library" | "book";

export function acatTrackingSurface(bookEnabled: boolean, view: AcatWorkspaceView): AcatTrackingSurface {
  if (!bookEnabled) return "legacy";
  return view === "library" ? "library" : "book";
}

export const COLLAPSED_BOOK_LABELS: ReadonlySet<string> = new Set([
  "Completed", "Rejected", "Purged", "Canceled", "Deferred",
]);

const WAITING_FOR_STATEMENT = "WaitingForStatement";
const WAITING_FOR_STATEMENT_ORDER = 3.5;
const UNKNOWN_BOOK_ORDER = 999;

export type AcatBookStatus = { label: string; hue: AcatBookHue; collapsed: boolean; order: number };

export function resolveAcatBookStatus(raw: string | null | undefined): AcatBookStatus {
  const key = (raw ?? "").trim();
  const hue = acatBookHue(key);
  if (key === "") return { label: UNKNOWN_STATUS_LABEL, hue, collapsed: false, order: UNKNOWN_BOOK_ORDER };
  if (key === WAITING_FOR_STATEMENT) {
    return { label: "Waiting for Statement", hue, collapsed: false, order: WAITING_FOR_STATEMENT_ORDER };
  }
  const meta = resolveAcatStatus(key);
  const label = meta.known ? meta.label : humanizeStatus(key);
  return { label, hue, collapsed: COLLAPSED_BOOK_LABELS.has(label), order: meta.known ? meta.order : UNKNOWN_BOOK_ORDER };
}

export type AcatBookGroup = {
  label: string;
  hue: AcatBookHue;
  collapsedByDefault: boolean;
  count: number;
  rows: AcatBookRow[];
};

function recency(row: AcatBookRow): string {
  return row.lastActivityAt ?? row.acatDate ?? "";
}

export function bookGroup(rows: readonly AcatBookRow[]): AcatBookGroup[] {
  const buckets = new Map<string, { status: AcatBookStatus; rows: AcatBookRow[] }>();
  for (const row of rows) {
    const status = resolveAcatBookStatus(row.status);
    const bucket = buckets.get(status.label);
    if (bucket) bucket.rows.push(row);
    else buckets.set(status.label, { status, rows: [row] });
  }
  return [...buckets.values()]
    .sort((a, b) => a.status.order - b.status.order || a.status.label.localeCompare(b.status.label))
    .map(({ status, rows: groupRows }) => ({
      label: status.label,
      hue: status.hue,
      collapsedByDefault: status.collapsed,
      count: groupRows.length,
      rows: [...groupRows].sort((a, b) => recency(b).localeCompare(recency(a))),
    }));
}

export type AcatBookFilter = "all" | "active" | "mine" | "issues" | "fee" | "instructions";

export const ACAT_BOOK_FILTERS: ReadonlyArray<{ id: AcatBookFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "mine", label: "My Queue" },
  { id: "issues", label: "Issues" },
  { id: "fee", label: "Fee to Submit" },
  { id: "instructions", label: "Missing Trade Instructions" },
];

const TERMINAL_STATUSES = new Set(["Completed", "Rejected", "Purged", "Canceled", "Deferred"]);
const FEE_EXCLUDED = new Set(["Rejected", "Purged"]);
const INSTRUCTIONS_EXCLUDED = new Set(["Rejected", "Purged", "Canceled", "Deferred"]);

function lower(v: string | null): string {
  return (v ?? "").trim().toLowerCase();
}
function rawStatus(row: AcatBookRow): string {
  return (row.status ?? "").trim();
}
function isResidual(row: AcatBookRow): boolean {
  return lower(row.type) === "residual credit";
}

function needsFeeSubmission(row: AcatBookRow): boolean {
  if (isResidual(row) || FEE_EXCLUDED.has(rawStatus(row))) return false;
  const charged = lower(row.feeCharged) === "yes"
    || (lower(row.direction) === "out" && lower(row.type) === "full");
  return charged && !row.feeRequestCompleted;
}

function needsTradeInstructions(row: AcatBookRow): boolean {
  if (isResidual(row) || INSTRUCTIONS_EXCLUDED.has(rawStatus(row))) return false;
  const type = lower(row.type);
  return (type === "full" || type === "partial") && row.tradeInstructionsBlank;
}

function matchesFilter(row: AcatBookRow, filter: AcatBookFilter, userName: string): boolean {
  switch (filter) {
    case "all": return true;
    case "active": return !TERMINAL_STATUSES.has(rawStatus(row));
    case "mine": return lower(row.wealthAdvisor).includes(userName);
    case "issues": return row.hasIssue;
    case "fee": return needsFeeSubmission(row);
    case "instructions": return needsTradeInstructions(row);
  }
}

function matchesQuery(row: AcatBookRow, query: string, custodianSearch: boolean): boolean {
  if (query === "") return true;
  const fields = [
    row.clientName, row.controlNumber, row.crmDealId, row.apexAccountId,
    row.statementAccountNumber, row.transferringContra, row.wealthAdvisor,
    row.direction, row.status, resolveAcatBookStatus(row.status).label,
  ];
  if (custodianSearch) fields.push(row.custodianName);
  return fields.some((field) => lower(field).includes(query));
}

export function applyAcatBookFilter(
  rows: readonly AcatBookRow[],
  filter: AcatBookFilter,
  query: string,
  userName: string | null,
  custodianSearch = false,
): AcatBookRow[] {
  const user = lower(userName);
  if (filter === "mine" && user === "") return [];
  const q = query.trim().toLowerCase();
  return rows.filter((row) => matchesFilter(row, filter, user) && matchesQuery(row, q, custodianSearch));
}

export const ACAT_BOOK_COLUMNS = [
  { id: "client", label: "Client" },
  { id: "account", label: "Account" },
  { id: "status", label: "Status" },
  { id: "contra", label: "Contra" },
  { id: "direction", label: "Direction" },
  { id: "type", label: "Type" },
  { id: "date", label: "ACAT date" },
  { id: "link", label: "Link" },
] as const;
export type AcatBookColumn = (typeof ACAT_BOOK_COLUMNS)[number]["id"];
export type AcatBookDensity = "comfortable" | "compact";
export type AcatBookPrefs = { columns: AcatBookColumn[]; density: AcatBookDensity };

const ALL_COLUMNS: AcatBookColumn[] = ACAT_BOOK_COLUMNS.map((c) => c.id);

export const ACAT_BOOK_PREFS_KEY_PREFIX = "aoa.acat-book.view.v1.";

export function parseAcatBookPrefs(raw: string | null | undefined): AcatBookPrefs {
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const p = (parsed ?? {}) as { columns?: unknown; density?: unknown };
  const stored = Array.isArray(p.columns) ? p.columns : [];
  const columns = ALL_COLUMNS.filter((id) => stored.includes(id));
  return {
    columns: columns.length > 0 ? columns : [...ALL_COLUMNS],
    density: p.density === "compact" ? "compact" : "comfortable",
  };
}

// Tracker records-list columns (tracker `RECORD_FIELDS`, same order), then
// AoA's Link column. Shown only while the column chooser flag is on.
export const TRANSFER_TRACKER_COLUMNS = [
  { id: "id", label: "ID", type: "text" },
  { id: "cedarRidgeUserId", label: "Cedar Ridge User ID", type: "text" },
  { id: "cedarRidgeUserIds", label: "Cedar Ridge User IDs", type: "text" },
  { id: "needsClientLink", label: "Needs client link", type: "boolean" },
  { id: "clientName", label: "Client", type: "text" },
  { id: "status", label: "Status", type: "enum" },
  { id: "transferringContra", label: "Contra", type: "text" },
  { id: "custodianName", label: "Custodian", type: "text" },
  { id: "custodianId", label: "Custodian ID", type: "text" },
  { id: "direction", label: "Direction", type: "enum" },
  { id: "type", label: "Type", type: "enum" },
  { id: "accountType", label: "Account Type", type: "enum" },
  { id: "methodRequested", label: "Method Requested", type: "multiselect" },
  { id: "transferWorkflow", label: "Transfer Workflow", type: "enum" },
  { id: "wealthAdvisor", label: "Advisor", type: "enum" },
  { id: "crwEe", label: "CRW EE?", type: "enum" },
  { id: "controlNumber", label: "Control #", type: "text" },
  { id: "associatedControlNumber", label: "Associated Control #", type: "text" },
  { id: "acatTransferId", label: "ACAT Transfer ID", type: "text" },
  { id: "apexAccountId", label: "Apex Acct", type: "text" },
  { id: "statementAccountNumber", label: "Statement Account #", type: "text" },
  { id: "statementAmount", label: "Statement Amount", type: "number" },
  { id: "dtccNumber", label: "DTCC #", type: "text" },
  { id: "acatDate", label: "ACAT Reference Date", type: "date" },
  { id: "originalClientRequestDate", label: "Original Client Request Date", type: "date" },
  { id: "opsSubmissionDateToApex", label: "Ops Submission Date to Apex", type: "date" },
  { id: "apexCompletionDate", label: "Apex Completion Date", type: "date" },
  { id: "residualMonitoringRequired", label: "Monitor for Residual", type: "boolean" },
  { id: "residualFollowUpDate", label: "Residual Follow-Up Date", type: "date" },
  { id: "lastUpdated", label: "Last Updated", type: "date" },
  { id: "feeCharged", label: "Fee Charged", type: "enum" },
  { id: "feeAmount", label: "Fee Amount", type: "text" },
  { id: "feeMemo", label: "Fee Memo", type: "text" },
  { id: "feeRequestSubmitted", label: "Fee Request Submitted", type: "date" },
  { id: "feeRequestCompleted", label: "Fee Request Completed", type: "date" },
  { id: "feeApexTicket", label: "Fee Apex Ticket", type: "text" },
  { id: "feeCreditRequestId", label: "Fee Credit Req ID", type: "text" },
  { id: "crmTicket", label: "CRM Ticket", type: "text" },
  { id: "crmDealId", label: "CRM Deal ID", type: "text" },
  { id: "apexTicket", label: "Apex Ticket", type: "text" },
  { id: "rejectionReason", label: "Rejection Reason", type: "text" },
  { id: "additionalResources", label: "Additional Resources", type: "text" },
  { id: "tradeRequestId", label: "Trade Request ID", type: "text" },
  { id: "tradeRequestUrl", label: "Trade Request Link", type: "text" },
  { id: "tradeInstructions", label: "Trade Instructions", type: "text" },
  { id: "notes", label: "Notes", type: "text" },
  { id: "mappingSource", label: "Mapping Source", type: "text" },
  { id: "apexSource", label: "Apex Source", type: "text" },
  { id: "deletedAt", label: "Deleted At", type: "date" },
  { id: "reconCompletedAt", label: "Recon Completed At", type: "date" },
  { id: "daysOpen", label: "Days Open", type: "number" },
  { id: "assetCount", label: "Assets", type: "number" },
  { id: "issueCount", label: "Issues", type: "number" },
  { id: "reconStatus", label: "Recon", type: "enum" },
  { id: "expectedCompletionDate", label: "Expected Completion", type: "date" },
  { id: "link", label: "Link", type: "text" },
] as const;
export type TransferTrackerColumn = (typeof TRANSFER_TRACKER_COLUMNS)[number]["id"];
export type TransferTrackerColumnEntry = (typeof TRANSFER_TRACKER_COLUMNS)[number];

export const TRANSFER_TRACKER_DEFAULT_COLUMNS: readonly TransferTrackerColumn[] = [
  "clientName", "status", "transferringContra", "direction", "wealthAdvisor", "controlNumber",
  "apexAccountId", "statementAmount", "acatDate", "daysOpen", "assetCount", "issueCount", "reconStatus",
];

const ALL_TRACKER_COLUMNS: TransferTrackerColumn[] = TRANSFER_TRACKER_COLUMNS.map((c) => c.id);

// A different key from the View preferences, so a View save never counts as a column set.
export const ACAT_BOOK_COLUMNS_KEY_PREFIX = "aoa.acat-book.columns.v1.";
export const ACAT_COLUMNS_NO_MATCH = "No matching columns.";

export function parseAcatBookColumns(raw: string | null | undefined): TransferTrackerColumn[] {
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  if (!Array.isArray(parsed)) return [...TRANSFER_TRACKER_DEFAULT_COLUMNS];
  const stored: unknown[] = parsed;
  return ALL_TRACKER_COLUMNS.filter((id) => stored.includes(id));
}

export function loadAcatBookColumns(storage: Pick<Storage, "getItem">, scope: string): TransferTrackerColumn[] {
  return parseAcatBookColumns(storage.getItem(ACAT_BOOK_COLUMNS_KEY_PREFIX + scope));
}

export function saveAcatBookColumns(
  storage: Pick<Storage, "setItem">, scope: string, columns: readonly TransferTrackerColumn[],
): void {
  storage.setItem(ACAT_BOOK_COLUMNS_KEY_PREFIX + scope, JSON.stringify(columns));
}

export function resetTrackerColumns(): TransferTrackerColumn[] {
  return [...TRANSFER_TRACKER_DEFAULT_COLUMNS];
}

export function toggleTrackerColumn(columns: readonly TransferTrackerColumn[], id: TransferTrackerColumn): TransferTrackerColumn[] {
  return columns.includes(id)
    ? columns.filter((c) => c !== id)
    : ALL_TRACKER_COLUMNS.filter((c) => c === id || columns.includes(c));
}

export function filterTrackerColumns(query: string): readonly TransferTrackerColumnEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return TRANSFER_TRACKER_COLUMNS;
  return TRANSFER_TRACKER_COLUMNS.filter((c) => c.label.toLowerCase().includes(q));
}

const EMPTY = "—";

// Tracker `dateOrEmpty`, then `formatDateMMDDYYYY`.
function trackerDay(v: unknown): string {
  if (typeof v !== "string" || v === "") return EMPTY;
  let iso = v;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const t = new Date(v);
    if (Number.isNaN(t.getTime())) return EMPTY;
    iso = t.toISOString().slice(0, 10);
  }
  const [year, month, day] = iso.split("-");
  return `${month}-${day}-${year}`;
}

// Tracker `src/lib/format.ts`.
function parseMoneyToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[$,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars)) return null;
  return Math.round(dollars * 100);
}

function formatCentsExact(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  return `${sign}$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const RECORD_DATE_KEYS: ReadonlySet<AcatBookRecordKey> = new Set([
  "originalClientRequestDate", "opsSubmissionDateToApex", "apexCompletionDate", "residualFollowUpDate",
  "feeRequestSubmitted", "reconCompletedAt", "expectedCompletionDate",
]);

function isRecordKey(column: string): column is AcatBookRecordKey {
  return (ACAT_BOOK_RECORD_KEYS as readonly string[]).includes(column);
}

/** The text the tracker records list shows for this column, with its read-only empty text. */
export function trackerCellText(column: Exclude<TransferTrackerColumn, "link">, row: AcatBookRow): string {
  if (isRecordKey(column)) {
    const v = row.records?.[column] ?? null;
    if (RECORD_DATE_KEYS.has(column)) return trackerDay(v);
    if (column === "daysOpen") return typeof v === "number" ? `${v}d` : EMPTY;
    if (column === "feeAmount") {
      if (typeof v !== "string" || !v.trim()) return EMPTY;
      const cents = parseMoneyToCents(v);
      return cents == null ? v.trim() : formatCentsExact(cents);
    }
    return v == null || v === "" ? EMPTY : String(v);
  }
  switch (column) {
    case "id": return row.id;
    case "status": return resolveAcatBookStatus(row.status).label;
    case "transferringContra": return row.transferringContra ?? (row.custodianName || EMPTY);
    case "custodianName": return row.custodianName || EMPTY;
    case "acatTransferId": return row.acatTransferId || EMPTY;
    case "direction": return row.direction ? row.direction.slice(0, 3).toUpperCase() : EMPTY;
    case "statementAmount": return row.statementAmount ? formatCentsExact(row.statementAmount) : EMPTY;
    case "acatDate": return trackerDay(row.acatDate);
    case "lastUpdated": return trackerDay(row.lastActivityAt);
    case "feeRequestCompleted": return trackerDay(row.feeRequestCompleted);
    case "deletedAt": return trackerDay(row.removedAt);
    case "assetCount": return row.assetMap.total == null ? EMPTY : String(row.assetMap.total);
    default: return row[column] ?? EMPTY;
  }
}
