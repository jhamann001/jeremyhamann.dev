import type { DerivedReceivingAccount } from "./receiving-account-match";
import type { TransferBoardRow } from "./transfers";

/**
 * The exact transfer-row shape allowed to cross the Server Component → browser
 * boundary. The forbidden optional property makes a raw TransferBoardRow
 * compile-time incompatible with client component props, even though TypeScript
 * otherwise permits extra object properties through structural assignment.
 */
export type TransferBoardClientRow = Omit<
  TransferBoardRow,
  "asset_map_account_number"
> & {
  asset_map_account_number?: never;
};

/**
 * Remove the linked source account number before React serializes board props.
 * Detail reads and link/unlink actions continue to use the full server-side row.
 */
export function toTransferBoardClientRow(
  row: TransferBoardRow,
  receivingAccount: DerivedReceivingAccount | null,
): TransferBoardClientRow {
  const { asset_map_account_number: rawAccountNumber, ...clientRow } = row;
  void rawAccountNumber;
  return { ...clientRow, receivingAccount };
}
