// The Transfer Tracker's record, as the demo keeps it (demo.stand_in_record, service "tracker"), and the projections
// its machine API answers with. Field names follow the tracker's AcatRecord model (apps/acat/prisma/schema.prisma)
// so the seed can write the tracker demo's own plan; the projections are ports of the tracker's redaction.ts,
// record-fields.ts and acat-derivations.ts. Pure functions: no database, no clock except where passed in.

export type MapStatus = "Mapped" | "Unmapped" | "Pending" | "Expected";

export interface TrackerAsset {
  id: string;
  symbol: string;
  description: string;
  cusip: string | null;
  expectedQty: number;
  actualQty: number;
  mapStatus: MapStatus;
  issue: string | null;
  notes: string | null;
  amount: number | null;
  assetClass: string | null;
  includeInTransfer?: boolean | null;
  mappingTransferStatus?: string | null;
  mappingTransferNotes?: string | null;
  mappingTransferring?: boolean | null;
  mappingStatementDate?: string | null;
  mappingStatementAgeDays?: number | null;
  mappingStatementIsStale?: boolean | null;
  mappingSyncedAt?: string | null;
}

export interface TrackerHistoryEntry {
  id: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  performedBy: string | null;
  timestamp: string;
}

export interface TrackerReview {
  ruleKey: string;
  fingerprint: string;
  status: "OPEN" | "IN_REVIEW" | "CLOSED";
  resolution: string | null;
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface TrackerFeeLogRow {
  id: string | null;
  status: "Pending" | "Approved" | "Credited" | "Denied";
  feeAmount: number;
  feeType: string | null;
  submissionDate: string | null;
}

/** The linked source account a recon refresh last read (the tracker's mappingAccountSummary). */
export interface TrackerMappingAccount {
  id: string;
  clientName: string;
  holder: string;
  custodian: string;
  registration: string;
  accountNumberLast4: string | null;
  investorNumberLast4: string | null;
  statementDate: string | null;
  processedAt: string | null;
  isHistorical: boolean;
  positionCount: number;
}

export interface TrackerTitleConfirmation {
  id: string;
  title: string;
  registration: string;
  confirmedBy: string;
  confirmedAt: string;
  /** The receiving fingerprint the confirmation was made against; a changed account or identity voids it. */
  fingerprint: string;
}

export interface TrackerDocument {
  id: string;
  kind: "TRANSFER_FORM";
  filename: string;
  createdBy: string;
  createdAt: string;
  sha256: string;
  /** The PDF, base64. */
  content: string;
}

export interface TrackerOperation {
  operationId: string;
  actorEmail: string;
  kind: "CONFIRM_TITLE" | "UPDATE_SCOPE" | "GENERATE";
  requestHash: string;
  documentId: string | null;
}

export interface TrackerRecord {
  id: string;
  createdAt: string;
  deletedAt: string | null;
  lastUpdated: string;
  clientName: string;
  /** The linked Cedar Ridge people (the tracker's AcatRecordClient rows), sorted. */
  cedarRidgeUserIds: string[];
  identityVersion: number;
  controlNumber: string | null;
  acatTransferId: string | null;
  direction: string | null;
  type: string | null;
  accountType: string | null;
  status: string;
  wealthAdvisor: string | null;
  apexAccountId: string;
  statementAccountNumber: string | null;
  transferringContra: string | null;
  dtccNumber: string | null;
  /** Integer cents; negative for an outgoing transfer. */
  statementAmount: number | null;
  methodRequested: string | null;
  transferWorkflow: string;
  crwEe: string | null;
  originalClientRequestDate: string | null;
  opsSubmissionDateToApex: string | null;
  apexCompletionDate: string | null;
  residualMonitoringRequired: boolean;
  residualFollowUpDate: string | null;
  feeCharged: string | null;
  feeAmount: string | null;
  feeMemo: string | null;
  feeRequestSubmitted: string | null;
  feeRequestCompleted: string | null;
  feeApexTicket: string | null;
  feeCreditRequestId: string | null;
  crmTicket: string | null;
  apexTicket: string | null;
  additionalResources: string | null;
  tradeRequestId: string | null;
  tradeRequestUrl: string | null;
  tradeInstructions: string | null;
  notes: string | null;
  associatedControlNumber: string | null;
  rejectionReason: string | null;
  crmDealId: string;
  /** AoA's custodian authority id for the delivering firm, and its name. */
  custodianId: string | null;
  custodianName: string;
  /** The custodian's expected processing days (the tracker joins its Custodian row). */
  custodianAvgProcessingDays: number | null;
  acatDate: string;
  mappingSource: string;
  mappingSyncedAt: string | null;
  mappingAccountId: string | null;
  mappingAccountSummary: TrackerMappingAccount | null;
  apexSource: string;
  reconCompletedAt: string | null;
  assets: TrackerAsset[];
  history: TrackerHistoryEntry[];
  reviews: TrackerReview[];
  feeLog: TrackerFeeLogRow[] | null;
  titleConfirmation: TrackerTitleConfirmation | null;
  documents: TrackerDocument[];
  operations: TrackerOperation[];
}

/** One person in the Cedar Ridge client directory (kind "client"), with the accounts they hold. */
export interface TrackerClient {
  cedarRidgeUserId: string;
  displayName: string;
  eligibility: "ACTIVE" | "INACTIVE";
  accounts: Array<{
    investmentAccountId: string;
    custodian: string;
    accountNumber: string | null;
    status: string | null;
    isCurrent: boolean;
    relationshipType: string | null;
  }>;
}

export const LIFECYCLE_STATUSES = [
  "WaitingForApex", "PendingAccountOpening", "WaitingOnClient", "WaitingForStatement", "AcatReceived", "ToCome",
  "Submitted", "PendingReview", "PendingContraResponse", "Accepted", "PendingSettlement", "PendingBookkeeping",
  "Completed", "Rejected", "Purged", "Canceled", "Deferred",
] as const;
export const RECON_DERIVED_STATUSES = new Set(["Matched", "Mismatch", "Pending"]);
export const TERMINAL_STATUSES = new Set(["Completed", "Rejected", "Purged", "Canceled", "Deferred"]);
const RECON_DEAD_END_STATUSES = new Set(["Rejected", "Purged", "Canceled", "Deferred"]);
const LIVE_EXCLUDED = new Set(["Canceled", "Purged", "Completed", "Rejected"]);
export const TRANSFER_WORKFLOWS = ["ACAT", "MANUAL", "DRS", "RESIDUAL", "UNCLASSIFIED"] as const;
export type TransferWorkflow = (typeof TRANSFER_WORKFLOWS)[number];
const WORKFLOW_LABELS: Record<string, string> = {
  ACAT: "ACAT (API)", MANUAL: "Manual", DRS: "DRS", RESIDUAL: "Residual", UNCLASSIFIED: "Unclassified",
};
export const DEFAULT_PROCESSING_DAYS = 7;
const DAY_MS = 86_400_000;

// --- masking and normalizing (redaction.ts, format.ts, dtcc-suggestion.ts) ---

export function maskIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (normalized.length <= 4) return "****";
  return `${"*".repeat(Math.min(8, normalized.length - 4))}${normalized.slice(-4)}`;
}

export function normalizeDtccNumber(value?: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  return trimmed.padStart(4, "0");
}

function validIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export function normalizeDateToIso(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(trimmed);
  if (iso) return validIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const mdy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(trimmed);
  if (mdy) return validIsoDate(Number(mdy[3]), Number(mdy[1]), Number(mdy[2]));
  const named = /^([a-z]+)\s+(\d{1,2}),\s*(\d{4})$/i.exec(trimmed);
  if (named) {
    const month = MONTHS[named[1].toLowerCase()];
    return month ? validIsoDate(Number(named[3]), month, Number(named[2])) : null;
  }
  return null;
}

export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (!cleaned || !/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const dollars = Number(cleaned);
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
}

export function formatCentsExact(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function normalizeMoneyStringExact(value: string | null | undefined): string | null {
  if (value == null || !value.trim()) return null;
  const cents = parseMoneyToCents(value);
  return cents == null ? null : formatCentsExact(cents);
}

export function formatDateMMDDYYYY(value: string | null | undefined): string {
  const iso = normalizeDateToIso(value);
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  return `${month}-${day}-${year}`;
}

// --- derivations (acat-derivations.ts) ---

function classifyAsset(asset: TrackerAsset, status: string): "matched" | "pending" | "mismatch" | "ignored" {
  if (RECON_DEAD_END_STATUSES.has(status)) return "ignored";
  if (asset.expectedQty === 0 && asset.actualQty === 0) return "ignored";
  if (asset.mapStatus === "Mapped" || asset.mapStatus === "Expected") return "matched";
  return asset.mapStatus === "Unmapped" ? "mismatch" : "pending";
}

export function assetCounts(record: Pick<TrackerRecord, "assets" | "status">) {
  const counts = { matched: 0, pending: 0, mismatch: 0 };
  for (const asset of record.assets) {
    const bucket = classifyAsset(asset, record.status);
    if (bucket !== "ignored") counts[bucket]++;
  }
  return counts;
}

export const issueCount = (record: Pick<TrackerRecord, "assets" | "status">) => assetCounts(record).mismatch;

export function daysOpen(record: Pick<TrackerRecord, "originalClientRequestDate" | "acatDate">, now = Date.now()): number {
  const start = new Date(record.originalClientRequestDate ?? record.acatDate).getTime();
  if (Number.isNaN(start)) return 0;
  return Math.max(0, Math.round((now - start) / DAY_MS));
}

const expectedProcessingDays = (record: Pick<TrackerRecord, "custodianAvgProcessingDays">) =>
  typeof record.custodianAvgProcessingDays === "number" && record.custodianAvgProcessingDays > 0
    ? record.custodianAvgProcessingDays : DEFAULT_PROCESSING_DAYS;

export function expectedCompletionDate(record: TrackerRecord): string | null {
  if (!record.opsSubmissionDateToApex) return null;
  const submitted = new Date(record.opsSubmissionDateToApex).getTime();
  if (Number.isNaN(submitted)) return null;
  return new Date(submitted + expectedProcessingDays(record) * DAY_MS).toISOString().slice(0, 10);
}

const hasGcpPositions = (r: TrackerRecord) => r.mappingSource === "GCP Project API" || r.mappingSource === "Mock / Local Fixture";
export const hasApexUpload = (r: Pick<TrackerRecord, "apexSource">) => r.apexSource === "Uploaded";

function reconRate(record: TrackerRecord): number {
  const c = assetCounts(record);
  const denominator = c.matched + c.mismatch + c.pending;
  return denominator === 0 ? 0 : c.matched / denominator;
}

export function reconStatus(record: TrackerRecord): "complete" | "needs_review" | "pending" {
  if (record.reconCompletedAt) return "complete";
  if (hasGcpPositions(record) && hasApexUpload(record)) return reconRate(record) >= 0.9 ? "complete" : "needs_review";
  return "pending";
}

// --- projections ---

/** The tracker's redactAcatForMachine with the drawer contract on (identity version, DTCC revealed), plus the
 *  custodian and person fields AoA's fee review reads. Account numbers masked unless `ops`. */
export function detailProjection(record: TrackerRecord, options: { ops?: boolean } = {}) {
  const account = (value: string | null) => (options.ops ? value : maskIdentifier(value));
  return {
    id: record.id,
    identityVersion: record.identityVersion,
    acatTransferId: record.acatTransferId,
    controlNumber: record.controlNumber,
    direction: record.direction,
    type: record.type,
    accountType: record.accountType,
    status: record.status,
    clientName: record.clientName,
    wealthAdvisor: record.wealthAdvisor ?? null,
    notes: record.notes ?? null,
    associatedControlNumber: record.associatedControlNumber ?? null,
    transferWorkflow: record.transferWorkflow ?? null,
    crwEe: record.crwEe ?? null,
    originalClientRequestDate: record.originalClientRequestDate ?? null,
    opsSubmissionDateToApex: record.opsSubmissionDateToApex ?? null,
    apexCompletionDate: record.apexCompletionDate ?? null,
    residualMonitoringRequired: record.residualMonitoringRequired ?? null,
    residualFollowUpDate: record.residualFollowUpDate ?? null,
    crmTicket: record.crmTicket ?? null,
    crmDealId: record.crmDealId ?? null,
    apexTicket: record.apexTicket ?? null,
    additionalResources: record.additionalResources ?? null,
    tradeInstructions: record.tradeInstructions ?? null,
    tradeRequestId: record.tradeRequestId ?? null,
    tradeRequestUrl: record.tradeRequestUrl ?? null,
    rejectionReason: record.rejectionReason ?? null,
    apexAccountId: account(record.apexAccountId),
    statementAccountNumber: account(record.statementAccountNumber),
    transferringContra: record.transferringContra,
    dtccNumber: record.dtccNumber?.trim() ? (normalizeDtccNumber(record.dtccNumber) ?? record.dtccNumber) : null,
    statementAmount: record.statementAmount,
    methodRequested: record.methodRequested,
    feeCharged: record.feeCharged,
    feeAmount: record.feeAmount,
    feeMemo: record.feeMemo,
    feeRequestSubmitted: record.feeRequestSubmitted,
    feeRequestCompleted: record.feeRequestCompleted,
    feeApexTicket: record.feeApexTicket ?? null,
    feeCreditRequestId: record.feeCreditRequestId ?? null,
    acatDate: record.acatDate,
    custodianId: record.custodianId,
    custodianName: record.custodianName,
    cedarRidgeUserId: record.cedarRidgeUserIds.length === 1 ? record.cedarRidgeUserIds[0] : null,
    assets: record.assets.map((asset) => ({
      symbol: asset.symbol,
      description: asset.description,
      cusip: maskIdentifier(asset.cusip),
      expectedQty: asset.expectedQty,
      actualQty: asset.actualQty,
      mapStatus: asset.mapStatus,
      issue: asset.issue,
      amount: asset.amount,
      assetClass: asset.assetClass,
    })),
  };
}

/** redactAcatForMachineList. `ops` keeps the two account numbers whole (the operations list). */
export function listProjection(record: TrackerRecord, options: { ops?: boolean } = {}) {
  const assetMap = { total: record.assets.length, mapped: 0, unmapped: 0, pending: 0, expected: 0 };
  for (const asset of record.assets) {
    if (asset.mapStatus === "Mapped") assetMap.mapped++;
    else if (asset.mapStatus === "Unmapped") assetMap.unmapped++;
    else if (asset.mapStatus === "Expected") assetMap.expected++;
    else assetMap.pending++;
  }
  return {
    id: record.id,
    acatTransferId: record.acatTransferId,
    clientName: record.clientName,
    controlNumber: record.controlNumber,
    direction: record.direction,
    type: record.type,
    accountType: record.accountType,
    status: record.status,
    apexAccountId: options.ops ? record.apexAccountId : maskIdentifier(record.apexAccountId),
    statementAccountNumber: options.ops ? record.statementAccountNumber : maskIdentifier(record.statementAccountNumber),
    dtccNumber: maskIdentifier(record.dtccNumber),
    transferringContra: record.transferringContra,
    statementAmount: record.statementAmount,
    acatDate: record.acatDate,
    lastActivityAt: record.lastUpdated,
    assetMap,
  };
}

const textOrEmpty = (value: unknown) => (value == null ? "" : String(value));
function dateOrEmpty(value: string | null): string {
  if (value == null || value === "") return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 10);
}

/** The 31 records-list columns of the book read (BOOK_RECORD_COLUMN_KEYS, RECORD_FIELDS values). */
export function bookColumns(record: TrackerRecord, now = Date.now()) {
  const status = reconStatus(record);
  return {
    cedarRidgeUserId: record.cedarRidgeUserIds.length === 1 ? record.cedarRidgeUserIds[0] : "",
    cedarRidgeUserIds: record.cedarRidgeUserIds.join(", "),
    needsClientLink: record.cedarRidgeUserIds.length === 0,
    custodianId: textOrEmpty(record.custodianId),
    methodRequested: textOrEmpty(record.methodRequested),
    transferWorkflow: WORKFLOW_LABELS[record.transferWorkflow ?? "UNCLASSIFIED"] ?? "Unclassified",
    crwEe: textOrEmpty(record.crwEe),
    associatedControlNumber: textOrEmpty(record.associatedControlNumber),
    originalClientRequestDate: dateOrEmpty(record.originalClientRequestDate),
    opsSubmissionDateToApex: dateOrEmpty(record.opsSubmissionDateToApex),
    apexCompletionDate: dateOrEmpty(record.apexCompletionDate),
    residualMonitoringRequired: Boolean(record.residualMonitoringRequired),
    residualFollowUpDate: dateOrEmpty(record.residualFollowUpDate),
    feeAmount: textOrEmpty(record.feeAmount),
    feeMemo: textOrEmpty(record.feeMemo),
    feeRequestSubmitted: dateOrEmpty(record.feeRequestSubmitted),
    feeApexTicket: textOrEmpty(record.feeApexTicket),
    feeCreditRequestId: textOrEmpty(record.feeCreditRequestId),
    crmTicket: textOrEmpty(record.crmTicket),
    apexTicket: textOrEmpty(record.apexTicket),
    rejectionReason: textOrEmpty(record.rejectionReason),
    additionalResources: textOrEmpty(record.additionalResources),
    tradeRequestId: textOrEmpty(record.tradeRequestId),
    tradeRequestUrl: textOrEmpty(record.tradeRequestUrl),
    mappingSource: record.mappingSource,
    apexSource: record.apexSource,
    reconCompletedAt: record.reconCompletedAt
      ? record.reconCompletedAt.length >= 10 ? record.reconCompletedAt.slice(0, 10) : record.reconCompletedAt
      : "",
    daysOpen: daysOpen(record, now),
    issueCount: issueCount(record),
    reconStatus: status === "complete" ? "Complete" : status === "needs_review" ? "Needs Review" : "Pending",
    expectedCompletionDate: expectedCompletionDate(record) ?? "",
  };
}

/** redactAcatForMachineBook; `ops` keeps the two account numbers whole (the operations book). */
export function bookProjection(record: TrackerRecord, options: { ops?: boolean; now?: number } = {}) {
  return {
    ...bookColumns(record, options.now),
    ...listProjection(record, options),
    removedAt: record.deletedAt ? new Date(record.deletedAt).toISOString() : null,
    wealthAdvisor: record.wealthAdvisor ?? null,
    crmDealId: record.crmDealId ?? null,
    notes: record.notes ?? null,
    tradeInstructions: record.tradeInstructions ?? null,
    custodianName: record.custodianName ?? "",
    tradeInstructionsBlank: !(record.tradeInstructions ?? "").trim(),
    feeCharged: record.feeCharged ?? null,
    feeRequestCompleted: record.feeRequestCompleted ?? null,
    hasIssue: issueCount(record) > 0,
  };
}

/** redactForAdvisor: the 15 keys an advisor may see. */
export function advisorProjection(record: TrackerRecord) {
  const nullable = (v: string | null | undefined) => (v == null || v === "" ? null : v);
  return {
    id: record.id,
    clientName: record.clientName,
    status: record.status,
    direction: nullable(record.direction),
    type: nullable(record.type),
    accountType: nullable(record.accountType),
    transferringContra: nullable(record.transferringContra),
    wealthAdvisor: nullable(record.wealthAdvisor),
    additionalResources: nullable(record.additionalResources),
    originalClientRequestDate: nullable(record.originalClientRequestDate),
    opsSubmissionDateToApex: nullable(record.opsSubmissionDateToApex),
    apexCompletionDate: nullable(record.apexCompletionDate),
    acatDate: record.acatDate,
    statementAmount: typeof record.statementAmount === "number" ? record.statementAmount : null,
    custodian: record.custodianId && typeof record.custodianAvgProcessingDays === "number"
      ? { id: record.custodianId, name: record.custodianName, avgProcessingDays: record.custodianAvgProcessingDays }
      : null,
  };
}

/** The tracker's firm-wide in-flight list: every live record, plus Rejected ones not superseded by a later
 *  live or completed record for the same account and client. Completed records are left out. */
export function inFlightRecords(records: TrackerRecord[], now = new Date()): TrackerRecord[] {
  const live = records.filter((r) => !r.deletedAt);
  const yearAgo = now.getTime() - 365 * DAY_MS;
  const candidates = live.filter((r) => !LIVE_EXCLUDED.has(r.status) || r.status === "Rejected"
    || (r.status === "Completed" && new Date(r.createdAt).getTime() >= yearAgo));
  const key = (r: TrackerRecord) => JSON.stringify([r.statementAccountNumber ?? null, r.apexAccountId, r.clientName]);
  const later = (a: TrackerRecord, b: TrackerRecord) =>
    a.lastUpdated && b.lastUpdated && a.lastUpdated !== b.lastUpdated ? a.lastUpdated > b.lastUpdated : a.createdAt > b.createdAt;
  const rows = candidates.filter((r) => {
    if (r.status === "Completed") return false;
    if (r.status !== "Rejected") return true;
    return !candidates.some((o) => o !== r && key(o) === key(r) && o.status !== "Rejected" && later(o, r));
  });
  return sortByActivity(rows);
}

export function sortByActivity(rows: TrackerRecord[]): TrackerRecord[] {
  return [...rows].sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated) || b.createdAt.localeCompare(a.createdAt));
}

/** The stored reconciliation grid (security-recon.ts storedReconRows / storedReconCounts). */
export function reconSnapshot(record: TrackerRecord) {
  const cash = (symbol: string) => ["CASH", "USD"].includes(symbol.replace(/[.\-'/\s_]/g, "").toUpperCase().trim());
  const positions = record.assets.map((asset) => ({
    mapping: asset,
    id: asset.id,
    symbol: asset.symbol,
    description: asset.description,
    cusip: asset.cusip,
    expectedQty: cash(asset.symbol) ? asset.amount ?? 0 : asset.expectedQty,
    actualQty: asset.actualQty,
    amount: asset.amount,
    status: asset.mapStatus === "Mapped" ? "Matched" : asset.mapStatus === "Unmapped" ? "Mismatch"
      : asset.mapStatus === "Expected" ? "Expected" : "Pending",
    issue: asset.issue,
    notes: asset.notes,
  }));
  const total = record.assets.length;
  const matched = record.assets.filter((a) => a.mapStatus === "Mapped" || a.mapStatus === "Expected").length;
  const issues = record.assets.filter((a) => a.mapStatus === "Unmapped").length;
  return {
    acatId: record.id,
    mappingSource: record.mappingSource,
    apexSource: record.apexSource,
    lastSynced: record.mappingSyncedAt ?? null,
    sourceAccount: record.mappingAccountSummary ? {
      id: record.mappingAccountSummary.id,
      clientName: record.mappingAccountSummary.clientName,
      holder: record.mappingAccountSummary.holder,
      registration: record.mappingAccountSummary.registration,
      custodian: record.mappingAccountSummary.custodian,
      accountNumberLast4: record.mappingAccountSummary.accountNumberLast4,
      statementDate: record.mappingAccountSummary.statementDate,
      isHistorical: record.mappingAccountSummary.isHistorical,
    } : null,
    hasStatementAccount: Boolean(record.statementAccountNumber?.trim()),
    positions,
    counts: { total, matched, issues, reconRate: total > 0 ? Math.round((matched / total) * 100) : 0 },
  };
}

/** The fee fields as the tracker's fee routes return them (toHttpFee). */
export function feeFields(record: TrackerRecord) {
  return {
    feeCharged: record.feeCharged ?? null,
    feeAmount: record.feeAmount ?? null,
    feeMemo: record.feeMemo ?? null,
    feeRequestSubmitted: record.feeRequestSubmitted ?? null,
    feeRequestCompleted: record.feeRequestCompleted ?? null,
    feeApexTicket: record.feeApexTicket ?? null,
    feeCreditRequestId: record.feeCreditRequestId ?? null,
  };
}

/** A blank record with the tracker's column defaults, for the create route and the seed. */
export function newTrackerRecord(fields: Partial<TrackerRecord> & Pick<TrackerRecord, "id" | "clientName" | "acatDate">): TrackerRecord {
  const now = new Date().toISOString();
  return {
    createdAt: now, deletedAt: null, lastUpdated: now, cedarRidgeUserIds: [], identityVersion: 0, controlNumber: null,
    acatTransferId: null, direction: null, type: null, accountType: null, status: "AcatReceived", wealthAdvisor: null,
    apexAccountId: "", statementAccountNumber: null, transferringContra: null, dtccNumber: null, statementAmount: null,
    methodRequested: null, transferWorkflow: "UNCLASSIFIED", crwEe: null, originalClientRequestDate: null,
    opsSubmissionDateToApex: null, apexCompletionDate: null, residualMonitoringRequired: false, residualFollowUpDate: null,
    feeCharged: null, feeAmount: null, feeMemo: null, feeRequestSubmitted: null, feeRequestCompleted: null,
    feeApexTicket: null, feeCreditRequestId: null, crmTicket: null, apexTicket: null, additionalResources: null,
    tradeRequestId: null, tradeRequestUrl: null, tradeInstructions: null, notes: null, associatedControlNumber: null,
    rejectionReason: null, crmDealId: "", custodianId: null, custodianName: "", custodianAvgProcessingDays: null,
    mappingSource: "GCP Project API", mappingSyncedAt: null, mappingAccountId: null, mappingAccountSummary: null,
    apexSource: "Pending Upload", reconCompletedAt: null, assets: [], history: [], reviews: [], feeLog: null,
    titleConfirmation: null, documents: [], operations: [],
    ...fields,
  };
}
