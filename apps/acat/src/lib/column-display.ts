import { RecordFieldKey } from "./record-fields";

/**
 * Per-column display width in pixels for the records table. Drives both the
 * column header and each row's cells so they line up regardless of which
 * fields the user has chosen to display.
 *
 * Keys not present in this map fall back to {@link DEFAULT_COLUMN_WIDTH_PX}.
 */
export const COLUMN_WIDTH_PX: Partial<Record<RecordFieldKey, number>> = {
  id: 110,
  clientName: 200,
  status: 160,
  transferringContra: 140,
  custodianName: 140,
  custodianId: 110,
  direction: 60,
  type: 100,
  accountType: 110,
  controlNumber: 120,
  apexAccountId: 120,
  crmDealId: 110,
  wealthAdvisor: 140,
  statementAmount: 120,
  acatDate: 100,
  daysOpen: 70,
  assetCount: 70,
  issueCount: 70,
  notes: 200,
  methodRequested: 160,
  reconStatus: 130,
  reconCompletedAt: 130,
  // ticket: derived from opsSubmissionDateToApex + custodian SLA.
  expectedCompletionDate: 130,
  slackAlerted: 90,
};

export const DEFAULT_COLUMN_WIDTH_PX = 130;

export function getColumnWidthPx(key: RecordFieldKey): number {
  return COLUMN_WIDTH_PX[key] ?? DEFAULT_COLUMN_WIDTH_PX;
}
