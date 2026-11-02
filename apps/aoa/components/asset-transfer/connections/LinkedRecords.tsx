"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import {
  linkTransferClient,
  linkTransferDeal,
  loadTransferRecordOptions,
  setDeliveringCustodian,
  type ConnectionResult,
  type TransferRecordOptions,
} from "@/app/(authenticated)/asset-transfer/connection-actions";
import {
  linkAssetMapToTransfer,
  loadAssignableAssetMapAccounts,
  unlinkAssetMapFromTransfer,
  type AssignableAssetMapResult,
} from "@/app/(authenticated)/asset-transfer/actions";
import type { AssetMapAccountOption } from "@/lib/data/transfer-asset-map";
import { WorkspaceDialog } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import { cash } from "@/components/asset-transfer/workspace/ui";
import type { ConnectedClient, CustodianOption } from "@/lib/transfers/connections";
import { ClientSearch } from "./ClientSearch";

type Loaded = Extract<TransferRecordOptions, { ok: true }>;

function useConnection(): [boolean, string, (run: () => Promise<ConnectionResult>, done?: () => void) => void] {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const run = (action: () => Promise<ConnectionResult>, done?: () => void) => startTransition(async () => {
    const result = await action();
    setError(result.ok ? "" : result.error);
    if (result.ok) done?.();
  });
  return [pending, error, run];
}

export type LinkedRecordsProps = {
  transferId: string;
  canEdit: boolean;
  client: ConnectedClient | null;
  recordedClientName: string;
  dealReference: string | null;
  custodian: CustodianOption | null;
  recordedFirm: string | null;
  /** Operations can read the custodian library; the delivering firm changes only in Preparation. */
  canChooseCustodian: boolean;
  context?: ReactNode;
};

function LinkedRecordsForm(props: LinkedRecordsProps & { close: () => void }) {
  const { transferId, client, dealReference, custodian, canChooseCustodian } = props;
  const [options, setOptions] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [dealId, setDealId] = useState("");
  const [custodianId, setCustodianId] = useState(custodian?.id ?? "");
  const [pending, error, run] = useConnection();

  useEffect(() => {
    let live = true;
    loadTransferRecordOptions(transferId).then((loaded) => {
      if (!live) return;
      if (loaded.ok) setOptions(loaded);
      else setLoadFailed(true);
    });
    return () => { live = false; };
  }, [transferId, client?.sfId]);

  return <>
    <section className="intake-account-section">
      <h3>Client</h3>
      <p>{client
        ? <><strong>{client.name}</strong>{client.householdName ? ` · ${client.householdName}` : ""} · from the client directory</>
        : <><strong>{props.recordedClientName}</strong> · recorded on the transfer, not linked to the client directory</>}</p>
      <ClientSearch disabled={pending} onChoose={(chosen) => run(() => linkTransferClient(transferId, chosen.sfId))} />
      <p className="small">Linking replaces the transfer’s client and household with the directory record.</p>
    </section>
    <section className="intake-account-section">
      <h3>Deal</h3>
      {dealReference ? <p>Linked deal · <strong>{dealReference}</strong>. The deal sync keys on this link, so it is not changed here.</p>
        : !client ? <p className="small">Link the client first; the deals offered are the client’s and the household’s.</p>
          : loadFailed ? <p className="small" role="alert">The client’s deals could not be loaded.</p>
            : !options ? <p className="small">Loading deals…</p>
              : options.deals.length === 0 ? <p className="small">No open deals for this client.</p> : (
                <form onSubmit={(event) => { event.preventDefault(); run(() => linkTransferDeal(transferId, dealId)); }}>
                  <label className="field"><span>Deal</span>
                    <select value={dealId} required onChange={(event) => setDealId(event.target.value)}>
                      <option value="" disabled>Choose a deal</option>
                      {options.deals.map((deal) => <option key={deal.id} value={deal.id} disabled={Boolean(deal.linkedTransferId)}>
                        {[deal.name, cash(deal.amount), deal.stage, deal.linkedTransferId ? `linked to ${deal.linkedTransferId}` : null].filter(Boolean).join(" · ")}
                      </option>)}
                    </select>
                  </label>
                  <button className="btn" type="submit" disabled={pending || !dealId}>Link deal</button>
                </form>
              )}
    </section>
    <section className="intake-account-section">
      <h3>Delivering firm</h3>
      <p>{custodian ? <><strong>{custodian.name}</strong> · custodian library</>
        : props.recordedFirm ? <><strong>{props.recordedFirm}</strong> · recorded name, not a custodian profile</> : "Not recorded"}</p>
      {canChooseCustodian && options?.custodians ? (
        <form onSubmit={(event) => { event.preventDefault(); run(() => setDeliveringCustodian(transferId, custodianId)); }}>
          <label className="field"><span>Custodian profile</span>
            <select value={custodianId} required onChange={(event) => setCustodianId(event.target.value)}>
              <option value="" disabled>Choose the delivering firm</option>
              {options.custodians.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
          <p className="small">Changing the delivering firm reopens funding plan approval.</p>
          <button className="btn" type="submit" disabled={pending || !custodianId || custodianId === custodian?.id}>Set delivering firm</button>
        </form>
      ) : <p className="small">Operations sets the delivering firm from the custodian library while the transfer is in Preparation.</p>}
    </section>
    <p id="form-error" className="upload-error" role="alert" tabIndex={-1}>{error}</p>
    <div className="row"><button className="btn" type="button" onClick={props.close}>Done</button></div>
  </>;
}

/** Links the transfer to its directory client, deal and custodian profile. */
export function LinkedRecordsDialog(props: LinkedRecordsProps) {
  if (!props.canEdit) return null;
  return (
    <WorkspaceDialog title="Linked records" trigger="Linked records" context={props.context}>
      {(close) => <LinkedRecordsForm {...props} close={close} />}
    </WorkspaceDialog>
  );
}

type AssetMaps = Extract<AssignableAssetMapResult, { ok: true }>;

function accountLabel(option: AssetMapAccountOption): string {
  return [option.householdName ?? option.accountHolder, option.custodian, option.accountType, option.accountNumberMasked ?? "no account number",
    option.totalValue != null ? cash(option.totalValue) : null].filter(Boolean).join(" · ");
}

function AssetMapForm({ transferId, hrqjSbevsbySbin8, linked, close }: {
  transferId: string; hrqjSbevsbySbin8: string | null; linked: boolean; close: () => void;
}) {
  const [data, setData] = useState<AssetMaps | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    let live = true;
    loadAssignableAssetMapAccounts(hrqjSbevsbySbin8, transferId).then((loaded) => {
      if (!live) return;
      if (loaded.ok) setData(loaded);
      else setFailed(true);
    });
    return () => { live = false; };
  }, [hrqjSbevsbySbin8, transferId]);
  const run = (action: () => Promise<{ ok: false; errors: { message: string }[] } | void>) => startTransition(async () => {
    const result = await action();
    if (result && !result.ok) setError(result.errors[0]?.message ?? "The change could not be saved.");
    else close();
  });
  if (failed) return <p className="small" role="alert">Asset maps could not be loaded. Close and try again.</p>;
  if (!data) return <p className="small">Loading asset maps…</p>;
  const q = query.trim().toLowerCase();
  const all = [...data.recommended.map((option) => ({ option, recommended: true })), ...data.others.map((option) => ({ option, recommended: false }))];
  const shown = q ? all.filter(({ option }) => accountLabel(option).toLowerCase().includes(q)) : all;
  return (
    <form onSubmit={(event) => { event.preventDefault(); run(() => linkAssetMapToTransfer(transferId, accountId)); }}>
      {all.length === 0 ? <p className="small">No asset-map accounts are available to link.</p> : <>
        <label className="field"><span>Search</span>
          <input value={query} placeholder="Client, holder, custodian or type" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="field"><span>Asset map account</span>
          <select value={accountId} required onChange={(event) => setAccountId(event.target.value)}>
            <option value="" disabled>{shown.length ? "Choose an account" : "No matches"}</option>
            {shown.map(({ option, recommended }) => <option key={option.accountId} value={option.accountId}>
              {[recommended ? `Recommended · ends ${hrqjSbevsbySbin8}` : null, accountLabel(option),
                option.linkedTransferCount > 0 ? `already linked to ${option.linkedTransferCount} other transfer(s)` : null].filter(Boolean).join(" · ")}
            </option>)}
          </select>
        </label>
      </>}
      <p className="small">Linking reads the source custodian, account type and holdings from the asset map, and reopens funding plan approval.</p>
      <p id="form-error" className="upload-error" role="alert" tabIndex={-1}>{error}</p>
      <div className="row">
        <button className="btn primary" type="submit" disabled={pending || !accountId}>Link asset map</button>
        {linked ? <button className="btn" type="button" disabled={pending} onClick={() => run(() => unlinkAssetMapFromTransfer(transferId))}>Unlink</button> : null}
        <button className="btn" type="button" onClick={close}>Cancel</button>
      </div>
    </form>
  );
}

/** Operations links the transfer's source account to an asset-map account (masked numbers only). */
export function AssetMapPicker({ transferId, canLink, hrqjSbevsbySbin8, current, context }: {
  transferId: string;
  canLink: boolean;
  hrqjSbevsbySbin8: string | null;
  current: { custodian: string; accountNumberMasked: string | null; accountType: string | null } | null;
  context?: ReactNode;
}) {
  return (
    <div className="account" data-testid="asset-map-picker">
      <div className="kicker">Asset map account</div>
      <strong>{current ? `${current.custodian} · ${current.accountType ?? "Account type not recorded"}` : "Not linked"}</strong>
      <p>{current ? current.accountNumberMasked ?? "No account number on the asset map" : "Operations links the source account from an asset map."}</p>
      {canLink ? (
        <WorkspaceDialog title={current ? "Change asset map account" : "Link asset map account"} trigger={current ? "Change asset map" : "Link asset map"} context={context}>
          {(close) => <AssetMapForm transferId={transferId} hrqjSbevsbySbin8={hrqjSbevsbySbin8} linked={current != null} close={close} />}
        </WorkspaceDialog>
      ) : null}
    </div>
  );
}
