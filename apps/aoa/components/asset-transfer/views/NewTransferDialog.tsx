"use client";

import { useState, useTransition } from "react";
import { createTransfer } from "@/app/(authenticated)/asset-transfer/actions";
import { loadTransferIntakeOptions, type IntakeOptions } from "@/app/(authenticated)/asset-transfer/connection-actions";
import { ClientSearch } from "@/components/asset-transfer/connections/ClientSearch";
import { EMPTY_TRANSFER_FORM } from "@/components/transfers/transfer-form";
import { WorkspaceDialog } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import {
  INTAKE_ACCOUNT_TYPES, INTAKE_ROUTES, RECEIVING_ACCOUNT_TYPES, type ConnectedSourceMode,
} from "@/lib/transfers/new-transfer-intake";
import type { ConnectedClient } from "@/lib/transfers/connections";

type Options = Extract<IntakeOptions, { ok: true }>;

const money = (value: number) => value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const firmKey = (value: string | null | undefined) => (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const lastFour = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "").slice(-4);

function IntakeForm({ options, close, reset }: { options: Options; close: () => void; reset: () => void }) {
  const { client, deals, receiving, custodians, assetMaps } = options;
  const [dealId, setDealId] = useState("");
  const deal = deals.find(option => option.id === dealId) ?? null;
  const modes: { value: ConnectedSourceMode; label: string }[] = [
    ...(assetMaps?.length ? [{ value: "asset_map" as const, label: "From an asset map account" }] : []),
    ...(deal?.accountLast4 ? [{ value: "deal" as const, label: "From the deal's source account" }] : []),
    { value: "pending", label: "Not known yet · Operations links the asset map later" },
  ];
  const [sourceMode, setSourceMode] = useState<ConnectedSourceMode>(modes[0].value);
  const mode = modes.some(option => option.value === sourceMode) ? sourceMode : modes[0].value;
  const [assetMapId, setAssetMapId] = useState("");
  const dealLast4 = lastFour(deal?.accountLast4);
  const maps = [...(assetMaps ?? [])].sort((a, b) =>
    Number(Boolean(dealLast4) && lastFour(b.accountNumberMasked) === dealLast4) - Number(Boolean(dealLast4) && lastFour(a.accountNumberMasked) === dealLast4));
  const chosenMap = maps.find(option => option.accountId === assetMapId) ?? null;
  const recordedFirm = mode === "asset_map" ? chosenMap?.custodian : mode === "deal" ? deal?.transferringFirm : null;
  const suggested = custodians?.filter(option => firmKey(option.name) === firmKey(recordedFirm)) ?? [];
  const [custodianChoice, setCustodianChoice] = useState<string | null>(null);
  const custodianId = custodianChoice ?? (suggested.length === 1 ? suggested[0].id : "");
  const [destinationMode, setDestinationMode] = useState<"apex" | "new">(receiving.length ? "apex" : "new");
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const submit = (data: FormData) => {
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const [first, ...rest] = client.name.split(" ");
    const typed = text("value").replace(/[$,\s]/g, "");
    const values = {
      ...EMPTY_TRANSFER_FORM,
      client_first_name: first || client.name,
      client_last_name: rest.join(" ") || first || client.name,
      client_sf_id: client.sfId,
      household_name: client.householdName ?? "",
      household_sf_id: client.householdSfId ?? "",
      value: typed || (deal ? String(deal.amount) : ""),
    };
    const intake = {
      clientSfId: client.sfId, dealId, sourceMode: mode, assetMapAccountId: mode === "asset_map" ? assetMapId : "",
      sourceType: text("sourceType"), deliveringCustodianId: custodianId,
      destinationMode, apexAccountKey: text("apexAccountKey"), destinationType: text("destinationType"),
      destinationTitle: text("destinationTitle"), route: text("route"),
    };
    startTransition(async () => {
      const result = await createTransfer(values, intake);
      if (result && !result.ok) setErrors(result.errors.map(error => error.message));
    });
  };

  return (
    <form id="new-transfer-form" onSubmit={event => { event.preventDefault(); submit(new FormData(event.currentTarget)); }}>
      <div className="row">
        <p style={{ flex: 1 }}><strong>{client.name}</strong>{client.householdName ? ` · ${client.householdName}` : ""}</p>
        <button className="btn" type="button" onClick={reset}>Change client</button>
      </div>
      <label className="field"><span>Deal</span>
        <select name="dealId" value={dealId} onChange={event => setDealId(event.target.value)}>
          <option value="">No deal</option>
          {deals.map(option => <option key={option.id} value={option.id} disabled={Boolean(option.linkedTransferId)}>
            {[option.name, money(option.amount), option.stage, option.linkedTransferId ? `linked to ${option.linkedTransferId}` : null].filter(Boolean).join(" · ")}
          </option>)}
        </select>
      </label>
      <section className="intake-account-section">
        <h3>From · source account</h3>
        <label className="field"><span>Source account</span>
          <select name="sourceMode" value={mode} onChange={event => setSourceMode(event.target.value as ConnectedSourceMode)}>
            {modes.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        {mode === "asset_map" ? (
          <label className="field"><span>Asset map account</span>
            <select name="assetMapAccountId" value={assetMapId} required onChange={event => setAssetMapId(event.target.value)}>
              <option value="" disabled>Choose an account</option>
              {maps.map(option => <option key={option.accountId} value={option.accountId}>
                {[dealLast4 && lastFour(option.accountNumberMasked) === dealLast4 ? "Recommended" : null,
                  option.householdName, option.custodian, option.accountType, option.accountNumberMasked, option.accountHolder]
                  .filter(Boolean).join(" · ")}
              </option>)}
            </select>
          </label>
        ) : null}
        {mode === "deal" && deal ? <>
          <p className="small">{[deal.transferringFirm, `••${dealLast4 || deal.accountLast4}`].filter(Boolean).join(" · ")}, as recorded on the deal.</p>
          <label className="field"><span>Source account type</span>
            <select name="sourceType" required>{INTAKE_ACCOUNT_TYPES.map(type => <option key={type}>{type}</option>)}</select>
          </label>
        </> : null}
        {mode === "pending" ? <p className="small">The transfer opens without a source account. Operations links the asset map account on the transfer before paperwork.</p> : null}
        {custodians ? (
          <label className="field"><span>Delivering firm</span>
            <select name="deliveringCustodianId" value={custodianId} onChange={event => setCustodianChoice(event.target.value)}>
              <option value="">Not set yet</option>
              {custodians.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
        ) : <p className="small">Operations sets the delivering firm from the custodian library.</p>}
        <p className="small">Add and review this account’s statement next. The full account number is read from the statement, not stored here.</p>
      </section>
      <section className="intake-account-section">
        <h3>To · receiving account at Apex</h3>
        <label className="field"><span>Receiving account</span>
          <select name="destinationMode" value={destinationMode} onChange={event => setDestinationMode(event.target.value === "apex" ? "apex" : "new")}>
            {receiving.length ? <option value="apex">An open Apex account</option> : null}
            <option value="new">New account · opening pending</option>
          </select>
        </label>
        {destinationMode === "apex" ? (
          <label className="field"><span>Apex account</span>
            <select name="apexAccountKey" required>
              {receiving.map(account => <option key={account.key} value={account.key}>{account.label}</option>)}
            </select>
          </label>
        ) : <>
          <label className="field"><span>Receiving account type</span>
            <select name="destinationType" required>{RECEIVING_ACCOUNT_TYPES.map(type => <option key={type}>{type}</option>)}</select>
          </label>
          <label className="field"><span>Registered receiving account title</span>
            <input name="destinationTitle" required maxLength={250} defaultValue={client.name} />
          </label>
          <p className="small">The account-opening workflow remains in AoA. The status follows the Apex record once the account opens.</p>
        </>}
      </section>
      <label className="field"><span>Proposed movement path</span>
        <select name="route" required>{INTAKE_ROUTES.map(route => <option key={route.value} value={route.value}>{route.label}</option>)}</select>
      </label>
      {deal ? <p className="small">Value: {money(deal.amount)}, from the deal.</p> : (
        <label className="field"><span>Estimated value</span>
          <input name="value" required inputMode="decimal" placeholder="Estimate from the latest statement" />
        </label>
      )}
      <p className="small">This is a proposed plan. Asset eligibility, account registration and Ops approval are checked before paperwork or submission.</p>
      <p id="form-error" className="upload-error" role="alert" tabIndex={-1}>{errors.join(" ")}</p>
      <div className="row">
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Creating…" : "Create transfer"}</button>
        <button className="btn" type="button" onClick={close}>Cancel</button>
      </div>
      <p className="small">Creates the transfer in Decision with its preparation checklist. No paperwork or custodian request is sent.</p>
    </form>
  );
}

function NewTransferForm({ close }: { close: () => void }) {
  const [options, setOptions] = useState<Options | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const choose = (client: ConnectedClient) => startTransition(async () => {
    const loaded = await loadTransferIntakeOptions(client.sfId);
    setFailed(!loaded.ok);
    setOptions(loaded.ok ? loaded : null);
  });
  if (options) return <IntakeForm key={options.client.sfId} options={options} close={close} reset={() => setOptions(null)} />;
  return <>
    <ClientSearch onChoose={choose} />
    {pending ? <p className="small">Loading the client’s records…</p> : null}
    {failed ? <p className="small" role="alert">That client’s records could not be loaded. Choose the client again.</p> : null}
    <div className="row"><button className="btn" type="button" onClick={close}>Cancel</button></div>
  </>;
}

/** The workspace heading's "New transfer" control: the intake dialog over the existing create action. */
export function NewTransferDialog() {
  return (
    <WorkspaceDialog title="New transfer" trigger="New transfer" triggerStyle={{ primary: true }}>
      {close => <>
        <p>Choose a client from the client directory, then the deal and accounts on file. A source account Operations has not mapped yet keeps this transfer in preparation.</p>
        <NewTransferForm close={close} />
      </>}
    </WorkspaceDialog>
  );
}
