import type { Identity } from "@/lib/rls";
import { loadTransferLinkedAccounts, type TransferLinkedFacts } from "@/lib/data/transfer-linked-holdings";
import { LINKED_HOLDINGS_SOURCE_LABEL, accountMatchesTransfer } from "@/lib/transfers/linked-holdings";
import { LinkedHoldingsDialog } from "./LinkedHoldingsDialog";

type Props = { identity: Identity; transfer: TransferLinkedFacts; contextTitle: string; contextDetail: string };

/** Suspense fallback while the linked accounts load. */
export function TransferLinkedHoldingsLoading() {
  return (
    <div className="linked-source-summary" aria-busy="true">
      <div><span className="linked-source-badge">Linked holdings</span><small role="status">Loading linked accounts…</small></div>
    </div>
  );
}

/** The mockup's linked-source summary in Statement & account checks, read-only: Load linked holdings. */
export async function TransferLinkedHoldingsSummary({ identity, transfer, contextTitle, contextDetail }: Props) {
  let data;
  try {
    data = await loadTransferLinkedAccounts(identity, transfer);
  } catch {
    return (
      <div className="linked-source-summary">
        <div><span className="linked-source-badge">Linked holdings</span><small>Linked accounts are unavailable right now. Refresh to try again.</small></div>
      </div>
    );
  }
  if (!data.accounts.length) return null;
  const source = data.accounts.find(account => accountMatchesTransfer(account.mask, data.last4)) ?? null;
  return (
    <div className="linked-source-summary">
      <div>
        <span className="linked-source-badge">{LINKED_HOLDINGS_SOURCE_LABEL}</span>
        <small>{source ? "The source account is Plaid-linked. Review its holdings and map them by hand." : `${data.accounts.length} Plaid-linked account${data.accounts.length === 1 ? "" : "s"} for this client.`}</small>
      </div>
      <div className="row">
        <LinkedHoldingsDialog accounts={data.accounts}
          transfer={{ last4: data.last4, contextTitle, contextDetail }}
          initialAccountId={source?.externalAccountId ?? data.accounts[0].externalAccountId}
          trigger="Load linked holdings" />
      </div>
    </div>
  );
}
