import { auth } from "@/auth";
import type { WorkspaceTransfer } from "@/lib/transfers/workspace-queue";
import { linkedHoldingsAllowed, loadLinkedAccounts, type LinkedClient } from "@/lib/data/transfer-linked-holdings";
import { LinkedHoldingsDialog } from "./LinkedHoldingsDialog";

/** One entry per client, with the delivering-account last 4 of each of the client's transfers. */
export function householdClients(transfers: readonly WorkspaceTransfer[]): LinkedClient[] {
  const clients = new Map<string, LinkedClient>();
  for (const transfer of transfers) {
    const sfId = transfer.clientSfId?.trim();
    if (!sfId) continue;
    const client = clients.get(sfId) ?? { sfId, name: transfer.clientName, transferLast4s: [] };
    if (transfer.source.last4) client.transferLast4s.push(transfer.source.last4);
    clients.set(sfId, client);
  }
  return [...clients.values()];
}

/** The mockup's Household aside "Linked holdings" card. Renders nothing without linked accounts or the holdings role. */
export async function HouseholdLinkedHoldings({ transfers }: { transfers: readonly WorkspaceTransfer[] }) {
  const session = await auth();
  const identity = { role: (session?.user as { role?: string } | undefined)?.role ?? "VIEWER", email: session?.user?.email ?? null };
  if (!session?.user || !linkedHoldingsAllowed(identity.role)) return null;
  const clients = householdClients(transfers);
  if (!clients.length) return null;
  let accounts;
  try {
    accounts = await loadLinkedAccounts(identity, clients);
  } catch {
    return null;
  }
  if (!accounts.length) return null;
  return (
    <section className="section linked-account-panel" aria-label="Linked holdings">
      <div className="sectionhead"><div><div className="kicker">Before a transfer</div><h2>Linked holdings</h2></div></div>
      <div className="sectionbody">
        <p className="small">Load a linked account when you need it. Reviewing holdings does not create a transfer or funding request.</p>
        {accounts.map(account => (
          <article className="linked-account-item" key={account.externalAccountId}>
            <div>
              <strong>{account.institution}{account.mask ? ` · •••• ${account.mask}` : ""}</strong>
              <p>{account.clientName} · {account.accountType}</p>
              <small>{account.hasTransfer ? "Source account with an existing transfer" : "Linked only · no transfer requested"}</small>
            </div>
            <LinkedHoldingsDialog accounts={accounts} transfer={null} initialAccountId={account.externalAccountId} trigger="Load holdings & map" />
          </article>
        ))}
        <p className="small linked-sample-note">Plaid-linked accounts from Client Portrait · holdings load on demand and are not stored.</p>
      </div>
    </section>
  );
}
