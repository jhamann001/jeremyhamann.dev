import "server-only";
import type { Identity } from "@/lib/rls";
import {
  allowPlaidHoldingsPreviewEnabled,
  assetTransferWorkspaceEnabled,
  paperworkRecordsEnabled,
  showPlaidLinkedAccountSummariesEnabled,
} from "@/lib/flags";
import { plaidHoldingsPreviewAllowed } from "@/lib/auth/plaid-holdings-preview";
import {
  linkedExternalSummariesForClient,
  type LinkedExternalAccountSummary,
} from "@/lib/data/linked-external-account-summary";
import { accountMatchesTransfer, type LinkedAccountOption } from "@/lib/transfers/linked-holdings";

// Linked accounts on an asset transfer (ticket). Lists a client's active
// Plaid-linked accounts through the Client Portrait's RLS-scoped summary
// reader. Holdings are read at click time by the portrait's own preview
// action; nothing here stores holdings or writes a transfer's asset map.

/** Every switch the Client Portrait requires to list linked accounts and preview holdings, plus the workspace flags. */
export function linkedHoldingsEnabled(): boolean {
  return assetTransferWorkspaceEnabled()
    && paperworkRecordsEnabled()
    && showPlaidLinkedAccountSummariesEnabled()
    && allowPlaidHoldingsPreviewEnabled();
}

/** The Client Portrait holdings-preview gate (Admin/Operations) under the workspace flags. */
export function linkedHoldingsAllowed(role: string | null | undefined): boolean {
  return linkedHoldingsEnabled() && plaidHoldingsPreviewAllowed(role);
}

export type SummaryReader = (identity: Identity, clientSfId: string) => Promise<LinkedExternalAccountSummary[]>;

export type LinkedClient = { sfId: string; name: string; transferLast4s: string[] };

function accountOption(summary: LinkedExternalAccountSummary, client: LinkedClient): LinkedAccountOption {
  return {
    externalAccountId: summary.externalAccountId,
    clientSfId: client.sfId,
    clientName: client.name,
    institution: summary.institutionName ?? "Linked account",
    accountType: summary.accountSubtype ?? "Account",
    mask: summary.mask,
    hasTransfer: client.transferLast4s.some(last4 => accountMatchesTransfer(summary.mask, last4)),
  };
}

/** Active linked accounts for a set of clients. Each summary read is RLS-scoped, sequentially. */
export async function loadLinkedAccounts(
  identity: Identity,
  clients: readonly LinkedClient[],
  read: SummaryReader = linkedExternalSummariesForClient,
): Promise<LinkedAccountOption[]> {
  const accounts: LinkedAccountOption[] = [];
  for (const client of clients) {
    for (const summary of await read(identity, client.sfId)) {
      if (summary.linkStatus === "ACTIVE") accounts.push(accountOption(summary, client));
    }
  }
  return accounts;
}

export type TransferLinkedFacts = {
  client_sf_id: string | null;
  client_first_name: string;
  client_last_name: string;
  asset_map_account_number?: string | null;
  source_account_last4?: string | null;
};

export function transferLast4(transfer: Pick<TransferLinkedFacts, "asset_map_account_number" | "source_account_last4">): string | null {
  const fromMap = (transfer.asset_map_account_number ?? "").replace(/[^A-Za-z0-9]/g, "");
  return fromMap.length >= 4 ? fromMap.slice(-4) : transfer.source_account_last4 ?? null;
}

export async function loadTransferLinkedAccounts(
  identity: Identity,
  transfer: TransferLinkedFacts,
  read: SummaryReader = linkedExternalSummariesForClient,
): Promise<{ accounts: LinkedAccountOption[]; last4: string | null }> {
  const last4 = transferLast4(transfer);
  if (!transfer.client_sf_id) return { accounts: [], last4 };
  const name = `${transfer.client_first_name} ${transfer.client_last_name}`.trim();
  const accounts = await loadLinkedAccounts(identity, [{ sfId: transfer.client_sf_id, name, transferLast4s: last4 ? [last4] : [] }], read);
  return { accounts, last4 };
}
