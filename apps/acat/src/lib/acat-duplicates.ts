import { AcatRecord, TransferWorkflow } from "./types";

export interface AcatDuplicateDraft {
  cedarRidgeUserId?: string | null;
  cedarRidgeUserIds?: string[];
  clientName: string;
  apexAccountId: string;
  controlNumber?: string;
  acatTransferId?: string;
  statementAccountNumber?: string;
  transferWorkflow?: TransferWorkflow;
  type?: string;
}

export interface PossibleAcatDuplicate {
  record: AcatRecord;
  reasons: string[];
}

const NON_UNIQUE_CONTROL_MARKERS = new Set(["manual", "to come"]);

function normalize(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeIdentifier(value?: string | null): string {
  const normalized = normalize(value);
  // "Not applicable" is not evidence that two transfers share an identifier.
  return normalized === "n/a" ? "" : normalized;
}

/**
 * Find records that look like the same transfer before a user creates a new
 * one. These are warnings, not hard uniqueness constraints: a client can have
 * more than one legitimate transfer involving the same accounts over time.
 */
export function findPossibleAcatDuplicates(
  records: AcatRecord[],
  draft: AcatDuplicateDraft
): PossibleAcatDuplicate[] {
  const clientName = normalize(draft.clientName);
  const apexAccountId = normalizeIdentifier(draft.apexAccountId);
  const controlNumber = normalizeIdentifier(draft.controlNumber);
  const acatTransferId = normalizeIdentifier(draft.acatTransferId);
  const statementAccountNumber = normalizeIdentifier(draft.statementAccountNumber);
  // Separate residual sweeps routinely reuse the original transfer's accounts.
  // Only a real transfer/control identifier is duplicate evidence for these.
  const isResidual = draft.transferWorkflow === "RESIDUAL" ||
    normalize(draft.type) === "residual credit";

  return records
    .filter((record) => !record.deletedAt)
    .map((record) => {
      const reasons: string[] = [];
      const draftIds = draft.cedarRidgeUserIds ?? (draft.cedarRidgeUserId ? [draft.cedarRidgeUserId] : []);
      const recordIds = record.cedarRidgeUserIds ?? (record.cedarRidgeUserId ? [record.cedarRidgeUserId] : []);
      const sameClient = draftIds.length && recordIds.length
        ? draftIds.some((id) => recordIds.includes(id))
        : Boolean(clientName && normalize(record.clientName) === clientName);

      if (
        controlNumber &&
        !NON_UNIQUE_CONTROL_MARKERS.has(controlNumber) &&
        normalizeIdentifier(record.controlNumber) === controlNumber
      ) {
        reasons.push("Same control number");
      }
      if (
        acatTransferId &&
        normalizeIdentifier(record.acatTransferId) === acatTransferId
      ) {
        reasons.push("Same ACAT transfer ID");
      }
      if (
        !isResidual &&
        sameClient &&
        apexAccountId &&
        normalizeIdentifier(record.apexAccountId) === apexAccountId
      ) {
        reasons.push("Same client and Apex account");
      }
      if (
        !isResidual &&
        sameClient &&
        statementAccountNumber &&
        normalizeIdentifier(record.statementAccountNumber) === statementAccountNumber
      ) {
        reasons.push("Same client and statement account");
      }

      return { record, reasons };
    })
    .filter((match) => match.reasons.length > 0);
}
