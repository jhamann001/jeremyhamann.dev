import "server-only";
import { createHash } from "node:crypto";
import type { AcatListRow } from "./acat-status";
import { normalizeAcatTransferId } from "./acat-link";
import type {
  TransferAcatCandidate,
  TransferAcatDestination,
} from "./transfer-acat-picker-types";

export type PickerTransferIdentity = {
  id: string;
  client_sf_id: string | null;
  household_sf_id: string | null;
  client_first_name: string;
  client_last_name: string;
  household_name: string | null;
};

export type PickerExistingLink = {
  acat_record_id: string | null;
  acat_transfer_id: string | null;
};

function fingerprint(values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

/** A comparison fingerprint, never a substitute for authentication or RLS. */
export function destinationConfirmationKey(transfer: PickerTransferIdentity): string {
  return fingerprint([
    transfer.id,
    transfer.client_sf_id,
    transfer.household_sf_id,
    transfer.client_first_name,
    transfer.client_last_name,
    transfer.household_name,
  ]);
}

export function pickerDestination(transfer: PickerTransferIdentity): TransferAcatDestination {
  return {
    id: transfer.id,
    clientName: `${transfer.client_first_name} ${transfer.client_last_name}`.trim(),
    householdName: transfer.household_name,
    confirmationKey: destinationConfirmationKey(transfer),
  };
}

/** Hash identity fields the machine endpoint exposes before AOA's defensive
 * masking. The endpoint normally masks accounts itself, so a full account
 * change retaining the same exposed suffix cannot be detected here.
 * Status/activity may advance without changing the reviewed identity. */
export function sourceConfirmationKey(row: AcatListRow): string {
  return fingerprint([
    row.id,
    normalizeAcatTransferId(row.acatTransferId),
    row.clientName,
    row.transferringContra,
    row.statementAccountNumber,
    row.apexAccountId,
    row.accountType,
    row.type,
    row.direction,
    row.acatDate,
    row.statementAmount,
  ]);
}

/** Do not rely on upstream masking: at most four suffix characters leave AOA.
 * An unexpectedly short unmasked value is hidden in full. */
function maskAccount(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

export function pickerCandidates(
  rows: readonly AcatListRow[],
  links: readonly PickerExistingLink[],
): TransferAcatCandidate[] {
  const linkedRecords = new Set(links.flatMap((link) => link.acat_record_id ? [link.acat_record_id] : []));
  const linkedTransferIds = new Set(links.flatMap((link) => {
    const id = normalizeAcatTransferId(link.acat_transfer_id);
    return id ? [id] : [];
  }));
  return rows.map((row) => {
    const transferId = normalizeAcatTransferId(row.acatTransferId);
    return {
      recordId: row.id,
      clientName: row.clientName,
      transferringCustodian: row.transferringContra,
      statementAccountMasked: maskAccount(row.statementAccountNumber),
      receivingAccountMasked: maskAccount(row.apexAccountId),
      accountType: row.accountType,
      transferType: row.type,
      direction: row.direction,
      status: row.status,
      acatDate: row.acatDate,
      amountCents: row.statementAmount,
      confirmationKey: sourceConfirmationKey(row),
      unavailableReason: linkedRecords.has(row.id) || (transferId != null && linkedTransferIds.has(transferId))
        ? "Already linked to a transfer"
        : null,
    };
  });
}
