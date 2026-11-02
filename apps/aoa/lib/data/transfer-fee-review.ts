import "server-only";

import type { Identity } from "@/lib/rls";
import {
  acatFeeReimbursementEnabled,
  acatOpsBookEnabled,
  acatOpsEditsEnabled,
  operationsFeeRequestsPreviewEnabled,
} from "@/lib/flags";
import { maskBookAccountForFee } from "./acat-book";
import { mapDrawerTransfer } from "./acat-drawer-contract";
import { readTransferFee } from "./acat-fee";
import { FEE_FIELD_KEYS, type TransferFee } from "./acat-fee-view";
import { readTransferFeeRequests } from "./acat-reimbursement";
import { validCedarRidgeUserHint, validReimbursementRecordId } from "./acat-reimbursement-view";
import { readAcatMachine } from "./acat-status";
import { getCustodianLibrary } from "./custodian-library";
import { canReadCustodianLibrary, type CustodianLibrary, type CustodianProfile } from "./custodian-library-contract";
import type { TransferRow } from "./transfer-types";
import type {
  TransferFeeReview,
  TransferFeeReviewActual,
  TransferFeeReviewCustodian,
  TransferFeeReviewLibrary,
  TransferFeeReviewRecord,
  TransferFeeReviewRequests,
} from "./transfer-fee-review-contract";

type StoredTransfer = Pick<TransferRow, "id" | "acat_record_id" | "transferring_firm" | "delivering_custodian_id">;
type LinkedRecord =
  | { state: "ready"; record: TransferFeeReviewRecord; invalidCustodianId: boolean; storedFee: TransferFee | null }
  | { state: "not_linked" | "unavailable" };

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;

async function linkedRecord(recordId: string | null): Promise<LinkedRecord> {
  if (!recordId) return { state: "not_linked" };
  if (!validReimbursementRecordId(recordId) || !recordId.trim()) return { state: "unavailable" };
  try {
    const response = await readAcatMachine(`/api/machine/acats/by-record/${encodeURIComponent(recordId)}`);
    const mapped = response.status === 200 ? mapDrawerTransfer(response.data) : null;
    // The response must identify the exact stored link before any account or
    // custodian hints are used, including after a partial tracker deployment.
    if (!mapped || mapped.id !== recordId) return { state: "unavailable" };
    const raw = response.data as Record<string, unknown>;
    const custodianId = text(raw.custodianId);
    const cedarRidgeHint = text(raw.cedarRidgeUserId);
    const storedFee = FEE_FIELD_KEYS.every(key => raw[key] === null || typeof raw[key] === "string")
      ? Object.fromEntries(FEE_FIELD_KEYS.map(key => [key, raw[key]])) as TransferFee
      : null;
    return {
      state: "ready",
      storedFee,
      invalidCustodianId: raw.custodianId != null && typeof raw.custodianId !== "string",
      record: {
        clientName: mapped.clientName,
        direction: mapped.direction,
        type: mapped.type,
        status: mapped.status,
        transferringContra: mapped.transferringContra,
        custodianName: text(raw.custodianName) ?? mapped.transferringContra ?? "",
        controlNumber: mapped.controlNumber,
        apexAccountId: maskBookAccountForFee(mapped.apexAccountId),
        custodianId,
        transferWorkflow: mapped.transferWorkflow,
        cedarRidgeUserId: validCedarRidgeUserHint(cedarRidgeHint) ? cedarRidgeHint : null,
      },
    };
  } catch {
    return { state: "unavailable" };
  }
}

function projectCustodian(custodian: CustodianProfile): TransferFeeReviewCustodian {
  return {
    id: custodian.id,
    name: custodian.name,
    reviewStatus: custodian.reviewStatus,
    acatFeeAmount: custodian.acatFeeAmount,
    documentationStatus: custodian.documentationStatus,
    fees: custodian.fees.map(fee => ({
      id: fee.id, feeType: fee.feeType, accountType: fee.accountType,
      transferType: fee.transferType, direction: fee.direction, amount: fee.amount,
      amountText: fee.amountText, notes: fee.notes, documentation: fee.documentation,
      createdAt: fee.createdAt, updatedAt: fee.updatedAt,
    })),
    feeSchedules: custodian.feeSchedules?.map(schedule => ({
      id: schedule.id, filename: schedule.filename, contentType: schedule.contentType,
      byteSize: schedule.byteSize, sha256: schedule.sha256, createdAt: schedule.createdAt,
    })),
  };
}

function matchLibrary(
  library: CustodianLibrary, linked: LinkedRecord, storedName: string | null, profileId: string | null,
): TransferFeeReviewLibrary {
  if (linked.state === "unavailable") return { state: "unavailable" };
  if (linked.state === "ready" && linked.invalidCustodianId) return { state: "unavailable" };
  const trackerId = linked.state === "ready" ? linked.record.custodianId : null;
  const storedId = text(profileId);
  if (trackerId && storedId && trackerId !== storedId) return { state: "unmatched", reason: "conflict" };
  const custodianId = trackerId ?? storedId;
  if (!custodianId) return linked.state === "not_linked" && !text(storedName)
    ? { state: "not_linked" }
    : { state: "unmatched", reason: "missing_custodian" };
  const matches = library.custodians.filter(custodian => custodian.id === custodianId);
  // A present but unknown immutable id must never silently fall back to a name.
  if (matches.length === 0) return { state: "unmatched", reason: "not_found" };
  if (matches.length !== 1) return { state: "unmatched", reason: "ambiguous" };
  return { state: "ready", custodian: projectCustodian(matches[0]), retrievedAt: library.retrievedAt, matchedBy: "id" };
}

async function actualFee(recordId: string, storedFee: TransferFee | null): Promise<TransferFeeReviewActual> {
  try {
    const result = await readTransferFee(recordId);
    if (!result.fee) return storedFee
      ? { state: "partial", fee: storedFee, code: result.ok ? "transport" : result.code }
      : { state: "unavailable" };
    // Deliberately keep null and the literal stored zero distinct. Tracker log
    // rows are not authoritative Operations Tools reimbursement requests.
    const fee = Object.fromEntries(FEE_FIELD_KEYS.map(key => [key, result.fee![key]])) as NonNullable<typeof result.fee>;
    return result.ok ? { state: "ready", fee } : { state: "partial", fee, code: result.code };
  } catch {
    return storedFee ? { state: "partial", fee: storedFee, code: "transport" } : { state: "unavailable" };
  }
}

async function requestsOnAccount(identity: Identity, recordId: string, record: TransferFeeReviewRecord): Promise<TransferFeeReviewRequests> {
  try {
    const result = await readTransferFeeRequests(identity, {
      recordId, cedarRidgeUserId: record.cedarRidgeUserId, maskedAccount: record.apexAccountId,
    });
    if (result.identity === "unresolved") return { state: "unmatched", reason: result.reason };
    return {
      state: "ready", scope: "account", accountLabel: result.accountLabel, truncated: result.truncated,
      requests: result.requests.map(request => ({
        id: request.id, kind: request.kind, status: request.status, feeAmount: request.feeAmount,
        feeTypes: [...request.feeTypes], submittedAt: request.submittedAt, creditedAt: request.creditedAt,
      })),
    };
  } catch {
    return { state: "unavailable" };
  }
}

/**
 * Read only after getTransfer has authorized the stored transfer under RLS.
 * The exact Admin/Operations gate precedes every source read. The canonical
 * library, stored fee and account-scoped requests remain separate facts.
 */
export async function readTransferFeeReview(identity: Identity, transfer: StoredTransfer): Promise<TransferFeeReview> {
  if (!canReadCustodianLibrary(identity.role)) {
    return { library: { state: "restricted" }, actual: { state: "restricted" }, requests: { state: "restricted" }, record: null, recordId: null };
  }
  const recordId = text(transfer.acat_record_id);
  const feeEnabled = acatOpsBookEnabled() && acatOpsEditsEnabled() && acatFeeReimbursementEnabled();
  const requestsEnabled = feeEnabled && operationsFeeRequestsPreviewEnabled();
  const [libraryResult, linked] = await Promise.all([
    getCustodianLibrary(identity.role!).then(value => ({ value }), () => ({ value: null })),
    linkedRecord(recordId),
  ]);
  const library = libraryResult.value ? matchLibrary(libraryResult.value, linked, transfer.transferring_firm, transfer.delivering_custodian_id ?? null) : { state: "unavailable" as const };
  const [actual, requests] = await Promise.all([
    !feeEnabled ? Promise.resolve<TransferFeeReviewActual>({ state: "off" })
      : linked.state !== "ready" ? Promise.resolve<TransferFeeReviewActual>({ state: linked.state })
        : actualFee(recordId!, linked.storedFee),
    !requestsEnabled ? Promise.resolve<TransferFeeReviewRequests>({ state: "off" })
      : !text(identity.email) ? Promise.resolve<TransferFeeReviewRequests>({ state: "restricted" })
        : linked.state !== "ready" ? Promise.resolve<TransferFeeReviewRequests>({ state: linked.state })
          : requestsOnAccount(identity, recordId!, linked.record),
  ]);
  return { library, actual, requests, record: linked.state === "ready" ? linked.record : null, recordId };
}
