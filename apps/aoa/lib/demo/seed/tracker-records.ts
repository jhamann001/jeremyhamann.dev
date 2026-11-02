// The tracker demo's plan as the demo's Transfer Tracker keeps it: one TrackerRecord per planned transfer (the
// tracker demo seed's transferRow, assetRows and auditRows), the fee store's rows each record's fee log reads, the
// data-quality reviews the tracker demo leaves on its dashboard, and the Cedar Ridge client directory (its
// directory.ts). Pure apart from the clock passed in.

import { createHash } from "node:crypto";
import { residualMonitorQueue, dataQualityExceptions } from "../stand-ins/tracker-analytics";
import type { TrackerClient, TrackerFeeLogRow, TrackerHistoryEntry, TrackerRecord, TrackerReview } from "../stand-ins/tracker-model";
import { addBusinessDays, calendarDaysBetween } from "./calendar";
import { accountOwners } from "./people";
import {
  TRACKER_ACCOUNT_TYPE, advisorFirstName, clearingNumber, firmCustodianId, type DemoPlan, type PlannedTransfer,
} from "./tracker-plan";
import { cedarRidgeUserId, seededInt, staffEmail, staffOf, storyDealId, type Universe, type UniversePerson } from "./universe";

type At = (day: string, key: string) => Date;

const iso = (date: Date) => date.toISOString();
const cents = (dollars: number) => Math.round(dollars * 100);

/** "Lucia Alvarez & Daniel Alvarez", or the single owner's name. */
export const ownerNames = (owners: UniversePerson[]): string => owners.map((p) => `${p.first} ${p.last}`).join(" & ");

/** The tracker demo's operator (transfer specialist) and reviewer (operations lead). */
export function trackerStaff(universe: Universe) {
  return { operator: staffEmail(staffOf(universe, "jordan-reyes")), reviewer: staffEmail(staffOf(universe, "marco-ferreira")) };
}

/** The tracker demo's directory account id for a universe account (apps/acat/src/lib/demo/directory.ts). */
export const investmentAccountId = (accountId: string): string =>
  `inv-${createHash("sha256").update(`account:${accountId}`).digest("hex").slice(0, 24)}`;

/** The client directory: one entry per universe person with the Apex accounts they hold. */
export function trackerDirectory(universe: Universe): TrackerClient[] {
  return universe.people.map((p) => ({
    cedarRidgeUserId: cedarRidgeUserId(p.id),
    displayName: `${p.first} ${p.last}`,
    eligibility: "ACTIVE" as const,
    accounts: universe.accounts.flatMap((a) => {
      const index = accountOwners(universe, a).findIndex((o) => o.id === p.id);
      return index < 0 ? [] : [{
        investmentAccountId: investmentAccountId(a.id),
        custodian: "APEX",
        accountNumber: a.number,
        status: "OPEN",
        isCurrent: true,
        relationshipType: index === 0 ? "PRIMARY" : "JOINT",
      }];
    }),
  }));
}

function history(t: PlannedTransfer, ownerIds: string[], operator: string, reviewer: string, at: At): TrackerHistoryEntry[] {
  const rows: Omit<TrackerHistoryEntry, "id">[] = [
    { action: "identity-create", field: "cedarRidgeUserIds", oldValue: null, newValue: JSON.stringify(ownerIds),
      performedBy: operator, timestamp: iso(at(t.requestDay, `${t.id}:created`)) },
  ];
  const change = (day: string, field: string, oldValue: string | null, newValue: string | null, who = operator) =>
    rows.push({ action: "update", field, oldValue, newValue, performedBy: who, timestamp: iso(at(day, `${t.id}:${field}:${newValue}`)) });
  if (t.submissionDay) {
    change(t.submissionDay, "opsSubmissionDateToApex", null, t.submissionDay);
    change(t.submissionDay, "status", "AcatReceived", "Submitted");
    if (t.controlNumber && t.controlNumber !== "To Come") change(t.submissionDay, "controlNumber", null, t.controlNumber);
  }
  if (t.status !== "Submitted" && t.status !== "AcatReceived" && t.submissionDay) {
    change(t.lastDay, "status", "Submitted", t.status, t.status === "Completed" ? reviewer : operator);
  } else if (!t.submissionDay && t.status !== "AcatReceived") {
    change(t.lastDay, "status", "AcatReceived", t.status);
  }
  if (t.completionDay) change(t.completionDay, "apexCompletionDate", null, t.completionDay, reviewer);
  // Newest first, as the tracker adds them.
  return rows.map((row, i) => ({ id: `${t.id}-h${i + 1}`, ...row })).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function record(t: PlannedTransfer, universe: Universe, today: string, at: At, operator: string, reviewer: string): TrackerRecord {
  const owners = accountOwners(universe, t.account);
  const ownerIds = owners.map((p) => cedarRidgeUserId(p.id));
  const reconAt = t.reconComplete && t.completionDay
    ? iso(at(addBusinessDays(t.completionDay, 1) > today ? t.completionDay : addBusinessDays(t.completionDay, 1), `${t.id}:recon`))
    : null;
  const synced = t.assets.length > 0 && t.submissionDay ? iso(at(t.submissionDay, `${t.id}:mapping`)) : null;
  const assetSynced = t.submissionDay ? iso(at(t.submissionDay, `${t.id}:mapping`)) : null;
  const statementAge = t.statement ? calendarDaysBetween(t.statement.periodEnd, today) : null;
  return {
    id: t.id,
    createdAt: iso(at(t.requestDay, `${t.id}:created`)),
    deletedAt: null,
    lastUpdated: iso(at(t.lastDay, `${t.id}:updated`)),
    clientName: ownerNames(owners),
    cedarRidgeUserIds: [...ownerIds].sort(),
    // Linking the owners after the insert moves the tracker's identity version from 0 to 1.
    identityVersion: 1,
    controlNumber: t.controlNumber,
    acatTransferId: t.storyId ?? t.acatTransferId ?? null,
    direction: t.direction,
    type: t.type,
    accountType: TRACKER_ACCOUNT_TYPE[t.account.type],
    status: t.status,
    wealthAdvisor: advisorFirstName(universe, t.household),
    apexAccountId: t.account.number,
    statementAccountNumber: t.statementAccountNumber ?? null,
    transferringContra: t.firm.name,
    dtccNumber: t.dtcBlank ? null : clearingNumber(t.firm),
    statementAmount: cents(t.direction === "Out" ? -t.value : t.value),
    methodRequested: t.method,
    transferWorkflow: t.workflow,
    crwEe: "No",
    originalClientRequestDate: t.requestDay,
    opsSubmissionDateToApex: t.submissionDay,
    apexCompletionDate: t.completionDay,
    residualMonitoringRequired: t.residualMonitoring ?? false,
    residualFollowUpDate: t.residualFollowUpDay ?? null,
    feeCharged: t.fee?.feeCharged ?? null,
    feeAmount: t.fee?.feeAmount ?? null,
    feeMemo: t.fee?.feeMemo ?? null,
    feeRequestSubmitted: t.fee?.feeRequestSubmitted ?? null,
    feeRequestCompleted: t.fee?.feeRequestCompleted ?? null,
    feeApexTicket: t.fee?.feeApexTicket ?? null,
    feeCreditRequestId: t.fee?.feeCreditRequestId ?? null,
    crmTicket: t.workflow === "RESIDUAL" ? null : `OPP-${seededInt(`${t.id}:crm`, 2000, 9899)}`,
    apexTicket: t.workflow === "MANUAL" && t.submissionDay ? `APX-TKT-${seededInt(`${t.id}:tkt`, 100, 999)}` : null,
    additionalResources: null,
    tradeRequestId: null,
    tradeRequestUrl: null,
    tradeInstructions: t.tradeInstructions ?? null,
    notes: t.notes ?? null,
    associatedControlNumber: t.associatedControlNumber ?? null,
    rejectionReason: t.rejectionReason ?? null,
    // The tracker demo leaves the CRM deal blank; a story transfer carries the AoA deal it came from.
    crmDealId: t.storyId ? storyDealId(t.storyId) : "",
    custodianId: firmCustodianId(t.firm),
    custodianName: t.firm.name,
    custodianAvgProcessingDays: t.firm.avgDays,
    acatDate: t.submissionDay ?? t.requestDay,
    mappingSource: t.assets.length > 0 ? "GCP Project API" : "Not yet synced",
    mappingSyncedAt: synced,
    mappingAccountId: null,
    mappingAccountSummary: null,
    apexSource: t.reconComplete || t.assets.some((a) => a.mapStatus === "Unmapped") ? "Uploaded" : "Pending Upload",
    reconCompletedAt: reconAt,
    assets: t.assets.map((a, i) => ({
      id: `${t.id}-a${i + 1}`,
      symbol: a.symbol,
      description: a.description,
      cusip: null,
      expectedQty: a.expectedQty,
      actualQty: a.actualQty,
      mapStatus: a.mapStatus,
      issue: a.issue ?? null,
      notes: a.notes ?? null,
      amount: a.amount,
      assetClass: a.assetClass,
      includeInTransfer: t.type === "Partial" ? true : null,
      mappingTransferStatus: a.liquidate ? "Liquidate" : "Transfer in kind",
      mappingTransferNotes: null,
      mappingTransferring: true,
      mappingStatementDate: t.statement?.periodEnd ?? null,
      mappingStatementAgeDays: statementAge,
      mappingStatementIsStale: t.statement ? t.statement.stale : null,
      mappingSyncedAt: assetSynced,
    })),
    history: history(t, ownerIds, operator, reviewer, at),
    reviews: [],
    feeLog: [],
    titleConfirmation: null,
    documents: [],
    operations: [],
  };
}

// The tracker demo's REVIEW_PLAN: a few dashboard exceptions already being worked.
const REVIEW_PLAN: Array<{ ruleKey: string; status: TrackerReview["status"]; resolution?: string; note?: string; by?: "operator" | "reviewer" }> = [
  { ruleKey: "missing_dtcc_number", status: "OPEN" },
  { ruleKey: "fee_amount_format", status: "OPEN" },
  { ruleKey: "residual_sweep_missing", status: "IN_REVIEW", note: "Asked Apex whether a residual posted to the old account. Waiting to hear back.", by: "reviewer" },
  { ruleKey: "residual_sweep_missing", status: "CLOSED", resolution: "RESOLVED_MANUALLY", note: "The contra confirmed no residual is coming. Account closed with a zero balance.", by: "operator" },
];

export interface TrackerSeed {
  records: TrackerRecord[];
  feeCredits: Array<TrackerFeeLogRow & { clientName: string; accountNumbers: string }>;
  reviews: number;
  exceptions: Record<string, number>;
}

/** Every planned transfer as the demo's tracker keeps it, with fee logs and dashboard reviews. */
export function trackerSeed(universe: Universe, plan: DemoPlan, now: Date, at: At): TrackerSeed {
  const { today, transfers } = plan;
  const { operator, reviewer } = trackerStaff(universe);
  const records = transfers.map((t) => record(t, universe, today, at, operator, reviewer));

  // One older transfer was saved before fee amounts were normalized, for the data-quality queue.
  const legacyFee = [...transfers].reverse().find((t) => t.id.startsWith("tr-h") && !t.id.endsWith("-r") && t.status === "Completed"
    && t.direction === "In" && t.type === "Full" && t.firm.fees.some((f) => (f.amount ?? 0) > 0 && f.transferType !== "PARTIAL" && !f.accountType));
  const legacy = legacyFee && records.find((r) => r.id === legacyFee.id);
  if (legacy?.feeAmount) legacy.feeAmount = String(Number(legacy.feeAmount.slice(1)));

  // The fee store's rows, one per fee-credit request; a record's log is the rows for its client and account.
  const feeCredits = transfers.filter((t) => t.fee?.feeCreditRequestId).map((t) => {
    const row = records.find((r) => r.id === t.id)!;
    return {
      id: t.fee!.feeCreditRequestId!,
      status: (t.fee!.feeRequestCompleted ? "Credited" : "Pending") as TrackerFeeLogRow["status"],
      feeAmount: Number(String(t.fee!.feeAmount).replace(/[^0-9.]/g, "")),
      feeType: "ACAT Transfer Fee",
      submissionDate: iso(at(String(t.fee!.feeRequestSubmitted), `${t.id}:feesub`)),
      clientName: row.clientName,
      accountNumbers: t.account.number,
    };
  });
  for (const r of records) {
    r.feeLog = feeCredits.filter((c) => c.clientName === r.clientName && c.accountNumbers === r.apexAccountId)
      .map(({ id, status, feeAmount, feeType, submissionDate }) => ({ id, status, feeAmount, feeType, submissionDate }));
  }

  // Data-quality reviews for a few of the exceptions the dashboard finds, matched the way it matches them.
  const exceptions = [
    ...residualMonitorQueue(records, now).map((item) => ({
      record: item.record, ruleKey: "residual_sweep_missing", fingerprint: `${item.record.apexCompletionDate}|${item.followUpDate}`,
    })),
    ...dataQualityExceptions(records),
  ];
  const used = new Set<string>();
  let reviews = 0;
  for (const p of REVIEW_PLAN) {
    const item = exceptions.find((e) => e.ruleKey === p.ruleKey && !used.has(`${e.record.id}|${e.ruleKey}`));
    if (!item) continue;
    used.add(`${item.record.id}|${item.ruleKey}`);
    const by = p.by === "reviewer" ? reviewer : operator;
    item.record.reviews.push({
      ruleKey: item.ruleKey,
      fingerprint: item.fingerprint,
      status: p.status,
      resolution: p.resolution ?? null,
      note: p.note ?? null,
      reviewedBy: p.status === "OPEN" ? null : by,
      reviewedAt: p.status === "OPEN" ? null : iso(at(addBusinessDays(today, -1), `${item.record.id}:review`)),
    });
    reviews++;
  }
  const counts: Record<string, number> = {};
  for (const e of exceptions) counts[e.ruleKey] = (counts[e.ruleKey] ?? 0) + 1;
  return { records, feeCredits, reviews, exceptions: counts };
}
