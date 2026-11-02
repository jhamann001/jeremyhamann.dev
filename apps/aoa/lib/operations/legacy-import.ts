import crypto from "node:crypto";
import { parseCsv, toCsv } from "@/lib/deals/import-csv";

export const LEGACY_FEE_SOURCE = "fee_store_fee_credits" as const;
export const LEGACY_BILLING_SOURCE = "fee_store_billing_exceptions" as const;
export const LEGACY_RECON_SOURCE = "fee_store_daily_reconciliation" as const;

export type LegacyRequestSource = typeof LEGACY_FEE_SOURCE | typeof LEGACY_BILLING_SOURCE;
export type LegacySource = LegacyRequestSource | typeof LEGACY_RECON_SOURCE;

export type LegacyParseIssue = {
  source: LegacySource;
  legacyId: string;
  field: string;
  code: string;
};

export type LegacyRequestDraft = {
  source: LegacyRequestSource;
  legacyId: string;
  sourceDigest: string;
  kind: "FEE_CREDIT" | "SERVICE_GUARANTEE" | "BILLING_EXCEPTION";
  status: "PENDING" | "APPROVED" | "REJECTED" | "CREDITED";
  clientName: string;
  bridgeCedarRidgeUserId: string | null;
  sourceAccountNumbers: string[];
  feeTypes: string[];
  feeAmount: string | null;
  waiverStart: string | null;
  waiverDurationMonths: number | null;
  indefiniteDuration: boolean;
  reason: string;
  relevantTicketRefs: string[];
  submittedByName: string | null;
  submittedByRole: string;
  submittedAt: string;
  reviewedByName: string | null;
  reviewedAt: string | null;
  creditedAt: string | null;
  apexRequestId: string | null;
  legacyApexRequestText: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type LegacyReconciliationDraft = {
  source: typeof LEGACY_RECON_SOURCE;
  legacyId: string;
  sourceDigest: string;
  runDate: string;
  tradeDate: string;
  completedAt: string;
  apexRecordCount: number;
  meridianRecordCount: number;
  rawMatchCount: number;
  exceptionCount: number;
  unmatchedApex: number;
  unmatchedMeridian: number;
  rawMatchRate: string;
  legacyMatchRate: string | null;
  runNote: string | null;
};

export type LegacyParseBatch<T> = { rows: T[]; issues: LegacyParseIssue[] };

type CsvRecord = { values: Record<string, string>; digest: string; rowNumber: number };

function issue(source: LegacySource, legacyId: string, field: string, code: string): LegacyParseIssue {
  return { source, legacyId, field, code };
}

function sha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function recordsFromCsv(
  text: string,
  requiredHeaders: readonly string[],
  source: LegacySource,
): { records: CsvRecord[]; issues: LegacyParseIssue[] } {
  const matrix = parseCsv(text);
  if (matrix.length === 0) return { records: [], issues: [issue(source, "file", "file", "empty_csv")] };
  const headers = matrix[0]!.map((header) => header.trim());
  const duplicateHeaders = headers.filter((header, index) => headers.indexOf(header) !== index);
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  if (duplicateHeaders.length > 0 || missing.length > 0) {
    return {
      records: [],
      issues: [
        ...duplicateHeaders.map((header) => issue(source, "file", header || "header", "duplicate_header")),
        ...missing.map((header) => issue(source, "file", header, "missing_header")),
      ],
    };
  }
  const records: CsvRecord[] = [];
  const issues: LegacyParseIssue[] = [];
  for (let index = 1; index < matrix.length; index += 1) {
    const row = matrix[index]!;
    const fallbackId = `row-${index + 1}`;
    if (row.length !== headers.length) {
      issues.push(issue(source, fallbackId, "row", "column_count_mismatch"));
      continue;
    }
    const values = Object.fromEntries(headers.map((header, column) => [header, row[column] ?? ""]));
    records.push({ values, digest: sha256(headers.map((header) => [header, values[header]])), rowNumber: index + 1 });
  }
  return { records, issues };
}

function required(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function parseIsoDate(value: string | undefined): string | null {
  const normalized = required(value);
  if (!normalized || !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized ? null : normalized;
}

function parseIsoDateTime(value: string | undefined): string | null {
  const normalized = required(value);
  if (!normalized) return null;
  const dateOnly = parseIsoDate(normalized);
  if (dateOnly) return `${dateOnly}T00:00:00.000Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseMoney(value: string | undefined): string | null {
  const normalized = required(value)?.replaceAll(",", "").replace(/^\$/, "") ?? "";
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) return null;
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents < 0n || cents > 99_999_999_999_999n) return null;
  return `${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`;
}

function parseNonnegativeInteger(value: string | undefined): number | null {
  const normalized = required(value);
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function splitCommaValues(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((part) => part.trim()).filter(Boolean))];
}

const FEE_TYPES = new Set([
  "IRA Maintenance",
  "IRA Termination",
  "ACAT in",
  "ACAT out",
  "Transaction",
  "Wire",
  "Relationship Waiver",
]);

function legacySubmittedBy(values: Record<string, string>): string | null {
  const legacyId = values.id?.trim();
  if (legacyId === "4" || legacyId === "5") return "the owner";
  const sourceName = required(values.submitted_by);
  if (sourceName) return sourceName;
  if (values.user_role?.trim() === "Wealth Associate") return "Remy Ostrander";
  if (values.user_role?.trim() === "Operations Associate") return "Jordan Reyes";
  return null;
}

const FEE_HEADERS = [
  "id", "submission_date", "user_role", "client_user_id", "fee_type", "fee_amount",
  "account_numbers", "waiver_reason", "created_at", "status", "credited_date",
  "client_name", "apex_request", "submitted_by",
] as const;

export function parseLegacyFeeCreditsCsv(text: string): LegacyParseBatch<LegacyRequestDraft> {
  const parsed = recordsFromCsv(text, FEE_HEADERS, LEGACY_FEE_SOURCE);
  const rows: LegacyRequestDraft[] = [];
  const issues = [...parsed.issues];
  const seen = new Set<string>();
  for (const record of parsed.records) {
    const values = record.values;
    const legacyId = required(values.id) ?? `row-${record.rowNumber}`;
    const rowIssues: LegacyParseIssue[] = [];
    if (seen.has(legacyId)) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "id", "duplicate_legacy_id"));
    seen.add(legacyId);
    const submittedAt = parseIsoDateTime(values.submission_date);
    const createdAt = parseIsoDateTime(values.created_at);
    const amount = parseMoney(values.fee_amount);
    const clientName = required(values.client_name);
    const bridgeId = required(values.client_user_id);
    const accountNumbers = splitCommaValues(values.account_numbers);
    const feeTypes = splitCommaValues(values.fee_type).map((value) =>
      value === "Relationship Waiver (Advisor Only)" ? "Relationship Waiver" : value,
    );
    const status = values.status?.trim();
    const creditedAt = parseIsoDate(values.credited_date);
    const sourceApexRequest = required(values.apex_request);
    const submittedByName = legacySubmittedBy(values);
    if (!/^\d{1,80}$/.test(legacyId)) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "id", "invalid_legacy_id"));
    if (!submittedAt) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "submission_date", "invalid_date"));
    if (!createdAt) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "created_at", "invalid_date"));
    if (!amount || (status === "Credited" && Number(amount) <= 0)) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "fee_amount", "invalid_amount"));
    if (!clientName || clientName.length > 160) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "client_name", "invalid_name"));
    if (!bridgeId || bridgeId.length > 128) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "client_user_id", "invalid_bridge_id"));
    if (accountNumbers.length === 0) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "account_numbers", "missing_accounts"));
    if (feeTypes.length === 0 || feeTypes.some((value) => !FEE_TYPES.has(value))) {
      rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "fee_type", "unsupported_fee_type"));
    }
    if (status !== "Credited" && status !== "Rejected") rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "status", "unsupported_status"));
    if (status === "Credited" && !creditedAt) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "credited_date", "missing_credited_date"));
    if (sourceApexRequest && sourceApexRequest.length > 1000) {
      rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "apex_request", "apex_request_too_long"));
    }
    if (status === "Credited" && (!sourceApexRequest || sourceApexRequest.length > 80)) {
      rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "apex_request", "invalid_apex_request"));
    }
    if (!submittedByName || submittedByName.length > 160) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "submitted_by", "unresolved_submitter"));
    if ((values.user_role?.trim() ?? "").length > 32) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "user_role", "invalid_role"));
    if ((values.waiver_reason ?? "").length > 2000) rowIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "waiver_reason", "reason_too_long"));
    issues.push(...rowIssues);
    if (rowIssues.length > 0) continue;
    rows.push({
      source: LEGACY_FEE_SOURCE,
      legacyId,
      sourceDigest: record.digest,
      kind: "FEE_CREDIT",
      status: status === "Credited" ? "CREDITED" : "REJECTED",
      clientName: clientName!,
      bridgeCedarRidgeUserId: bridgeId,
      sourceAccountNumbers: accountNumbers,
      feeTypes,
      feeAmount: amount,
      waiverStart: null,
      waiverDurationMonths: null,
      indefiniteDuration: false,
      reason: values.waiver_reason?.trim() ?? "",
      relevantTicketRefs: [],
      submittedByName,
      submittedByRole: values.user_role!.trim(),
      submittedAt: submittedAt!,
      reviewedByName: null,
      reviewedAt: null,
      creditedAt: status === "Credited" ? creditedAt : null,
      apexRequestId: status === "Credited" ? sourceApexRequest : null,
      legacyApexRequestText: sourceApexRequest,
      completedAt: status === "Credited" ? `${creditedAt}T00:00:00.000Z` : null,
      createdAt: createdAt!,
    });
  }
  return { rows, issues };
}

const BILLING_HEADERS = [
  "id", "client_name", "waiver_start_month", "waiver_start_year", "waiver_duration",
  "waiver_reason", "relevant_tickets", "account_1", "account_2", "account_3",
  "account_4", "account_5", "account_6", "created_at", "approval_status",
  "approved_by", "approval_date", "exception_type", "indefinite_duration",
] as const;

const MONTHS = new Map([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3],
  ["apr", 4], ["april", 4], ["may", 5], ["jun", 6], ["june", 6],
  ["jul", 7], ["july", 7], ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9],
  ["september", 9], ["oct", 10], ["october", 10], ["nov", 11], ["november", 11],
  ["dec", 12], ["december", 12],
]);

function waiverStart(monthValue: string | undefined, yearValue: string | undefined): string | null {
  const month = MONTHS.get((monthValue ?? "").trim().toLowerCase());
  const year = Number((yearValue ?? "").trim());
  if (!month || !Number.isInteger(year) || year < 2020 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export function parseLegacyBillingExceptionsCsv(text: string): LegacyParseBatch<LegacyRequestDraft> {
  const parsed = recordsFromCsv(text, BILLING_HEADERS, LEGACY_BILLING_SOURCE);
  const rows: LegacyRequestDraft[] = [];
  const issues = [...parsed.issues];
  const seen = new Set<string>();
  for (const record of parsed.records) {
    const values = record.values;
    const legacyId = required(values.id) ?? `row-${record.rowNumber}`;
    const rowIssues: LegacyParseIssue[] = [];
    if (seen.has(legacyId)) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "id", "duplicate_legacy_id"));
    seen.add(legacyId);
    const kind = values.exception_type?.trim();
    const status = values.approval_status?.trim();
    const clientName = required(values.client_name);
    const start = waiverStart(values.waiver_start_month, values.waiver_start_year);
    const indefinite = values.indefinite_duration?.trim().toLowerCase() === "t";
    const duration = indefinite ? null : parseNonnegativeInteger(values.waiver_duration);
    const accounts = (Array.from({ length: 6 }, (_, index) => required(values[`account_${index + 1}`]))
      .filter(Boolean) as string[]);
    const createdAt = parseIsoDateTime(values.created_at);
    const reviewedAt = parseIsoDateTime(values.approval_date);
    const reviewedBy = required(values.approved_by);
    const reason = values.waiver_reason?.trim() ?? "";
    const relevantTicket = required(values.relevant_tickets);
    if (!/^\d{1,80}$/.test(legacyId)) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "id", "invalid_legacy_id"));
    if (kind !== "Billing Exception" && kind !== "Service Guarantee") rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "exception_type", "unsupported_type"));
    if (status !== "Approved" && status !== "Rejected" && status !== "Pending Approval") rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "approval_status", "unsupported_status"));
    if (!clientName || clientName.length > 160) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "client_name", "invalid_name"));
    if (!start) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "waiver_start", "invalid_date"));
    if (!indefinite && (!duration || duration > 120)) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "waiver_duration", "invalid_duration"));
    if (!reason || reason.length > 2000) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "waiver_reason", "invalid_reason"));
    if (accounts.length === 0) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "accounts", "missing_accounts"));
    if (!createdAt) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "created_at", "invalid_date"));
    if ((reviewedAt === null) !== (reviewedBy === null)) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "review", "partial_review_identity"));
    // Check the raw date too: an invalid date must not silently erase review evidence.
    if (status === "Pending Approval" && (reviewedBy || required(values.approval_date))) {
      rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "review", "pending_has_review_metadata"));
    }
    if (reviewedBy && reviewedBy.length > 160) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "approved_by", "invalid_name"));
    if (relevantTicket && relevantTicket.length > 4000) rowIssues.push(issue(LEGACY_BILLING_SOURCE, legacyId, "relevant_tickets", "ticket_too_long"));
    issues.push(...rowIssues);
    if (rowIssues.length > 0) continue;
    rows.push({
      source: LEGACY_BILLING_SOURCE,
      legacyId,
      sourceDigest: record.digest,
      kind: kind === "Service Guarantee" ? "SERVICE_GUARANTEE" : "BILLING_EXCEPTION",
      status: status === "Pending Approval" ? "PENDING" : status === "Approved" ? "APPROVED" : "REJECTED",
      clientName: clientName!,
      bridgeCedarRidgeUserId: null,
      sourceAccountNumbers: accounts,
      feeTypes: [],
      feeAmount: null,
      waiverStart: start,
      waiverDurationMonths: duration,
      indefiniteDuration: indefinite,
      reason,
      relevantTicketRefs: relevantTicket ? [relevantTicket] : [],
      submittedByName: null,
      submittedByRole: "Legacy FeeStore",
      submittedAt: createdAt!,
      reviewedByName: reviewedBy,
      reviewedAt,
      creditedAt: null,
      apexRequestId: null,
      legacyApexRequestText: null,
      completedAt: null,
      createdAt: createdAt!,
    });
  }
  return { rows, issues };
}

const RECON_HEADERS = [
  "id", "trade_date", "run_time", "total_apex", "total_meridian", "perfect_matches",
  "breaks", "unmatched_apex", "unmatched_meridian", "match_rate", "Notes",
] as const;

function easternOffsetAt(instantMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((value) => value.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - instantMs;
}

function parseEasternTimestamp(value: string | undefined): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+(AM|PM)$/i.exec(value?.trim() ?? "");
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  let hour = Number(match[4]) % 12;
  if (match[7]!.toUpperCase() === "PM") hour += 12;
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || minute > 59 || second > 59) return null;
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = wallClockUtc - easternOffsetAt(wallClockUtc);
  instant = wallClockUtc - easternOffsetAt(instant);
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  }).format(new Date(instant));
  const expected = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  }).format(new Date(wallClockUtc));
  return formatted === expected ? new Date(instant).toISOString() : null;
}

function easternDate(value: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseRate(value: string | undefined): { stored: string; source: string } | null {
  const normalized = required(value)?.replace(/%$/, "") ?? "";
  if (!/^\d{1,3}(?:\.\d{1,15})?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return parsed >= 0 && parsed <= 100 ? { stored: parsed.toFixed(4), source: normalized } : null;
}

export function parseLegacyTradeReconciliationCsv(text: string): LegacyParseBatch<LegacyReconciliationDraft> {
  const parsed = recordsFromCsv(text, RECON_HEADERS, LEGACY_RECON_SOURCE);
  const rows: LegacyReconciliationDraft[] = [];
  const issues = [...parsed.issues];
  const seen = new Set<string>();
  for (const record of parsed.records) {
    const values = record.values;
    const legacyId = required(values.id) ?? `row-${record.rowNumber}`;
    const rowIssues: LegacyParseIssue[] = [];
    if (seen.has(legacyId)) rowIssues.push(issue(LEGACY_RECON_SOURCE, legacyId, "id", "duplicate_legacy_id"));
    seen.add(legacyId);
    const tradeDate = parseIsoDate(values.trade_date);
    const completedAt = parseEasternTimestamp(values.run_time);
    const runDate = completedAt ? easternDate(completedAt) : null;
    const apex = parseNonnegativeInteger(values.total_apex);
    const alpha = parseNonnegativeInteger(values.total_meridian);
    const matches = parseNonnegativeInteger(values.perfect_matches);
    // Owner-confirmed source fact: legacy runs 23 and 24 contained no trades.
    // Fee Store left their derived zero fields blank, so only these exact rows may
    // normalize blanks to zero, and only while all three source totals are zero.
    const confirmedZeroTradeRun = (legacyId === "23" || legacyId === "24")
      && apex === 0 && alpha === 0 && matches === 0;
    const breaks = parseNonnegativeInteger(values.breaks) ?? (confirmedZeroTradeRun ? 0 : null);
    const unmatchedApex = parseNonnegativeInteger(values.unmatched_apex) ?? (confirmedZeroTradeRun ? 0 : null);
    const unmatchedAlpha = parseNonnegativeInteger(values.unmatched_meridian) ?? (confirmedZeroTradeRun ? 0 : null);
    const rate = parseRate(values.match_rate) ?? (confirmedZeroTradeRun ? { stored: "0.0000", source: "0" } : null);
    const note = required(values.Notes);
    if (!/^\d{1,80}$/.test(legacyId)) rowIssues.push(issue(LEGACY_RECON_SOURCE, legacyId, "id", "invalid_legacy_id"));
    if (!tradeDate) rowIssues.push(issue(LEGACY_RECON_SOURCE, legacyId, "trade_date", "invalid_date"));
    if (!completedAt) rowIssues.push(issue(LEGACY_RECON_SOURCE, legacyId, "run_time", "invalid_timestamp"));
    if (tradeDate && runDate && runDate <= tradeDate) {
      rowIssues.push(issue(LEGACY_RECON_SOURCE, legacyId, "run_time", "run_date_not_after_trade_date"));
    }
    for (const [field, value] of [["total_apex", apex], ["total_meridian", alpha], ["perfect_matches", matches], ["breaks", breaks], ["unmatched_apex", unmatchedApex], ["unmatched_meridian", unmatchedAlpha]] as const) {
      if (value === null) rowIssues.push(issue(LEGACY_RECON_SOURCE, legacyId, field, "invalid_count"));
    }
    if (apex !== null && unmatchedApex !== null && unmatchedApex > apex) rowIssues.push(issue(LEGACY_RECON_SOURCE, legacyId, "unmatched_apex", "count_exceeds_total"));
    if (alpha !== null && unmatchedAlpha !== null && unmatchedAlpha > alpha) rowIssues.push(issue(LEGACY_RECON_SOURCE, legacyId, "unmatched_meridian", "count_exceeds_total"));
    if (!rate) rowIssues.push(issue(LEGACY_RECON_SOURCE, legacyId, "match_rate", "invalid_rate"));
    if (note && note.length > 1000) rowIssues.push(issue(LEGACY_RECON_SOURCE, legacyId, "Notes", "note_too_long"));
    issues.push(...rowIssues);
    if (rowIssues.length > 0) continue;
    rows.push({
      source: LEGACY_RECON_SOURCE,
      legacyId,
      sourceDigest: record.digest,
      runDate: runDate!,
      tradeDate: tradeDate!,
      completedAt: completedAt!,
      apexRecordCount: apex!,
      meridianRecordCount: alpha!,
      rawMatchCount: matches!,
      exceptionCount: breaks!,
      unmatchedApex: unmatchedApex!,
      unmatchedMeridian: unmatchedAlpha!,
      rawMatchRate: rate!.stored,
      legacyMatchRate: rate!.source,
      runNote: note,
    });
  }
  return { rows, issues };
}

export type LegacyDirectoryClient = {
  sfId: string;
  canonicalSfId: string;
  householdSfId: string | null;
  canonicalHouseholdSfId: string | null;
  name: string;
  cedarRidgeUserId: string | null;
};

export type LegacyDirectoryAccount = {
  id: string;
  clientSfId: string;
  apexAccountNumber: string | null;
};

export type LegacyReviewedMapping = {
  source: LegacyRequestSource;
  legacyId: string;
  scope: "CLIENT" | "HOUSEHOLD";
  clientSfId: string;
  householdSfId: string | null;
  accountIds: string[];
};

const APPROVED_LEGACY_HOUSEHOLD_SCOPE = new Set([
  `${LEGACY_FEE_SOURCE}:26`,
  `${LEGACY_FEE_SOURCE}:27`,
  `${LEGACY_FEE_SOURCE}:31`,
  `${LEGACY_FEE_SOURCE}:40`,
  `${LEGACY_BILLING_SOURCE}:8`,
  `${LEGACY_BILLING_SOURCE}:11`,
  `${LEGACY_BILLING_SOURCE}:15`,
  `${LEGACY_BILLING_SOURCE}:18`,
  `${LEGACY_BILLING_SOURCE}:20`,
  `${LEGACY_BILLING_SOURCE}:24`,
]);

export function legacyHouseholdScopeApproved(source: LegacyRequestSource, legacyId: string): boolean {
  return APPROVED_LEGACY_HOUSEHOLD_SCOPE.has(`${source}:${legacyId}`);
}

export type ResolvedLegacyRequest = LegacyRequestDraft & {
  scope: "CLIENT" | "HOUSEHOLD";
  clientSfId: string;
  householdSfId: string | null;
  accountIds: string[];
};

export type StoredLegacyRequestResolution = {
  scope: string;
  clientSfId: string;
  householdSfId: string | null;
  legacyClientName: string | null;
  accountIds: string[];
};

export function normalizeLegacyDirectoryName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function legacySourceIdentityKey(value: string): string {
  const normalized = value.trim();
  // Only actual Salesforce-shaped 15/18-character IDs share a 15-char key.
  // Opaque dev IDs (for example ...CONTACT-A/B...) must remain distinct.
  return (/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(normalized)
    ? normalized.slice(0, 15) : normalized).toUpperCase();
}

const sfKey = legacySourceIdentityKey;

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left.map((value) => value.trim()));
  const rightSet = new Set(right.map((value) => value.trim()));
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

export function legacyResolutionMatchesStored(
  expected: ResolvedLegacyRequest,
  stored: StoredLegacyRequestResolution,
): boolean {
  return stored.scope === expected.scope
    && sfKey(stored.clientSfId) === sfKey(expected.clientSfId)
    && (stored.householdSfId === null
      ? expected.householdSfId === null
      : expected.householdSfId !== null && sfKey(stored.householdSfId) === sfKey(expected.householdSfId))
    && stored.legacyClientName === expected.clientName
    && sameStringSet(stored.accountIds, expected.accountIds);
}

function accountsForMembers(
  draft: LegacyRequestDraft,
  memberIds: Set<string>,
  accounts: LegacyDirectoryAccount[],
): string[] | null {
  const resolved: string[] = [];
  for (const sourceNumber of draft.sourceAccountNumbers) {
    const matching = accounts.filter((account) =>
      memberIds.has(sfKey(account.clientSfId))
      && (account.apexAccountNumber?.trim() === sourceNumber || account.id.trim() === sourceNumber),
    );
    const ids = [...new Set(matching.map((account) => account.id))];
    if (ids.length !== 1) return null;
    resolved.push(ids[0]!);
  }
  return [...new Set(resolved)];
}

function clientMemberIds(canonicalSfId: string, clients: LegacyDirectoryClient[]): Set<string> {
  return new Set(clients
    .filter((client) => sfKey(client.canonicalSfId) === sfKey(canonicalSfId))
    .map((client) => sfKey(client.sfId)));
}

function householdMemberIds(canonicalHouseholdSfId: string, clients: LegacyDirectoryClient[]): Set<string> {
  return new Set(clients
    .filter((client) => client.canonicalHouseholdSfId
      && sfKey(client.canonicalHouseholdSfId) === sfKey(canonicalHouseholdSfId))
    .map((client) => sfKey(client.sfId)));
}

function accountsForCandidate(
  draft: LegacyRequestDraft,
  canonicalSfId: string,
  clients: LegacyDirectoryClient[],
  accounts: LegacyDirectoryAccount[],
): string[] | null {
  return accountsForMembers(draft, clientMemberIds(canonicalSfId, clients), accounts);
}

function validateReviewedAccounts(
  draft: LegacyRequestDraft,
  reviewedAccountIds: string[],
  memberIds: Set<string>,
  accounts: LegacyDirectoryAccount[],
): { accountIds: string[] | null; code: "reviewed_account_not_owned" | "reviewed_accounts_source_mismatch" | null } {
  const accountIds = [...new Set(reviewedAccountIds.map((value) => value.trim()))];
  const validAccounts = new Set(accounts
    .filter((account) => memberIds.has(sfKey(account.clientSfId)))
    .map((account) => account.id));
  if (accountIds.some((accountId) => !validAccounts.has(accountId))) {
    return { accountIds: null, code: "reviewed_account_not_owned" };
  }
  const resolved = accountsForMembers(draft, memberIds, accounts);
  if (!resolved || resolved.length === 0) {
    return { accountIds: null, code: "reviewed_accounts_source_mismatch" };
  }
  const reviewedSet = new Set(accountIds);
  if (resolved.length !== reviewedSet.size || resolved.some((accountId) => !reviewedSet.has(accountId))) {
    return { accountIds: null, code: "reviewed_accounts_source_mismatch" };
  }
  return { accountIds: resolved, code: null };
}

export function resolveLegacyRequest(
  draft: LegacyRequestDraft,
  directory: { clients: LegacyDirectoryClient[]; accounts: LegacyDirectoryAccount[] },
  reviewed?: LegacyReviewedMapping,
): { resolved: ResolvedLegacyRequest | null; issue: LegacyParseIssue | null } {
  if (reviewed) {
    if (reviewed.source !== draft.source || reviewed.legacyId !== draft.legacyId) {
      return { resolved: null, issue: issue(draft.source, draft.legacyId, "mapping", "mapping_key_mismatch") };
    }
    const selected = directory.clients.find((client) => sfKey(client.canonicalSfId) === sfKey(reviewed.clientSfId));
    if (!selected) return { resolved: null, issue: issue(draft.source, draft.legacyId, "client_sf_id", "reviewed_client_not_found") };

    if (reviewed.scope === "HOUSEHOLD") {
      if (!legacyHouseholdScopeApproved(draft.source, draft.legacyId)) {
        return { resolved: null, issue: issue(draft.source, draft.legacyId, "scope", "household_scope_not_approved") };
      }
      if (!reviewed.householdSfId) {
        return { resolved: null, issue: issue(draft.source, draft.legacyId, "household_sf_id", "reviewed_household_required") };
      }
      const householdMembers = householdMemberIds(reviewed.householdSfId, directory.clients);
      const selectedHouseholds = new Set(directory.clients
        .filter((client) => sfKey(client.canonicalSfId) === sfKey(selected.canonicalSfId))
        .map((client) => client.canonicalHouseholdSfId)
        .filter(Boolean)
        .map((value) => sfKey(value!)));
      if (selectedHouseholds.size !== 1 || !selectedHouseholds.has(sfKey(reviewed.householdSfId))) {
        return { resolved: null, issue: issue(draft.source, draft.legacyId, "household_sf_id", "reviewed_client_not_in_household") };
      }
      if (reviewed.accountIds.length === 0) {
        return { resolved: null, issue: issue(draft.source, draft.legacyId, "account_ids", "reviewed_household_accounts_required") };
      }
      const validated = validateReviewedAccounts(draft, reviewed.accountIds, householdMembers, directory.accounts);
      if (!validated.accountIds) {
        return { resolved: null, issue: issue(draft.source, draft.legacyId, "account_ids", validated.code!) };
      }
      return {
        resolved: {
          ...draft,
          scope: "HOUSEHOLD",
          clientSfId: selected.canonicalSfId,
          householdSfId: reviewed.householdSfId,
          accountIds: validated.accountIds,
        },
        issue: null,
      };
    }

    if (reviewed.householdSfId) {
      return { resolved: null, issue: issue(draft.source, draft.legacyId, "household_sf_id", "client_scope_has_household") };
    }
    const memberIds = clientMemberIds(selected.canonicalSfId, directory.clients);
    const accountIds = reviewed.accountIds.length > 0
      ? validateReviewedAccounts(draft, reviewed.accountIds, memberIds, directory.accounts)
      : { accountIds: accountsForMembers(draft, memberIds, directory.accounts), code: null };
    if (!accountIds.accountIds || accountIds.accountIds.length === 0) {
      return { resolved: null, issue: issue(draft.source, draft.legacyId, "account_ids", accountIds.code ?? "reviewed_accounts_unresolved") };
    }
    return {
      resolved: {
        ...draft,
        scope: "CLIENT",
        clientSfId: selected.canonicalSfId,
        householdSfId: null,
        accountIds: accountIds.accountIds,
      },
      issue: null,
    };
  }

  const name = normalizeLegacyDirectoryName(draft.clientName);
  const candidates = directory.clients.filter((client) =>
    normalizeLegacyDirectoryName(client.name) === name
    && (!draft.bridgeCedarRidgeUserId || client.cedarRidgeUserId === draft.bridgeCedarRidgeUserId),
  );
  const byCanonical = new Map<string, { sfId: string; accountIds: string[] }>();
  for (const candidate of candidates) {
    const accountIds = accountsForCandidate(draft, candidate.canonicalSfId, directory.clients, directory.accounts);
    if (accountIds) byCanonical.set(sfKey(candidate.canonicalSfId), { sfId: candidate.canonicalSfId, accountIds });
  }
  if (byCanonical.size !== 1) {
    return { resolved: null, issue: issue(draft.source, draft.legacyId, "client_sf_id", byCanonical.size === 0 ? "no_proven_match" : "ambiguous_match") };
  }
  const match = [...byCanonical.values()][0]!;
  return {
    resolved: {
      ...draft,
      scope: "CLIENT",
      clientSfId: match.sfId,
      householdSfId: null,
      accountIds: match.accountIds,
    },
    issue: null,
  };
}

const MAPPING_HEADERS = ["source", "legacy_id", "scope", "client_sf_id", "household_sf_id", "account_ids"] as const;

export function parseReviewedMappingsCsv(text: string): LegacyParseBatch<LegacyReviewedMapping> {
  const parsed = recordsFromCsv(text, MAPPING_HEADERS, LEGACY_FEE_SOURCE);
  const rows: LegacyReviewedMapping[] = [];
  const issues = [...parsed.issues];
  const seen = new Set<string>();
  for (const record of parsed.records) {
    const values = record.values;
    const source = values.source?.trim() as LegacyRequestSource;
    const legacyId = required(values.legacy_id) ?? `row-${record.rowNumber}`;
    const scope = values.scope?.trim().toUpperCase() as LegacyReviewedMapping["scope"];
    const clientSfId = required(values.client_sf_id);
    const householdSfId = required(values.household_sf_id);
    const accountIds = splitCommaValues((values.account_ids ?? "").replaceAll("|", ","));
    const mappingIssues: LegacyParseIssue[] = [];
    if (source !== LEGACY_FEE_SOURCE && source !== LEGACY_BILLING_SOURCE) mappingIssues.push(issue(LEGACY_FEE_SOURCE, legacyId, "source", "invalid_mapping_source"));
    const key = `${source}:${legacyId}`;
    if (seen.has(key)) mappingIssues.push(issue(source || LEGACY_FEE_SOURCE, legacyId, "legacy_id", "duplicate_mapping"));
    seen.add(key);
    if (scope !== "CLIENT" && scope !== "HOUSEHOLD") mappingIssues.push(issue(source || LEGACY_FEE_SOURCE, legacyId, "scope", "invalid_mapping_scope"));
    if (!clientSfId || !/^[a-zA-Z0-9]{15,18}$/.test(clientSfId)) mappingIssues.push(issue(source || LEGACY_FEE_SOURCE, legacyId, "client_sf_id", "invalid_client_sf_id"));
    if (scope === "HOUSEHOLD" && (!householdSfId || !/^[a-zA-Z0-9]{15,18}$/.test(householdSfId))) {
      mappingIssues.push(issue(source || LEGACY_FEE_SOURCE, legacyId, "household_sf_id", "invalid_household_sf_id"));
    }
    if (scope === "HOUSEHOLD" && (source === LEGACY_FEE_SOURCE || source === LEGACY_BILLING_SOURCE)
      && !legacyHouseholdScopeApproved(source, legacyId)) {
      mappingIssues.push(issue(source, legacyId, "scope", "household_scope_not_approved"));
    }
    if (scope === "CLIENT" && householdSfId) mappingIssues.push(issue(source || LEGACY_FEE_SOURCE, legacyId, "household_sf_id", "client_scope_has_household"));
    if (scope === "HOUSEHOLD" && accountIds.length === 0) mappingIssues.push(issue(source || LEGACY_FEE_SOURCE, legacyId, "account_ids", "household_mapping_accounts_required"));
    if (accountIds.some((accountId) => accountId.length > 128)) mappingIssues.push(issue(source || LEGACY_FEE_SOURCE, legacyId, "account_ids", "invalid_account_id"));
    issues.push(...mappingIssues);
    if (mappingIssues.length === 0) rows.push({ source, legacyId, scope, clientSfId: clientSfId!, householdSfId, accountIds });
  }
  return { rows, issues };
}

export function mappingReviewCsv(rows: LegacyRequestDraft[]): string {
  return toCsv([
    [...MAPPING_HEADERS],
    ...rows.map((row) => [row.source, row.legacyId, "", "", "", ""]),
  ]);
}

export function deterministicLegacyId(source: LegacySource, legacyId: string): string {
  return `leg${sha256(`${source}:${legacyId}`).slice(0, 32)}`;
}

export function formatLegacyImportReport(input: {
  parsed: Record<LegacySource, number>;
  ready: Record<LegacySource, number>;
  existing: Record<LegacySource, number>;
  issues: LegacyParseIssue[];
}): string {
  const lines = ["Legacy Operations import validation (PII-safe)"];
  for (const source of [LEGACY_FEE_SOURCE, LEGACY_BILLING_SOURCE, LEGACY_RECON_SOURCE] as const) {
    lines.push(`${source}: parsed=${input.parsed[source]} ready=${input.ready[source]} existing=${input.existing[source]}`);
  }
  lines.push(`blocking_issues=${input.issues.length}`);
  for (const value of input.issues) lines.push(`- ${value.source}:${value.legacyId}:${value.field}:${value.code}`);
  return lines.join("\n");
}
