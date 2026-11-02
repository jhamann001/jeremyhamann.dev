import { hasIssues } from "@/lib/acat-derivations";
import { toOperationalAcat } from "@/lib/acat-identity-dto";
import { RECORD_FIELDS_BY_KEY, type RecordFieldKey } from "@/lib/record-fields";
import type { AcatRecord, AcatStatus, Asset } from "@/lib/types";
import { normalizeDtccNumber } from "@/lib/dtcc-suggestion";

type NullableString = string | null | undefined;

export function maskIdentifier(value: NullableString): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (normalized.length <= 4) return "****";
  return `${"*".repeat(Math.min(8, normalized.length - 4))}${normalized.slice(-4)}`;
}

export function summarizeArgs(args: unknown): { summary: string; hashInput: string } {
  const json = JSON.stringify(args ?? {});
  return {
    summary: json.length > 500 ? `${json.slice(0, 500)}...` : json,
    hashInput: json,
  };
}

export function redactAcatListItem(record: {
  id: string;
  clientName: string;
  status: string;
  controlNumber?: string | null;
  apexAccountId: string;
  statementAccountNumber?: string | null;
  custodianName: string;
  acatDate: string;
  statementAmount?: number | null;
  feeCharged?: string | null;
  feeAmount?: string | null;
  feeMemo?: string | null;
  feeRequestSubmitted?: string | null;
  feeRequestCompleted?: string | null;
  createdAt: Date;
}) {
  return {
    id: record.id,
    clientName: record.clientName,
    status: record.status,
    controlNumber: record.controlNumber,
    apexAccountId: maskIdentifier(record.apexAccountId),
    statementAccountNumber: maskIdentifier(record.statementAccountNumber),
    custodianName: record.custodianName,
    acatDate: record.acatDate,
    statementAmount: record.statementAmount,
    feeCharged: record.feeCharged,
    feeAmount: record.feeAmount,
    feeMemo: record.feeMemo,
    feeRequestSubmitted: record.feeRequestSubmitted,
    feeRequestCompleted: record.feeRequestCompleted,
    createdAt: record.createdAt.toISOString(),
  };
}

// Server-to-server projection for an open transfer. Account identifiers and
// asset CUSIPs stay on maskIdentifier. Asset id and asset notes stay omitted.
// ticket: while the drawer contract is on, the caller may reveal the DTCC
// number (a custodian-level identifier, never an account number) and the
// identity version (an integer concurrency token). Apex account, statement
// account, and asset CUSIP stay masked in every mode.
export function redactAcatForMachine(record: {
  id: string;
  identityVersion?: number | null;
  clientName?: string | null;
  controlNumber?: string | null;
  acatTransferId?: string | null;
  direction?: string | null;
  type?: string | null;
  accountType?: string | null;
  status: string;
  wealthAdvisor?: string | null;
  notes?: string | null;
  associatedControlNumber?: string | null;
  transferWorkflow?: string | null;
  crwEe?: string | null;
  originalClientRequestDate?: string | null;
  opsSubmissionDateToApex?: string | null;
  apexCompletionDate?: string | null;
  residualMonitoringRequired?: boolean | null;
  residualFollowUpDate?: string | null;
  crmTicket?: string | null;
  crmDealId?: string | null;
  apexTicket?: string | null;
  additionalResources?: string | null;
  tradeInstructions?: string | null;
  tradeRequestId?: string | null;
  tradeRequestUrl?: string | null;
  rejectionReason?: string | null;
  apexAccountId: string;
  statementAccountNumber?: string | null;
  transferringContra?: string | null;
  dtccNumber?: string | null;
  statementAmount?: number | null;
  methodRequested?: string | null;
  feeCharged?: string | null;
  feeAmount?: string | null;
  feeMemo?: string | null;
  feeRequestSubmitted?: string | null;
  feeRequestCompleted?: string | null;
  feeApexTicket?: string | null;
  feeCreditRequestId?: string | null;
  acatDate: string;
  assets: Array<{
    symbol: string;
    description: string;
    cusip?: string | null;
    expectedQty: number;
    actualQty: number;
    mapStatus: string;
    issue?: string | null;
    amount?: number | null;
    assetClass?: string | null;
  }>;
}, options?: { revealDtcc?: boolean; includeIdentityVersion?: boolean }) {
  return {
    id: record.id,
    ...(options?.includeIdentityVersion && typeof record.identityVersion === "number"
      ? { identityVersion: record.identityVersion }
      : {}),
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
    apexAccountId: maskIdentifier(record.apexAccountId),
    statementAccountNumber: maskIdentifier(record.statementAccountNumber),
    transferringContra: record.transferringContra,
    dtccNumber: options?.revealDtcc
      ? (record.dtccNumber?.trim() ? (normalizeDtccNumber(record.dtccNumber) ?? record.dtccNumber) : null)
      : maskIdentifier(record.dtccNumber),
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

// Server-to-server projection for a machine caller's LIST view (e.g. the advisor platform
// "In Transfer" lane). Sibling to `redactAcatForMachine` but shaped for a
// lane row rather than a full record:
//
//  - clientName is KEPT — the lane displays it. (This is the deliberate
//    difference from `redactAcatForMachine`, which omits it.)
//  - `wealthAdvisor` and free-text `notes` are still OMITTED.
//  - Account identifiers (`apexAccountId`, `statementAccountNumber`,
//    `dtccNumber`) are masked identically via `maskIdentifier`.
//  - The full asset array is NOT returned — the list stays lean. Instead we
//    emit an `assetMap` count summary tallied directly off each asset's
//    persisted `mapStatus` (self-contained; no dependency on record status).
//  - `lastActivityAt` mirrors the record's `lastUpdated` stamp so the consumer
//    can re-sort; the route already returns rows most-recent-first by it.
export function redactAcatForMachineList(record: {
  id: string;
  clientName: string;
  acatTransferId?: string | null;
  controlNumber?: string | null;
  direction?: string | null;
  type?: string | null;
  accountType?: string | null;
  status: string;
  apexAccountId: string;
  statementAccountNumber?: string | null;
  transferringContra?: string | null;
  dtccNumber?: string | null;
  statementAmount?: number | null;
  acatDate: string;
  lastUpdated: string;
  assets: Array<{ mapStatus: string }>;
}) {
  const assetMap = {
    total: record.assets.length,
    mapped: 0,
    unmapped: 0,
    pending: 0,
    expected: 0,
  };
  for (const asset of record.assets) {
    switch (asset.mapStatus) {
      case "Mapped":
        assetMap.mapped++;
        break;
      case "Unmapped":
        assetMap.unmapped++;
        break;
      case "Expected":
        assetMap.expected++;
        break;
      case "Pending":
      default:
        assetMap.pending++;
        break;
    }
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
    apexAccountId: maskIdentifier(record.apexAccountId),
    statementAccountNumber: maskIdentifier(record.statementAccountNumber),
    dtccNumber: maskIdentifier(record.dtccNumber),
    transferringContra: record.transferringContra,
    statementAmount: record.statementAmount,
    acatDate: record.acatDate,
    lastActivityAt: record.lastUpdated,
    assetMap,
  };
}

/** Records-list columns the book read adds, in `RECORD_FIELDS` order. */
export const BOOK_RECORD_COLUMN_KEYS = [
  "cedarRidgeUserId",
  "cedarRidgeUserIds",
  "needsClientLink",
  "custodianId",
  "methodRequested",
  "transferWorkflow",
  "crwEe",
  "associatedControlNumber",
  "originalClientRequestDate",
  "opsSubmissionDateToApex",
  "apexCompletionDate",
  "residualMonitoringRequired",
  "residualFollowUpDate",
  "feeAmount",
  "feeMemo",
  "feeRequestSubmitted",
  "feeApexTicket",
  "feeCreditRequestId",
  "crmTicket",
  "apexTicket",
  "rejectionReason",
  "additionalResources",
  "tradeRequestId",
  "tradeRequestUrl",
  "mappingSource",
  "apexSource",
  "reconCompletedAt",
  "daysOpen",
  "issueCount",
  "reconStatus",
  "expectedCompletionDate",
] as const satisfies readonly RecordFieldKey[];

type BookRecordColumns = Record<(typeof BOOK_RECORD_COLUMN_KEYS)[number], string | number | boolean | null>;

// Same row the records list renders: `toOperationalAcat` over the client links,
// then each column's own `RECORD_FIELDS` value.
function bookRecordColumns(record: Parameters<typeof toOperationalAcat>[0]): BookRecordColumns {
  const operational = toOperationalAcat(record) as unknown as AcatRecord;
  return Object.fromEntries(
    BOOK_RECORD_COLUMN_KEYS.map((key) => [key, RECORD_FIELDS_BY_KEY.get(key)!.value(operational)]),
  ) as BookRecordColumns;
}

export function redactAcatForMachineBook(record: {
  id: string;
  clientName: string;
  acatTransferId?: string | null;
  controlNumber?: string | null;
  direction?: string | null;
  type?: string | null;
  accountType?: string | null;
  status: string;
  apexAccountId: string;
  statementAccountNumber?: string | null;
  transferringContra?: string | null;
  dtccNumber?: string | null;
  statementAmount?: number | null;
  acatDate: string;
  lastUpdated: string;
  deletedAt?: Date | null;
  wealthAdvisor?: string | null;
  crmDealId?: string | null;
  notes?: string | null;
  tradeInstructions?: string | null;
  custodianName?: string | null;
  feeCharged?: string | null;
  feeRequestCompleted?: string | null;
  cedarRidgeUserId?: string | null;
  clientLinks?: { cedarRidgeUserId: string; client: { canonicalName: string } }[];
  custodian?: { avgProcessingDays?: number | null } | null;
  assets: Array<{
    id?: string;
    symbol?: string;
    description?: string;
    expectedQty: number;
    actualQty: number;
    mapStatus: string;
  }>;
}) {
  const columns = bookRecordColumns(record);
  const base = redactAcatForMachineList({
    ...record,
    assets: record.assets.map((asset) => ({ mapStatus: asset.mapStatus })),
  });
  return {
    ...columns,
    ...base,
    removedAt: record.deletedAt ? record.deletedAt.toISOString() : null,
    wealthAdvisor: record.wealthAdvisor ?? null,
    crmDealId: record.crmDealId ?? null,
    notes: record.notes ?? null,
    tradeInstructions: record.tradeInstructions ?? null,
    custodianName: record.custodianName ?? "",
    tradeInstructionsBlank: !(record.tradeInstructions ?? "").trim(),
    feeCharged: record.feeCharged ?? null,
    feeRequestCompleted: record.feeRequestCompleted ?? null,
    hasIssue: hasIssues({
      status: record.status as AcatStatus,
      assets: record.assets.map((asset) => ({
        id: asset.id ?? "",
        symbol: asset.symbol ?? "",
        description: asset.description ?? "",
        expectedQty: asset.expectedQty,
        actualQty: asset.actualQty,
        mapStatus: asset.mapStatus as Asset["mapStatus"],
      })),
    } as AcatRecord),
  };
}

export function redactAcatDetail(record: {
  id: string;
  clientName: string;
  controlNumber?: string | null;
  acatTransferId?: string | null;
  direction?: string | null;
  type?: string | null;
  accountType?: string | null;
  status: string;
  wealthAdvisor?: string | null;
  apexAccountId: string;
  statementAccountNumber?: string | null;
  transferringContra?: string | null;
  dtccNumber?: string | null;
  statementAmount?: number | null;
  methodRequested?: string | null;
  feeCharged?: string | null;
  feeAmount?: string | null;
  feeMemo?: string | null;
  feeRequestSubmitted?: string | null;
  feeRequestCompleted?: string | null;
  notes?: string | null;
  acatDate: string;
  assets: Array<{
    id: string;
    symbol: string;
    description: string;
    cusip?: string | null;
    expectedQty: number;
    actualQty: number;
    mapStatus: string;
    issue?: string | null;
    amount?: number | null;
    assetClass?: string | null;
  }>;
}) {
  return {
    id: record.id,
    clientName: record.clientName,
    controlNumber: record.controlNumber,
    acatTransferId: record.acatTransferId,
    direction: record.direction,
    type: record.type,
    accountType: record.accountType,
    status: record.status,
    wealthAdvisor: record.wealthAdvisor,
    apexAccountId: maskIdentifier(record.apexAccountId),
    statementAccountNumber: maskIdentifier(record.statementAccountNumber),
    transferringContra: record.transferringContra,
    dtccNumber: maskIdentifier(record.dtccNumber),
    statementAmount: record.statementAmount,
    methodRequested: record.methodRequested,
    feeCharged: record.feeCharged,
    feeAmount: record.feeAmount,
    feeMemo: record.feeMemo,
    feeRequestSubmitted: record.feeRequestSubmitted,
    feeRequestCompleted: record.feeRequestCompleted,
    notes: record.notes,
    acatDate: record.acatDate,
    assets: record.assets.map((asset) => ({
      id: asset.id,
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
