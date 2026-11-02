"use client";

import { useState, type ReactNode } from "react";
import { previewLinkedHoldings } from "@/app/(authenticated)/client-portrait/[id]/actions";
import {
  LINKED_HOLDINGS_CARD_LABEL,
  LINKED_HOLDINGS_SOURCE_LABEL,
  QUERY_FAILED_MESSAGE,
  UNAVAILABLE_MESSAGE,
  accountLabel,
  accountMatchesTransfer,
  isCashHolding,
  mappingFinding,
  previewIssue,
  reasonPhrase,
  type LinkedAccountOption,
  type LinkedHoldingRow,
} from "@/lib/transfers/linked-holdings";
import { displayTime, trackingDate } from "@/components/asset-transfer/detail/detail-model";
import { WorkspaceDialog, FormTransferContext } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import { Badge, type BtnStyle } from "@/components/asset-transfer/workspace/ui";

export type LinkedHoldingsTransfer = {
  last4: string | null;
  contextTitle: string;
  contextDetail: string;
};

export type LinkedHoldingsDialogProps = {
  accounts: LinkedAccountOption[];
  transfer: LinkedHoldingsTransfer | null;
  initialAccountId: string | null;
  trigger: ReactNode;
  triggerStyle?: BtnStyle;
};

type Preview = {
  externalAccountId: string;
  asOf: string | null;
  queriedAt: string;
  rows: LinkedHoldingRow[];
  holdingsTotal: number | null;
  institutionBalance: number | null;
};

const CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const QUANTITY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

export function preciseCash(value: number | null | undefined): string {
  return value == null ? "Not supplied" : CENTS.format(value);
}

/**
 * The mockup's "Load linked holdings" modal, read-only. Holdings come from the
 * Client Portrait's on-demand preview and stay in page memory: nothing is
 * saved and the transfer's asset map is mapped by hand.
 */
export function LinkedHoldingsDialog(props: LinkedHoldingsDialogProps) {
  return (
    <WorkspaceDialog title="Load linked holdings" trigger={props.trigger} triggerStyle={props.triggerStyle ?? { tiny: true }}
      className="linked-holdings-dialog"
      context={props.transfer ? <FormTransferContext title={props.transfer.contextTitle} detail={props.transfer.contextDetail} /> : undefined}>
      {close => <LinkedHoldingsBody {...props} close={close} />}
    </WorkspaceDialog>
  );
}

function LinkedHoldingsBody({ accounts, transfer, initialAccountId, close }: LinkedHoldingsDialogProps & { close: () => void }) {
  const [accountId, setAccountId] = useState(initialAccountId ?? accounts[0]?.externalAccountId ?? "");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const account = accounts.find(item => item.externalAccountId === accountId) ?? null;
  if (!account) {
    return (
      <div className="subtle"><strong>No linked account is available</strong>
        <p>This client has no active Plaid-linked account you can view. Use statement intake for this source account.</p>
        <div className="row linked-holdings-actions"><button type="button" className="btn" onClick={close}>Close</button></div>
      </div>
    );
  }
  const shown = preview?.externalAccountId === account.externalAccountId ? preview : null;
  const issue = shown ? previewIssue(shown.rows, shown.asOf) : null;
  const otherAccount = transfer != null && !accountMatchesTransfer(account.mask, transfer.last4);

  const run = async () => {
    setPending(true); setMessage(null);
    try {
      const result = await previewLinkedHoldings({ clientSfId: account.clientSfId, externalAccountId: account.externalAccountId });
      if (!result.ok) {
        setPreview(null);
        setMessage(result.reason === "unauthorized" ? UNAVAILABLE_MESSAGE : QUERY_FAILED_MESSAGE);
        return;
      }
      setPreview({
        externalAccountId: account.externalAccountId,
        asOf: result.asOf,
        queriedAt: new Date().toISOString(),
        rows: result.rows,
        holdingsTotal: result.holdingsTotal,
        institutionBalance: result.institutionBalance,
      });
    } catch {
      setPreview(null);
      setMessage(QUERY_FAILED_MESSAGE);
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <p className="small">{transfer
        ? "Review linked holdings for this transfer, then update the asset map by hand. Nothing here changes the transfer."
        : "Review a linked source account before a transfer is requested. Nothing here creates a transfer or funding request."}</p>
      <div className="linked-query-choices">
        <label className="field"><span>Linked source account</span>
          <select aria-label="Linked source account" value={accountId} disabled={pending}
            onChange={event => { setAccountId(event.target.value); setMessage(null); }}>
            {accounts.map(item => <option key={item.externalAccountId} value={item.externalAccountId}>{accountLabel(item)}</option>)}
          </select>
        </label>
        <label className="field"><span>Holdings source</span>
          <select aria-label="Holdings source" defaultValue="bridge">
            <option value="bridge">{LINKED_HOLDINGS_SOURCE_LABEL}</option>
            <option value="direct" disabled>Plaid direct · future integration</option>
          </select>
        </label>
      </div>
      <div className="linked-query-bar">
        <span>{LINKED_HOLDINGS_CARD_LABEL}<small>Runs on demand through the Client Portrait&rsquo;s read-only preview. Holdings are not saved in AoA.</small></span>
        <button type="button" className={shown ? "btn" : "btn primary"} disabled={pending} onClick={() => void run()}>
          {pending ? "Loading holdings…" : shown ? "Load latest holdings" : "Run query"}
        </button>
      </div>
      {pending ? <p className="small" role="status">Loading holdings from the linked account…</p> : null}
      {message ? <p className="linked-holdings-message error" role="alert">{message}</p> : null}
      {shown ? (
        <section className="linked-holdings-preview" aria-label="Query preview">
          <div className="row between">
            <strong>Query preview · not saved</strong>
            {issue ? <Badge tone="blocked">{shown.rows.length ? "Check before mapping" : "No holdings to map"}</Badge> : <Badge tone="completed">Complete account holdings</Badge>}
          </div>
          {issue ? <p className="linked-holdings-message error" role="alert">{issue}</p> : null}
          <dl className="linked-holdings-provenance">
            <div><dt>Source</dt><dd>{LINKED_HOLDINGS_SOURCE_LABEL}</dd></div>
            <div><dt>Holdings as of</dt><dd>{shown.asOf ? trackingDate(shown.asOf) : "Not supplied"}</dd></div>
            <div><dt>Price date</dt><dd>Varies / not supplied</dd></div>
            <div><dt>Query run</dt><dd>{displayTime(shown.queriedAt)}</dd></div>
          </dl>
          <HoldingsTable rows={shown.rows} />
          <p className="small">Holdings total {preciseCash(shown.holdingsTotal)} · Institution balance {preciseCash(shown.institutionBalance)}. Findings are advisory; Ops confirms eligibility when mapping by hand.</p>
        </section>
      ) : (
        <div className="subtle"><strong>Load only when needed</strong>
          <p>Find this linked account and review its reported holdings with preliminary mapping findings. Holdings are read at click time and are not stored.</p></div>
      )}
      <div className="row linked-holdings-actions">
        <button type="button" className="btn" onClick={close}>Close</button>
      </div>
      {otherAccount ? <p className="small">{transfer?.last4
        ? "This linked account is not this transfer's recorded source account."
        : "Record the delivering account's last 4 digits on this transfer to confirm which linked account is its source."}</p> : null}
    </div>
  );
}

export function HoldingsTable({ rows }: { rows: readonly LinkedHoldingRow[] }) {
  return (
    <div className="tablewrap linked-holdings-table">
      <table aria-label="Linked holdings preview">
        <thead><tr><th>Asset</th><th className="money">Quantity</th><th className="money">Reported value</th><th>Mapping finding</th></tr></thead>
        <tbody>
          {rows.length ? rows.map((row, index) => (
            <tr key={`${row.symbol ?? "holding"}-${index}`}>
              <td><strong>{row.symbol || "Identifier needed"}</strong><small>{isCashHolding(row) ? "Reported cash balance" : row.name ?? ""}</small></td>
              <td className="money">{row.quantity == null ? "Not supplied" : QUANTITY.format(row.quantity)}</td>
              <td className="money">{preciseCash(row.value)}</td>
              <td>{mappingFinding(row)}<small>{reasonPhrase(isCashHolding(row) ? "cash" : row.reason)}</small></td>
            </tr>
          )) : (
            <tr><td colSpan={4}>No holdings returned. The account currently reports no positions.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
