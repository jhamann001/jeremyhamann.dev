// The Transfer Tracker's operations dashboard and DTC suggestion, ported from the tracker demo
// (lib/transfer-analytics.ts, lib/dashboard-contract.ts, lib/dtcc-suggestion.ts, lib/contra-normalize.ts) over the
// demo's records. Same rules, same order, same numbers.

import {
  TERMINAL_STATUSES, TRANSFER_WORKFLOWS, assetCounts, formatDateMMDDYYYY, hasApexUpload, normalizeDateToIso,
  normalizeDtccNumber, normalizeMoneyStringExact, type TrackerRecord, type TransferWorkflow,
} from "./tracker-model";

const DAY_MS = 86_400_000;
const FINALIZED_OUTCOMES = ["Completed", "Rejected", "Canceled"];
const NON_UNIQUE_CONTROL_MARKERS = new Set(["to come", "manual"]);
const HOLIDAYS = new Map<number, Set<string>>();

// --- DTC suggestion ---

function normalizeContra(name: string | null | undefined): string {
  if (!name) return "";
  return name.trim().replace(/\./g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
const ALIAS: Record<string, string> = {
  etrade: "E*Trade", "j p morgan": "J.P. Morgan", "american enterprise investment services inc": "Ameriprise Financial Services",
  "sparrow advisors": "Sparrow Growth Funds", drivewealth: "DriveWealth",
};
const contraKey = (value?: string | null) => normalizeContra(ALIAS[normalizeContra(value)] ?? value);

export interface DtccSuggestion {
  status: "suggested" | "ambiguous" | "insufficient" | "none";
  dtccNumber: string | null;
  source: "custodian" | "history" | null;
  historicalSampleSize: number;
}

export function suggestDtccNumber(
  records: Array<{ transferringContra?: string | null; dtccNumber?: string | null }>,
  custodians: Array<{ name: string; dtcNumber?: string | null }>,
  contra?: string | null,
): DtccSuggestion {
  const key = contraKey(contra);
  if (!key) return { status: "none", dtccNumber: null, source: null, historicalSampleSize: 0 };
  const history = records.filter((r) => contraKey(r.transferringContra) === key && r.dtccNumber?.trim());
  const historyValues = history.map((r) => normalizeDtccNumber(r.dtccNumber));
  const historyCandidates = new Set(historyValues.filter((v): v is string => v != null));
  const custodianValues = custodians.filter((c) => contraKey(c.name) === key && c.dtcNumber?.trim()).map((c) => normalizeDtccNumber(c.dtcNumber));
  const custodianCandidates = new Set(custodianValues.filter((v): v is string => v != null));
  const candidates = new Set([...historyCandidates, ...custodianCandidates]);
  if (historyValues.some((v) => v == null) || custodianValues.some((v) => v == null) || candidates.size > 1) {
    return { status: "ambiguous", dtccNumber: null, source: null, historicalSampleSize: history.length };
  }
  const [only] = [...candidates];
  if (!only) return { status: "none", dtccNumber: null, source: null, historicalSampleSize: 0 };
  if (custodianCandidates.size === 1) return { status: "suggested", dtccNumber: only, source: "custodian", historicalSampleSize: history.length };
  if (history.length >= 2) return { status: "suggested", dtccNumber: only, source: "history", historicalSampleSize: history.length };
  return { status: "insufficient", dtccNumber: null, source: null, historicalSampleSize: history.length };
}

// --- business days (the DTCC ACATS calendar) ---

function timestamp(value?: string | null): number | null {
  const normalized = normalizeDateToIso(value);
  if (!normalized) return null;
  const parsed = new Date(`${normalized}T00:00:00Z`).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
const dateKey = (date: Date) => date.toISOString().slice(0, 10);

function observedFixedHoliday(year: number, month: number, day: number): string {
  const holiday = new Date(Date.UTC(year, month, day));
  const weekday = holiday.getUTCDay();
  if (weekday === 0) holiday.setUTCDate(holiday.getUTCDate() + 1);
  if (weekday === 6) holiday.setUTCDate(holiday.getUTCDate() - 1);
  return dateKey(holiday);
}
function nthWeekday(year: number, month: number, weekday: number, occurrence: number): string {
  const date = new Date(Date.UTC(year, month, 1));
  date.setUTCDate(1 + ((weekday - date.getUTCDay() + 7) % 7) + (occurrence - 1) * 7);
  return dateKey(date);
}
function lastWeekday(year: number, month: number, weekday: number): string {
  const date = new Date(Date.UTC(year, month + 1, 0));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekday + 7) % 7));
  return dateKey(date);
}
function easterSunday(year: number): Date {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(Date.UTC(year, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
}
function closedDates(year: number): Set<string> {
  const cached = HOLIDAYS.get(year);
  if (cached) return cached;
  const goodFriday = easterSunday(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  const set = new Set([
    observedFixedHoliday(year, 0, 1), nthWeekday(year, 0, 1, 3), nthWeekday(year, 1, 1, 3), dateKey(goodFriday),
    lastWeekday(year, 4, 1), observedFixedHoliday(year, 5, 19), observedFixedHoliday(year, 6, 4), nthWeekday(year, 8, 1, 1),
    nthWeekday(year, 10, 4, 4), observedFixedHoliday(year, 11, 25),
  ]);
  HOLIDAYS.set(year, set);
  return set;
}
/** Whether a UTC date is an ACATS processing day. The demo seed's calendar uses it too. */
export function isBusinessDay(date: Date): boolean {
  const weekday = date.getUTCDay();
  const key = dateKey(date);
  return weekday !== 0 && weekday !== 6 && !closedDates(date.getUTCFullYear()).has(key) && !closedDates(date.getUTCFullYear() + 1).has(key);
}

export function calendarDaysBetween(start?: string | null, end?: string | null): number | null {
  const a = timestamp(start);
  const b = timestamp(end);
  return a == null || b == null ? null : Math.round((b - a) / DAY_MS);
}

export function businessDaysBetween(start?: string | null, end?: string | null): number | null {
  const startTime = timestamp(start);
  const endTime = timestamp(end);
  if (startTime == null || endTime == null) return null;
  if (startTime === endTime) return 0;
  if (endTime < startTime) {
    const reverse = businessDaysBetween(end, start);
    return reverse == null ? null : -reverse;
  }
  let count = 0;
  const cursor = new Date(startTime + DAY_MS);
  while (cursor.getTime() <= endTime) {
    if (isBusinessDay(cursor)) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

// --- distributions and workflow ---

function percentile(sorted: number[], ratio: number): number | null {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function distribution(values: Array<number | null>) {
  const clean = values.filter((v): v is number => v != null && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!clean.length) return { average: null, median: null, p75: null, p90: null, sampleSize: 0 };
  return {
    average: clean.reduce((sum, v) => sum + v, 0) / clean.length,
    median: percentile(clean, 0.5), p75: percentile(clean, 0.75), p90: percentile(clean, 0.9), sampleSize: clean.length,
  };
}

export function workflowFor(record: TrackerRecord): TransferWorkflow {
  if (record.type?.trim().toLowerCase() === "residual credit") return "RESIDUAL";
  if (record.transferWorkflow && record.transferWorkflow !== "UNCLASSIFIED") {
    // The tracker's PAPERWORK value was folded into MANUAL.
    return (record.transferWorkflow === "PAPERWORK" ? "MANUAL" : record.transferWorkflow) as TransferWorkflow;
  }
  const method = record.methodRequested?.toLowerCase() ?? "";
  if (method.includes("api")) return "ACAT";
  if (method.includes("non-acat transfer (manual)")) return "MANUAL";
  return "UNCLASSIFIED";
}

export function finalizedSummary(records: TrackerRecord[]) {
  const counts = { Completed: 0, Rejected: 0, Canceled: 0, Purged: 0, active: 0 };
  for (const record of records) {
    if (record.status in counts) counts[record.status as "Completed" | "Rejected" | "Canceled" | "Purged"]++;
    else if (!TERMINAL_STATUSES.has(record.status)) counts.active++;
  }
  const validFinalized = counts.Completed + counts.Rejected + counts.Canceled;
  return {
    ...counts, total: records.length, validFinalized,
    completedRate: validFinalized ? counts.Completed / validFinalized : 0,
    rejectionRate: validFinalized ? counts.Rejected / validFinalized : 0,
    canceledRate: validFinalized ? counts.Canceled / validFinalized : 0,
  };
}

export function workflowTimings(records: TrackerRecord[]) {
  return TRANSFER_WORKFLOWS.map((workflow) => {
    const bucket = records.filter((r) => workflowFor(r) === workflow && r.status === "Completed");
    return {
      workflow,
      requestToSubmit: distribution(bucket.map((r) => businessDaysBetween(r.originalClientRequestDate, r.opsSubmissionDateToApex))),
      submitToComplete: distribution(bucket.map((r) => businessDaysBetween(r.opsSubmissionDateToApex, r.apexCompletionDate))),
      requestToComplete: distribution(bucket.map((r) => businessDaysBetween(r.originalClientRequestDate, r.apexCompletionDate))),
    };
  });
}

const VOLUME_FLOOR_MONTH = "2025-06";

function volumeStartMonth(records: TrackerRecord[], end: string): string {
  let first: string | null = null;
  for (const record of records) {
    if (workflowFor(record) === "RESIDUAL") continue;
    const key = normalizeDateToIso(record.originalClientRequestDate)?.slice(0, 7);
    if (key && key >= VOLUME_FLOOR_MONTH && key <= end && (!first || key < first)) first = key;
  }
  return first ?? VOLUME_FLOOR_MONTH;
}

export function monthlyTransferVolume(records: TrackerRecord[], now = new Date()) {
  const end = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let [year, month] = volumeStartMonth(records, end).split("-").map(Number);
  const months: Array<{ month: string; label: string; total: number; workflows: Record<TransferWorkflow, number> }> = [];
  while (`${year}-${String(month).padStart(2, "0")}` <= end) {
    months.push({
      month: `${year}-${String(month).padStart(2, "0")}`,
      label: new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
      total: 0,
      workflows: Object.fromEntries(TRANSFER_WORKFLOWS.map((w) => [w, 0])) as Record<TransferWorkflow, number>,
    });
    month++;
    if (month === 13) { month = 1; year++; }
  }
  const byMonth = new Map(months.map((m) => [m.month, m]));
  for (const record of records) {
    const workflow = workflowFor(record);
    if (workflow === "RESIDUAL") continue;
    const item = byMonth.get(normalizeDateToIso(record.originalClientRequestDate)?.slice(0, 7) ?? "");
    if (!item) continue;
    item.total++;
    item.workflows[workflow]++;
  }
  return months;
}

export function contraPerformance(records: TrackerRecord[], workflow: TransferWorkflow) {
  const inWorkflow = records.filter((r) => workflowFor(r) === workflow);
  const names = new Set(inWorkflow.map((r) => r.transferringContra?.trim()).filter((v): v is string => Boolean(v)));
  return [...names].map((contra) => {
    const bucket = inWorkflow.filter((r) => r.transferringContra?.trim() === contra);
    const finalized = bucket.filter((r) => FINALIZED_OUTCOMES.includes(r.status));
    const completed = bucket.filter((r) => r.status === "Completed");
    return {
      contra,
      completed: completed.length,
      finalized: finalized.length,
      rejectionRate: finalized.length ? finalized.filter((r) => r.status === "Rejected").length / finalized.length : 0,
      medianApexDays: distribution(completed.map((r) => businessDaysBetween(r.opsSubmissionDateToApex, r.apexCompletionDate))).median,
      completedAmount: completed.reduce((sum, r) => sum + Math.abs(r.statementAmount ?? 0), 0),
    };
  }).sort((a, b) => b.completed - a.completed || a.contra.localeCompare(b.contra));
}

function parentByControl(records: TrackerRecord[]): Map<string, TrackerRecord> {
  return new Map(records
    .filter((r) => r.controlNumber?.trim() && !NON_UNIQUE_CONTROL_MARKERS.has(r.controlNumber.trim().toLowerCase()) && workflowFor(r) !== "RESIDUAL")
    .map((r) => [r.controlNumber!.trim(), r]));
}

function residualLagRows(records: TrackerRecord[]) {
  const parents = parentByControl(records);
  const rows: Array<{ contra: string; days: number }> = [];
  for (const residual of records.filter((r) => workflowFor(r) === "RESIDUAL")) {
    const parent = residual.associatedControlNumber ? parents.get(residual.associatedControlNumber.trim()) : undefined;
    const lag = calendarDaysBetween(parent?.apexCompletionDate, residual.apexCompletionDate);
    if (lag == null || lag < 0) continue;
    rows.push({ contra: parent?.transferringContra?.trim() || residual.transferringContra?.trim() || "Unknown contra", days: lag });
  }
  return rows;
}

export function residualBenchmarks(records: TrackerRecord[]) {
  const byContra = new Map<string, number[]>();
  for (const row of residualLagRows(records)) byContra.set(row.contra, [...(byContra.get(row.contra) ?? []), row.days]);
  return [...byContra.entries()].map(([contra, lags]) => {
    const stats = distribution(lags);
    return { contra, sampleSize: stats.sampleSize, medianDays: stats.median, p75Days: stats.p75, p90Days: stats.p90 };
  }).sort((a, b) => b.sampleSize - a.sampleSize || a.contra.localeCompare(b.contra));
}

function residualFollowUpDays(records: TrackerRecord[], contra?: string | null): number {
  const rows = residualLagRows(records);
  const normalized = contra?.trim().toLowerCase();
  const contraLags = normalized ? rows.filter((r) => r.contra.toLowerCase() === normalized).map((r) => r.days) : [];
  if (contraLags.length >= 10) return Math.ceil(distribution(contraLags).p75 ?? 27);
  if (rows.length) return Math.ceil(distribution(rows.map((r) => r.days)).p75 ?? 27);
  return 27;
}

export function residualMonitorQueue(records: TrackerRecord[], now = new Date()) {
  const residualParents = new Set(records
    .filter((r) => workflowFor(r) === "RESIDUAL" && r.associatedControlNumber)
    .map((r) => r.associatedControlNumber!.trim()));
  return records
    .filter((r) => r.residualMonitoringRequired && r.status === "Completed" && workflowFor(r) !== "RESIDUAL"
      && r.controlNumber && !residualParents.has(r.controlNumber.trim()))
    .map((record) => {
      const benchmarkDays = residualFollowUpDays(records, record.transferringContra);
      const completed = timestamp(record.apexCompletionDate);
      const followUpDate = record.residualFollowUpDate
        || (completed == null ? "" : new Date(completed + benchmarkDays * DAY_MS).toISOString().slice(0, 10));
      return {
        record, followUpDate, benchmarkDays,
        daysPastFollowUp: Math.max(0, calendarDaysBetween(followUpDate, now.toISOString().slice(0, 10)) ?? 0),
      };
    })
    .filter((item) => item.followUpDate && timestamp(item.followUpDate)! <= now.getTime())
    .sort((a, b) => b.daysPastFollowUp - a.daysPastFollowUp);
}

export function flowSummary(records: TrackerRecord[]) {
  const completed = records.filter((r) => r.status === "Completed");
  const amount = (bucket: TrackerRecord[]) => bucket.reduce((sum, r) => sum + Math.abs(r.statementAmount ?? 0), 0);
  const split = (bucket: TrackerRecord[]) => {
    const residual = bucket.filter((r) => workflowFor(r) === "RESIDUAL");
    const requested = bucket.filter((r) => workflowFor(r) !== "RESIDUAL");
    return {
      totalCount: bucket.length, totalAmount: amount(bucket), requestedCount: requested.length,
      requestedAmount: amount(requested), residualCount: residual.length, residualAmount: amount(residual),
    };
  };
  const incoming = split(completed.filter((r) => r.direction?.toLowerCase() === "in"));
  const outgoing = split(completed.filter((r) => r.direction?.toLowerCase() === "out"));
  return {
    incoming, outgoing,
    netAmount: incoming.totalAmount - outgoing.totalAmount,
    requestedNetAmount: incoming.requestedAmount - outgoing.requestedAmount,
    residualNetAmount: incoming.residualAmount - outgoing.residualAmount,
  };
}

export function reconCoverage(records: TrackerRecord[]) {
  const eligible = records.filter((r) => r.status === "Completed" && workflowFor(r) !== "RESIDUAL");
  const tracked = eligible.filter((r) => Boolean(r.reconCompletedAt) || hasApexUpload(r) || r.assets.length > 0);
  let matched = 0, mismatch = 0, pending = 0;
  for (const record of tracked) {
    const counts = assetCounts(record);
    if (record.reconCompletedAt || (counts.mismatch === 0 && counts.pending === 0 && counts.matched > 0)) matched++;
    else if (counts.mismatch > 0) mismatch++;
    else pending++;
  }
  return {
    eligible: eligible.length, tracked: tracked.length, notTracked: eligible.length - tracked.length,
    coverageRate: eligible.length ? tracked.length / eligible.length : 0,
    matched, mismatch, pending, matchRate: matched + mismatch ? matched / (matched + mismatch) : null,
  };
}

// --- data quality ---

type Severity = "high" | "medium" | "low";
interface Exception { record: TrackerRecord; ruleKey: string; fingerprint: string; title: string; detail: string; severity: Severity }

export const DATA_QUALITY_RULES = [
  { ruleKey: "completed_missing_date", title: "Completed without Apex date", description: "Completed transfers must have a Apex Completion Date." },
  { ruleKey: "rejected_missing_reason", title: "Rejected without reason", description: "Rejected transfers must include a rejection reason." },
  { ruleKey: "submission_before_request", title: "Submission predates request", description: "Ops Submission Date cannot be before the client request date." },
  { ruleKey: "completion_before_submission", title: "Completion predates submission", description: "Apex Completion Date cannot be before Ops Submission Date." },
  { ruleKey: "invalid_date", title: "Date cannot be interpreted", description: "Tracked dates must use a recognized calendar-date format." },
  { ruleKey: "workflow_unclassified", title: "Workflow is unclassified", description: "Each transfer must be classified as ACAT/API, Manual, DRS, or Residual." },
  { ruleKey: "missing_dtcc_number", title: "ACAT is missing a DTC number", description: "Active ACAT/API transfers with a contra should have a verified DTC number." },
  { ruleKey: "invalid_dtcc_number", title: "DTC number is not four digits", description: "DTC participant numbers must contain exactly four digits." },
  { ruleKey: "finalized_placeholder_control", title: "Finalized transfer has ‘To Come’ control", description: "Finalized transfers cannot retain the temporary ‘To Come’ marker." },
  { ruleKey: "manual_control_marker", title: "Manual marker belongs in Transfer Workflow", description: "Use the workflow field for Manual; the control-number field should contain a real control number or remain blank." },
  { ruleKey: "duplicate_control", title: "Duplicate control number", description: "Real control numbers should not appear on more than one transfer movement." },
  { ruleKey: "outgoing_positive_value", title: "Outgoing transfer has positive value", description: "Outgoing statement values must follow the negative-sign convention." },
  { ruleKey: "invalid_fee_amount", title: "Fee amount is not valid", description: "Fee amounts must contain a valid dollar value." },
  { ruleKey: "fee_amount_format", title: "Fee amount needs consistent formatting", description: "Saved fee amounts must use standard dollar-and-cent formatting." },
  { ruleKey: "residual_missing_parent", title: "Residual has no linked parent", description: "Residuals must link to an original transfer through Associated Control Number." },
  { ruleKey: "residual_has_fee", title: "Residual has a transfer fee", description: "Residual credits cannot carry transfer-fee reimbursement data." },
  { ruleKey: "missing_crm_ticket", title: "Required CRM ticket is missing", description: "Completed full and partial transfers, plus completed non-residual outgoing transfers, must link to a CRM ticket." },
  { ruleKey: "residual_sweep_missing", title: "Residual sweep needs follow-up", description: "Monitored completed transfers are flagged after their follow-up date when no linked residual is found." },
];

function exception(record: TrackerRecord, ruleKey: string, title: string, detail: string, severity: Severity, values: unknown[]): Exception {
  return { record, ruleKey, title, detail, severity, fingerprint: values.map(String).join("|").slice(0, 500) };
}

export function dataQualityExceptions(records: TrackerRecord[]): Exception[] {
  const items: Exception[] = [];
  const parents = parentByControl(records);
  const controlCounts = new Map<string, number>();
  const suggestions = new Map<string, DtccSuggestion>();
  for (const r of records) {
    const control = r.controlNumber?.trim();
    if (control && !NON_UNIQUE_CONTROL_MARKERS.has(control.toLowerCase())) controlCounts.set(control, (controlCounts.get(control) ?? 0) + 1);
  }
  for (const r of records) {
    const workflow = workflowFor(r);
    const requestToSubmit = calendarDaysBetween(r.originalClientRequestDate, r.opsSubmissionDateToApex);
    const submitToComplete = calendarDaysBetween(r.opsSubmissionDateToApex, r.apexCompletionDate);
    if (r.status === "Completed" && !r.apexCompletionDate) items.push(exception(r, "completed_missing_date", "Completed without Apex date", "The transfer is completed but has no Apex completion date.", "high", [r.status, r.apexCompletionDate]));
    if (r.status === "Rejected" && !r.rejectionReason?.trim()) items.push(exception(r, "rejected_missing_reason", "Rejected without reason", "Add a rejection reason so the outcome can be analyzed.", "medium", [r.status, r.rejectionReason]));
    if (requestToSubmit != null && requestToSubmit < 0) items.push(exception(r, "submission_before_request", "Submission predates request", "Apex submission is before the client request date.", "high", [r.originalClientRequestDate, r.opsSubmissionDateToApex]));
    if (submitToComplete != null && submitToComplete < 0) items.push(exception(r, "completion_before_submission", "Completion predates submission", "Apex completion is before the submission date.", "high", [r.opsSubmissionDateToApex, r.apexCompletionDate]));
    if (r.direction?.toLowerCase() === "out" && (r.statementAmount ?? 0) > 0) items.push(exception(r, "outgoing_positive_value", "Outgoing transfer has positive value", "Outgoing values are expected to use the established negative sign convention.", "medium", [r.direction, r.statementAmount]));
    if (workflow === "RESIDUAL" && (!r.associatedControlNumber || !parents.has(r.associatedControlNumber.trim()))) items.push(exception(r, "residual_missing_parent", "Residual has no linked parent", "The associated control number is blank or does not match an original transfer.", "high", [r.associatedControlNumber]));
    if (workflow === "RESIDUAL" && (r.feeCharged?.toLowerCase() === "yes" || r.feeAmount?.trim())) items.push(exception(r, "residual_has_fee", "Residual has a transfer fee", "Residual credits should not carry transfer-fee reimbursement data.", "medium", [r.feeCharged, r.feeAmount]));
    const transferType = r.type?.trim().toLowerCase();
    const crmRequired = r.status === "Completed" && workflow !== "RESIDUAL"
      && (transferType === "full" || transferType === "partial" || r.direction?.trim().toLowerCase() === "out");
    if (crmRequired && !r.crmTicket?.trim()) items.push(exception(r, "missing_crm_ticket", "Required CRM ticket is missing", "Add the CRM ticket for this completed full, partial, or outgoing transfer.", "medium", [r.type, r.direction, r.crmTicket]));
    if (workflow === "UNCLASSIFIED") items.push(exception(r, "workflow_unclassified", "Workflow is unclassified", "Choose ACAT, Manual, DRS, or Residual without changing the request method.", "low", [r.transferWorkflow, r.methodRequested, r.type]));
    if (workflow === "ACAT" && r.transferringContra?.trim() && !["Rejected", "Purged", "Canceled", "Deferred"].includes(r.status)) {
      const key = r.transferringContra.trim().toLowerCase();
      const suggestion = suggestions.get(key) ?? suggestDtccNumber(records, [], r.transferringContra);
      suggestions.set(key, suggestion);
      if (!r.dtccNumber?.trim()) {
        const detail = suggestion.status === "suggested"
          ? `Add suggested DTC ${suggestion.dtccNumber}; the contra’s historical values agree.`
          : suggestion.status === "ambiguous"
            ? "Historical DTC values conflict for this contra. Leave blank until a human verifies the correct number."
            : "No reliable DTC suggestion is available yet. Verify the number before populating it.";
        items.push(exception(r, "missing_dtcc_number", "ACAT is missing a DTC number", detail, suggestion.status === "ambiguous" ? "medium" : "low", [r.transferringContra, suggestion.status, suggestion.dtccNumber]));
      } else if (!normalizeDtccNumber(r.dtccNumber)) {
        items.push(exception(r, "invalid_dtcc_number", "DTC number is not four digits", "Enter the contra’s four-digit DTC participant number.", "medium", [r.dtccNumber]));
      }
    }
    if (r.feeAmount?.trim()) {
      const normalized = normalizeMoneyStringExact(r.feeAmount);
      if (!normalized) items.push(exception(r, "invalid_fee_amount", "Fee amount is not a valid dollar value", "Enter a numeric fee amount such as $50.00.", "medium", [r.feeAmount]));
      else if (r.feeAmount.trim() !== normalized) items.push(exception(r, "fee_amount_format", "Fee amount needs consistent formatting", `Save the fee as ${normalized}.`, "low", [r.feeAmount, normalized]));
    }
    for (const [field, label] of [
      ["originalClientRequestDate", "Original Client Request Date"], ["opsSubmissionDateToApex", "Ops Submission Date to Apex"],
      ["apexCompletionDate", "Apex Completion Date"], ["residualFollowUpDate", "Residual Follow-Up Date"],
    ] as const) {
      const value = r[field];
      if (value && !normalizeDateToIso(value)) items.push(exception(r, "invalid_date", "Date cannot be interpreted", `${label} must be a valid date.`, "high", [field, value]));
    }
    const control = r.controlNumber?.trim();
    if (control && control.toLowerCase() === "to come" && TERMINAL_STATUSES.has(r.status)) {
      const detail = r.status === "Completed"
        ? "Replace the temporary ‘To Come’ value with the completed transfer’s actual control number."
        : "Clear the temporary ‘To Come’ value because this transfer is finalized and will not receive a control number.";
      items.push(exception(r, "finalized_placeholder_control", "Finalized transfer has ‘To Come’ control", detail, r.status === "Completed" ? "high" : "low", [r.status, control]));
    }
    if (control && control.toLowerCase() === "manual") {
      const detail = workflow === "MANUAL"
        ? "Clear the control number; Transfer Workflow already identifies this as Manual."
        : "Set Transfer Workflow to Manual, then clear the control number because ‘Manual’ is not a Apex control number.";
      items.push(exception(r, "manual_control_marker", "Manual marker belongs in Transfer Workflow", detail, "low", [r.transferWorkflow, r.methodRequested, control]));
    }
    if (control && !NON_UNIQUE_CONTROL_MARKERS.has(control.toLowerCase()) && (controlCounts.get(control) ?? 0) > 1) {
      items.push(exception(r, "duplicate_control", "Duplicate control number", `Control number ${control} appears on multiple records.`, "medium", [control, controlCounts.get(control)]));
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title));
}

function dashboardExceptions(records: TrackerRecord[], now: Date): Exception[] {
  const residual = residualMonitorQueue(records, now).map((item) => ({
    record: item.record,
    ruleKey: "residual_sweep_missing",
    fingerprint: `${item.record.apexCompletionDate}|${item.followUpDate}`,
    title: "Residual sweep needs follow-up",
    detail: `${item.daysPastFollowUp} days past the ${formatDateMMDDYYYY(item.followUpDate)} follow-up date; no linked residual was found.`,
    severity: "medium" as const,
  }));
  return [...residual, ...dataQualityExceptions(records)];
}

/** The tracker's composeDashboardContract over the live records and their exception reviews. */
export function composeDashboard(records: TrackerRecord[], now = new Date()) {
  const reviews = new Map(records.flatMap((r) => r.reviews.map((review) => [`${r.id}|${review.ruleKey}|${review.fingerprint}`, review] as const)));
  const summary = (r: TrackerRecord) => ({ id: r.id, clientName: r.clientName, transferringContra: r.transferringContra ?? null });
  return {
    summary: finalizedSummary(records),
    workflowTimings: workflowTimings(records),
    monthlyVolume: monthlyTransferVolume(records, now),
    flow: flowSummary(records),
    topContras: { acat: contraPerformance(records, "ACAT").slice(0, 5), manual: contraPerformance(records, "MANUAL").slice(0, 5) },
    residuals: {
      queue: residualMonitorQueue(records, now).map((item) => ({ record: summary(item.record), followUpDate: item.followUpDate, daysPastFollowUp: item.daysPastFollowUp })),
      benchmarks: residualBenchmarks(records),
    },
    quality: {
      rules: DATA_QUALITY_RULES,
      exceptions: dashboardExceptions(records, now).map((item) => {
        const review = reviews.get(`${item.record.id}|${item.ruleKey}|${item.fingerprint}`);
        return {
          record: summary(item.record), ruleKey: item.ruleKey, fingerprint: item.fingerprint, title: item.title,
          detail: item.detail, severity: item.severity,
          review: review ? { status: review.status, resolution: review.resolution ?? null, note: review.note ?? null,
            reviewedBy: review.reviewedBy ?? null, reviewedAt: review.reviewedAt ?? null } : null,
        };
      }),
    },
    reconciliation: reconCoverage(records),
  };
}
