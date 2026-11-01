import { getAssetCounts, hasApexUpload } from "./acat-derivations";
import {
  AcatRecord,
  TERMINAL_STATUSES,
  TransferWorkflow,
  TRANSFER_WORKFLOWS,
} from "./types";
import { formatDateMMDDYYYY, formatMoneyStringExact, normalizeDateToIso, normalizeMoneyStringExact } from "./format";
import { normalizeDtccNumber, suggestDtccNumber } from "./dtcc-suggestion";

const DAY_MS = 86_400_000;
const FINALIZED_OUTCOMES = ["Completed", "Rejected", "Canceled"] as const;
const TEMPORARY_CONTROL_NUMBER_PLACEHOLDERS = new Set(["to come"]);
const NON_UNIQUE_CONTROL_NUMBER_MARKERS = new Set(["to come", "manual"]);
const ACATS_HOLIDAY_CACHE = new Map<number, Set<string>>();

export interface Distribution {
  average: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  sampleSize: number;
}

export interface WorkflowTiming {
  workflow: TransferWorkflow;
  requestToSubmit: Distribution;
  submitToComplete: Distribution;
  requestToComplete: Distribution;
}

export interface MonthlyVolume {
  month: string;
  label: string;
  total: number;
  workflows: Record<TransferWorkflow, number>;
}

export interface ContraPerformance {
  contra: string;
  completed: number;
  finalized: number;
  rejectionRate: number;
  medianApexDays: number | null;
  completedAmount: number;
}

export interface ResidualBenchmark {
  contra: string;
  sampleSize: number;
  medianDays: number | null;
  p75Days: number | null;
  p90Days: number | null;
}

export interface ResidualFollowUpBenchmark {
  days: number;
  sampleSize: number;
  source: "contra" | "global" | "fallback";
}

export interface ResidualMonitorItem {
  record: AcatRecord;
  followUpDate: string;
  daysPastFollowUp: number;
  benchmarkDays: number;
}

export type DataQualitySeverity = "high" | "medium" | "low";

export interface DataQualityException {
  record: AcatRecord;
  ruleKey: string;
  fingerprint: string;
  title: string;
  detail: string;
  severity: DataQualitySeverity;
}

export interface DataQualityRuleDefinition {
  ruleKey: string;
  title: string;
  description: string;
}

export const DATA_QUALITY_RULES: DataQualityRuleDefinition[] = [
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

function timestamp(value?: string | null): number | null {
  const normalized = normalizeDateToIso(value);
  if (!normalized) return null;
  const parsed = new Date(`${normalized}T00:00:00Z`).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function observedFixedHoliday(year: number, month: number, day: number): string {
  const holiday = new Date(Date.UTC(year, month, day));
  const weekday = holiday.getUTCDay();
  if (weekday === 0) holiday.setUTCDate(holiday.getUTCDate() + 1);
  if (weekday === 6) holiday.setUTCDate(holiday.getUTCDate() - 1);
  return dateKey(holiday);
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, occurrence: number): string {
  const date = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(1 + offset + (occurrence - 1) * 7);
  return dateKey(date);
}

function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const date = new Date(Date.UTC(year, month + 1, 0));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - weekday + 7) % 7));
  return dateKey(date);
}

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month, day));
}

function acatsClosedDates(year: number): Set<string> {
  const cached = ACATS_HOLIDAY_CACHE.get(year);
  if (cached) return cached;
  const easter = easterSunday(year);
  const goodFriday = new Date(easter);
  goodFriday.setUTCDate(easter.getUTCDate() - 2);
  // Annual DTCC ACATS calendars close on these securities-industry holidays.
  // Columbus Day and Veterans Day remain processing days and are intentionally excluded.
  const holidays = new Set([
    observedFixedHoliday(year, 0, 1),
    nthWeekdayOfMonth(year, 0, 1, 3),
    nthWeekdayOfMonth(year, 1, 1, 3),
    dateKey(goodFriday),
    lastWeekdayOfMonth(year, 4, 1),
    observedFixedHoliday(year, 5, 19),
    observedFixedHoliday(year, 6, 4),
    nthWeekdayOfMonth(year, 8, 1, 1),
    nthWeekdayOfMonth(year, 10, 4, 4),
    observedFixedHoliday(year, 11, 25),
  ]);
  ACATS_HOLIDAY_CACHE.set(year, holidays);
  return holidays;
}

export function isAcatsBusinessDay(date: Date): boolean {
  const weekday = date.getUTCDay();
  const year = date.getUTCFullYear();
  const key = dateKey(date);
  return weekday !== 0 && weekday !== 6 && !acatsClosedDates(year).has(key) && !acatsClosedDates(year + 1).has(key);
}

function isControlNumberPlaceholder(value?: string | null): boolean {
  return TEMPORARY_CONTROL_NUMBER_PLACEHOLDERS.has(value?.trim().toLowerCase() ?? "");
}

function isNonUniqueControlNumberMarker(value?: string | null): boolean {
  return NON_UNIQUE_CONTROL_NUMBER_MARKERS.has(value?.trim().toLowerCase() ?? "");
}

function isManualControlNumberMarker(value?: string | null): boolean {
  return value?.trim().toLowerCase() === "manual";
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
    if (isAcatsBusinessDay(cursor)) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function percentile(sorted: number[], ratio: number): number | null {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function distribution(values: Array<number | null>): Distribution {
  const clean = values
    .filter((value): value is number => value != null && Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (clean.length === 0) {
    return { average: null, median: null, p75: null, p90: null, sampleSize: 0 };
  }
  return {
    average: clean.reduce((sum, value) => sum + value, 0) / clean.length,
    median: percentile(clean, 0.5),
    p75: percentile(clean, 0.75),
    p90: percentile(clean, 0.9),
    sampleSize: clean.length,
  };
}

export function workflowFor(record: AcatRecord): TransferWorkflow {
  if (record.type?.trim().toLowerCase() === "residual credit") return "RESIDUAL";
  if (record.transferWorkflow && record.transferWorkflow !== "UNCLASSIFIED") {
    return record.transferWorkflow;
  }
  const method = record.methodRequested?.toLowerCase() ?? "";
  if (method.includes("api")) return "ACAT";
  if (method.includes("non-acat transfer (manual)")) return "MANUAL";
  return "UNCLASSIFIED";
}

export function finalizedSummary(records: AcatRecord[]) {
  const counts = { Completed: 0, Rejected: 0, Canceled: 0, Purged: 0, active: 0 };
  for (const record of records) {
    if (record.status in counts) {
      counts[record.status as keyof Omit<typeof counts, "active">]++;
    } else if (!TERMINAL_STATUSES.has(record.status)) {
      counts.active++;
    }
  }
  const validFinalized = FINALIZED_OUTCOMES.reduce((sum, status) => sum + counts[status], 0);
  return {
    ...counts,
    total: records.length,
    validFinalized,
    completedRate: validFinalized ? counts.Completed / validFinalized : 0,
    rejectionRate: validFinalized ? counts.Rejected / validFinalized : 0,
    canceledRate: validFinalized ? counts.Canceled / validFinalized : 0,
  };
}

export function workflowTimings(records: AcatRecord[]): WorkflowTiming[] {
  return TRANSFER_WORKFLOWS.map((workflow) => {
    const bucket = records.filter(
      (record) => workflowFor(record) === workflow && record.status === "Completed"
    );
    return {
      workflow,
      requestToSubmit: distribution(
        bucket.map((record) =>
          businessDaysBetween(record.originalClientRequestDate, record.opsSubmissionDateToApex)
        )
      ),
      submitToComplete: distribution(
        bucket.map((record) =>
          businessDaysBetween(record.opsSubmissionDateToApex, record.apexCompletionDate)
        )
      ),
      requestToComplete: distribution(
        bucket.map((record) =>
          businessDaysBetween(record.originalClientRequestDate, record.apexCompletionDate)
        )
      ),
    };
  });
}

/** Volume history starts here; earlier request dates are back-filled and not counted. */
export const VOLUME_FLOOR_MONTH = "2025-06";

/** The first month with a client request, never before the floor or after `end`. */
export function volumeStartMonth(records: AcatRecord[], end: string, floor = VOLUME_FLOOR_MONTH): string {
  let first: string | null = null;
  for (const record of records) {
    if (workflowFor(record) === "RESIDUAL") continue;
    const key = normalizeDateToIso(record.originalClientRequestDate)?.slice(0, 7);
    if (key && key >= floor && key <= end && (!first || key < first)) first = key;
  }
  return first ?? floor;
}

export function monthlyTransferVolume(
  records: AcatRecord[],
  startMonth?: string,
  now = new Date()
): MonthlyVolume[] {
  const end = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  startMonth ??= volumeStartMonth(records, end);
  const months: MonthlyVolume[] = [];
  let [year, month] = startMonth.split("-").map(Number);
  while (`${year}-${String(month).padStart(2, "0")}` <= end) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    months.push({
      month: key,
      label: new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
      total: 0,
      workflows: Object.fromEntries(TRANSFER_WORKFLOWS.map((value) => [value, 0])) as Record<TransferWorkflow, number>,
    });
    month++;
    if (month === 13) {
      month = 1;
      year++;
    }
  }
  const byMonth = new Map(months.map((item) => [item.month, item]));
  for (const record of records) {
    const workflow = workflowFor(record);
    if (workflow === "RESIDUAL") continue;
    const key = normalizeDateToIso(record.originalClientRequestDate)?.slice(0, 7);
    const item = key ? byMonth.get(key) : undefined;
    if (!item) continue;
    item.total++;
    item.workflows[workflow]++;
  }
  return months;
}

export function contraPerformance(records: AcatRecord[], workflow: TransferWorkflow): ContraPerformance[] {
  const workflowRecords = records.filter((record) => workflowFor(record) === workflow);
  const names = new Set(
    workflowRecords.map((record) => record.transferringContra?.trim()).filter((value): value is string => Boolean(value))
  );
  return [...names]
    .map((contra) => {
      const bucket = workflowRecords.filter((record) => record.transferringContra?.trim() === contra);
      const finalized = bucket.filter((record) => FINALIZED_OUTCOMES.includes(record.status as (typeof FINALIZED_OUTCOMES)[number]));
      const completed = bucket.filter((record) => record.status === "Completed");
      return {
        contra,
        completed: completed.length,
        finalized: finalized.length,
        rejectionRate: finalized.length
          ? finalized.filter((record) => record.status === "Rejected").length / finalized.length
          : 0,
        medianApexDays: distribution(
          completed.map((record) => businessDaysBetween(record.opsSubmissionDateToApex, record.apexCompletionDate))
        ).median,
        completedAmount: completed.reduce((sum, record) => sum + Math.abs(record.statementAmount ?? 0), 0),
      };
    })
    .sort((a, b) => b.completed - a.completed || a.contra.localeCompare(b.contra));
}

function parentByControl(records: AcatRecord[]): Map<string, AcatRecord> {
  return new Map(
    records
      .filter(
        (record) =>
          record.controlNumber?.trim() &&
          !isNonUniqueControlNumberMarker(record.controlNumber) &&
          workflowFor(record) !== "RESIDUAL"
      )
      .map((record) => [record.controlNumber!.trim(), record])
  );
}

function residualLagRows(records: AcatRecord[]): Array<{ contra: string; days: number }> {
  const parents = parentByControl(records);
  const rows: Array<{ contra: string; days: number }> = [];
  for (const residual of records.filter((record) => workflowFor(record) === "RESIDUAL")) {
    const parent = residual.associatedControlNumber
      ? parents.get(residual.associatedControlNumber.trim())
      : undefined;
    const lag = calendarDaysBetween(parent?.apexCompletionDate, residual.apexCompletionDate);
    if (lag == null || lag < 0) continue;
    const contra = parent?.transferringContra?.trim() || residual.transferringContra?.trim() || "Unknown contra";
    rows.push({ contra, days: lag });
  }
  return rows;
}

export function residualBenchmarks(records: AcatRecord[]): ResidualBenchmark[] {
  const lagByContra = new Map<string, number[]>();
  for (const row of residualLagRows(records)) {
    lagByContra.set(row.contra, [...(lagByContra.get(row.contra) ?? []), row.days]);
  }
  return [...lagByContra.entries()]
    .map(([contra, lags]) => {
      const stats = distribution(lags);
      return {
        contra,
        sampleSize: stats.sampleSize,
        medianDays: stats.median,
        p75Days: stats.p75,
        p90Days: stats.p90,
      };
    })
    .sort((a, b) => b.sampleSize - a.sampleSize || a.contra.localeCompare(b.contra));
}

export function residualFollowUpBenchmark(
  records: AcatRecord[],
  contra?: string | null,
  minimumContraSample = 10
): ResidualFollowUpBenchmark {
  const rows = residualLagRows(records);
  const normalized = contra?.trim().toLowerCase();
  const contraLags = normalized
    ? rows.filter((row) => row.contra.toLowerCase() === normalized).map((row) => row.days)
    : [];
  if (contraLags.length >= minimumContraSample) {
    return { days: Math.ceil(distribution(contraLags).p75 ?? 27), sampleSize: contraLags.length, source: "contra" };
  }
  const allLags = rows.map((row) => row.days);
  if (allLags.length > 0) {
    return { days: Math.ceil(distribution(allLags).p75 ?? 27), sampleSize: allLags.length, source: "global" };
  }
  return { days: 27, sampleSize: 0, source: "fallback" };
}

export function residualMonitorQueue(records: AcatRecord[], now = new Date()): ResidualMonitorItem[] {
  const residualParents = new Set(
    records
      .filter((record) => workflowFor(record) === "RESIDUAL" && record.associatedControlNumber)
      .map((record) => record.associatedControlNumber!.trim())
  );
  return records
    .filter(
      (record) =>
        record.residualMonitoringRequired &&
        record.status === "Completed" &&
        workflowFor(record) !== "RESIDUAL" &&
        record.controlNumber &&
        !residualParents.has(record.controlNumber.trim())
    )
    .map((record) => {
      const benchmarkDays = residualFollowUpBenchmark(records, record.transferringContra).days;
      const calculated = timestamp(record.apexCompletionDate);
      const followUpDate =
        record.residualFollowUpDate ||
        (calculated == null ? "" : new Date(calculated + benchmarkDays * DAY_MS).toISOString().slice(0, 10));
      return {
        record,
        followUpDate,
        benchmarkDays,
        daysPastFollowUp: Math.max(0, calendarDaysBetween(followUpDate, now.toISOString().slice(0, 10)) ?? 0),
      };
    })
    .filter((item) => item.followUpDate && timestamp(item.followUpDate)! <= now.getTime())
    .sort((a, b) => b.daysPastFollowUp - a.daysPastFollowUp);
}

export function flowSummary(records: AcatRecord[]) {
  const completed = records.filter((record) => record.status === "Completed");
  const incoming = completed.filter((record) => record.direction?.toLowerCase() === "in");
  const outgoing = completed.filter((record) => record.direction?.toLowerCase() === "out");
  const amount = (bucket: AcatRecord[]) =>
    bucket.reduce((sum, record) => sum + Math.abs(record.statementAmount ?? 0), 0);
  const split = (bucket: AcatRecord[]) => {
    const residual = bucket.filter((record) => workflowFor(record) === "RESIDUAL");
    const requested = bucket.filter((record) => workflowFor(record) !== "RESIDUAL");
    return {
      totalCount: bucket.length,
      totalAmount: amount(bucket),
      requestedCount: requested.length,
      requestedAmount: amount(requested),
      residualCount: residual.length,
      residualAmount: amount(residual),
    };
  };
  const incomingFlow = split(incoming);
  const outgoingFlow = split(outgoing);
  return {
    incoming: incomingFlow,
    outgoing: outgoingFlow,
    netAmount: incomingFlow.totalAmount - outgoingFlow.totalAmount,
    requestedNetAmount: incomingFlow.requestedAmount - outgoingFlow.requestedAmount,
    residualNetAmount: incomingFlow.residualAmount - outgoingFlow.residualAmount,
  };
}

export function reconCoverage(records: AcatRecord[]) {
  const eligible = records.filter(
    (record) => record.status === "Completed" && workflowFor(record) !== "RESIDUAL"
  );
  const tracked = eligible.filter(
    (record) => Boolean(record.reconCompletedAt) || hasApexUpload(record) || (record.assets?.length ?? 0) > 0
  );
  let matched = 0;
  let mismatch = 0;
  let pending = 0;
  for (const record of tracked) {
    const counts = getAssetCounts({ ...record, assets: record.assets ?? [] });
    if (record.reconCompletedAt || (counts.mismatch === 0 && counts.pending === 0 && counts.matched > 0)) matched++;
    else if (counts.mismatch > 0) mismatch++;
    else pending++;
  }
  return {
    eligible: eligible.length,
    tracked: tracked.length,
    notTracked: eligible.length - tracked.length,
    coverageRate: eligible.length ? tracked.length / eligible.length : 0,
    matched,
    mismatch,
    pending,
    matchRate: matched + mismatch ? matched / (matched + mismatch) : null,
  };
}

function exception(
  record: AcatRecord,
  ruleKey: string,
  title: string,
  detail: string,
  severity: DataQualitySeverity,
  values: unknown[]
): DataQualityException {
  return { record, ruleKey, title, detail, severity, fingerprint: values.map(String).join("|").slice(0, 500) };
}

export function dataQualityExceptions(records: AcatRecord[]): DataQualityException[] {
  const items: DataQualityException[] = [];
  const parents = parentByControl(records);
  const controlCounts = new Map<string, number>();
  const dtccSuggestions = new Map<string, ReturnType<typeof suggestDtccNumber>>();
  for (const record of records) {
    const control = record.controlNumber?.trim();
    if (control && !isNonUniqueControlNumberMarker(control)) {
      controlCounts.set(control, (controlCounts.get(control) ?? 0) + 1);
    }
  }
  for (const record of records) {
    const workflow = workflowFor(record);
    const requestToSubmit = calendarDaysBetween(record.originalClientRequestDate, record.opsSubmissionDateToApex);
    const submitToComplete = calendarDaysBetween(record.opsSubmissionDateToApex, record.apexCompletionDate);
    if (record.status === "Completed" && !record.apexCompletionDate) {
      items.push(exception(record, "completed_missing_date", "Completed without Apex date", "The transfer is completed but has no Apex completion date.", "high", [record.status, record.apexCompletionDate]));
    }
    if (record.status === "Rejected" && !record.rejectionReason?.trim()) {
      items.push(exception(record, "rejected_missing_reason", "Rejected without reason", "Add a rejection reason so the outcome can be analyzed.", "medium", [record.status, record.rejectionReason]));
    }
    if (requestToSubmit != null && requestToSubmit < 0) {
      items.push(exception(record, "submission_before_request", "Submission predates request", "Apex submission is before the client request date.", "high", [record.originalClientRequestDate, record.opsSubmissionDateToApex]));
    }
    if (submitToComplete != null && submitToComplete < 0) {
      items.push(exception(record, "completion_before_submission", "Completion predates submission", "Apex completion is before the submission date.", "high", [record.opsSubmissionDateToApex, record.apexCompletionDate]));
    }
    if (record.direction?.toLowerCase() === "out" && (record.statementAmount ?? 0) > 0) {
      items.push(exception(record, "outgoing_positive_value", "Outgoing transfer has positive value", "Outgoing values are expected to use the established negative sign convention.", "medium", [record.direction, record.statementAmount]));
    }
    if (workflow === "RESIDUAL" && (!record.associatedControlNumber || !parents.has(record.associatedControlNumber.trim()))) {
      items.push(exception(record, "residual_missing_parent", "Residual has no linked parent", "The associated control number is blank or does not match an original transfer.", "high", [record.associatedControlNumber]));
    }
    if (workflow === "RESIDUAL" && (record.feeCharged?.toLowerCase() === "yes" || record.feeAmount?.trim())) {
      items.push(exception(record, "residual_has_fee", "Residual has a transfer fee", "Residual credits should not carry transfer-fee reimbursement data.", "medium", [record.feeCharged, record.feeAmount]));
    }
    const transferType = record.type?.trim().toLowerCase();
    const crmRequired =
      record.status === "Completed" &&
      workflow !== "RESIDUAL" &&
      (transferType === "full" ||
        transferType === "partial" ||
        record.direction?.trim().toLowerCase() === "out");
    if (crmRequired && !record.crmTicket?.trim()) {
      items.push(exception(
        record,
        "missing_crm_ticket",
        "Required CRM ticket is missing",
        "Add the CRM ticket for this completed full, partial, or outgoing transfer.",
        "medium",
        [record.type, record.direction, record.crmTicket]
      ));
    }
    if (workflow === "UNCLASSIFIED") {
      items.push(exception(record, "workflow_unclassified", "Workflow is unclassified", "Choose ACAT, Manual, DRS, or Residual without changing the request method.", "low", [record.transferWorkflow, record.methodRequested, record.type]));
    }
    if (
      workflow === "ACAT" &&
      record.transferringContra?.trim() &&
      !["Rejected", "Purged", "Canceled", "Deferred"].includes(record.status)
    ) {
      const contraKey = record.transferringContra.trim().toLowerCase();
      const suggestion = dtccSuggestions.get(contraKey) ?? suggestDtccNumber(records, [], record.transferringContra);
      dtccSuggestions.set(contraKey, suggestion);
      if (!record.dtccNumber?.trim()) {
        const detail = suggestion.status === "suggested"
          ? `Add suggested DTC ${suggestion.dtccNumber}; the contra’s historical values agree.`
          : suggestion.status === "ambiguous"
            ? "Historical DTC values conflict for this contra. Leave blank until a human verifies the correct number."
            : "No reliable DTC suggestion is available yet. Verify the number before populating it.";
        items.push(exception(record, "missing_dtcc_number", "ACAT is missing a DTC number", detail, suggestion.status === "ambiguous" ? "medium" : "low", [record.transferringContra, suggestion.status, suggestion.dtccNumber]));
      } else if (!normalizeDtccNumber(record.dtccNumber)) {
        items.push(exception(record, "invalid_dtcc_number", "DTC number is not four digits", "Enter the contra’s four-digit DTC participant number.", "medium", [record.dtccNumber]));
      }
    }
    if (record.feeAmount?.trim()) {
      const normalizedFee = normalizeMoneyStringExact(record.feeAmount);
      if (!normalizedFee) {
        items.push(exception(record, "invalid_fee_amount", "Fee amount is not a valid dollar value", "Enter a numeric fee amount such as $50.00.", "medium", [record.feeAmount]));
      } else if (record.feeAmount.trim() !== normalizedFee) {
        items.push(exception(record, "fee_amount_format", "Fee amount needs consistent formatting", `Save the fee as ${formatMoneyStringExact(record.feeAmount)}.`, "low", [record.feeAmount, normalizedFee]));
      }
    }
    for (const [field, label] of [
      ["originalClientRequestDate", "Original Client Request Date"],
      ["opsSubmissionDateToApex", "Ops Submission Date to Apex"],
      ["apexCompletionDate", "Apex Completion Date"],
      ["residualFollowUpDate", "Residual Follow-Up Date"],
    ] as const) {
      const value = record[field];
      if (value && !normalizeDateToIso(value)) {
        items.push(exception(record, "invalid_date", "Date cannot be interpreted", `${label} must be a valid date.`, "high", [field, value]));
      }
    }
    const control = record.controlNumber?.trim();
    if (control && isControlNumberPlaceholder(control) && TERMINAL_STATUSES.has(record.status)) {
      const detail = record.status === "Completed"
        ? "Replace the temporary ‘To Come’ value with the completed transfer’s actual control number."
        : "Clear the temporary ‘To Come’ value because this transfer is finalized and will not receive a control number.";
      items.push(exception(record, "finalized_placeholder_control", "Finalized transfer has ‘To Come’ control", detail, record.status === "Completed" ? "high" : "low", [record.status, control]));
    }
    if (control && isManualControlNumberMarker(control)) {
      const detail = workflow === "MANUAL"
        ? "Clear the control number; Transfer Workflow already identifies this as Manual."
        : "Set Transfer Workflow to Manual, then clear the control number because ‘Manual’ is not a Apex control number.";
      items.push(exception(record, "manual_control_marker", "Manual marker belongs in Transfer Workflow", detail, "low", [record.transferWorkflow, record.methodRequested, control]));
    }
    if (control && !isNonUniqueControlNumberMarker(control) && (controlCounts.get(control) ?? 0) > 1) {
      items.push(exception(record, "duplicate_control", "Duplicate control number", `Control number ${control} appears on multiple records.`, "medium", [control, controlCounts.get(control)]));
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title));
}

export function dashboardDataQualityExceptions(
  records: AcatRecord[],
  now = new Date(),
): DataQualityException[] {
  const residualExceptions = residualMonitorQueue(records, now).map((item) => ({
    record: item.record,
    ruleKey: "residual_sweep_missing",
    fingerprint: `${item.record.apexCompletionDate}|${item.followUpDate}`,
    title: "Residual sweep needs follow-up",
    detail: `${item.daysPastFollowUp} days past the ${formatDateMMDDYYYY(item.followUpDate)} follow-up date; no linked residual was found.`,
    severity: "medium" as const,
  }));
  return [...residualExceptions, ...dataQualityExceptions(records)];
}
