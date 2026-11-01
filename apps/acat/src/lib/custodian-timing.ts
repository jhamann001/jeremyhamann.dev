import { businessDaysBetween } from "./transfer-analytics";

const RESIDUAL_TRANSFER_TYPE = "Residual Credit";

export interface CustodianTimingRecord {
  custodianId?: string | null;
  originalClientRequestDate?: string | null;
  acatDate?: string | null;
  apexCompletionDate?: string | null;
  type?: string | null;
}

export interface CustodianTimingSummary {
  observedAvgProcessingBusinessDays: number;
  observedCompletedTransfers: number;
}

/**
 * ACATS business days from the client's original request (falling back to the
 * ACAT reference date) through Apex completion. Weekends and ACATS processing
 * holidays are excluded so this matches the transfer dashboard definition.
 */
export function getObservedCompletionDays(
  record: Pick<
    CustodianTimingRecord,
    "originalClientRequestDate" | "acatDate" | "apexCompletionDate"
  >
): number | null {
  const startRaw = record.originalClientRequestDate ?? record.acatDate;
  const endRaw = record.apexCompletionDate;
  if (!startRaw || !endRaw) return null;

  const start = new Date(startRaw).getTime();
  const end = new Date(endRaw).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;

  const days = businessDaysBetween(startRaw, endRaw);
  return days == null ? null : days;
}

/**
 * Build observed per-custodian averages from completed transfer history.
 * Residual credits are excluded because they are follow-on settlements rather
 * than the primary transfer and otherwise skew completion timing downward.
 */
export function summarizeCustodianTimings(
  records: CustodianTimingRecord[]
): Map<string, CustodianTimingSummary> {
  const totals = new Map<string, { totalDays: number; count: number }>();

  for (const record of records) {
    if (!record.custodianId || record.type === RESIDUAL_TRANSFER_TYPE) continue;
    const days = getObservedCompletionDays(record);
    if (days === null) continue;

    const current = totals.get(record.custodianId) ?? { totalDays: 0, count: 0 };
    current.totalDays += days;
    current.count += 1;
    totals.set(record.custodianId, current);
  }

  return new Map(
    [...totals.entries()].map(([custodianId, value]) => [
      custodianId,
      {
        observedAvgProcessingBusinessDays: Math.round(value.totalDays / value.count),
        observedCompletedTransfers: value.count,
      },
    ])
  );
}
