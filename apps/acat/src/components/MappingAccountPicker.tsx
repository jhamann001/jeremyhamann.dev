"use client";

import { useState } from "react";
import useSWR from "swr";
import type { MappingAccount } from "@/lib/mapping-account";

interface Props {
  acatId: string;
  clientName: string;
  accountType?: string;
  syncing: boolean;
  onSelect: (accountId: string) => Promise<void>;
  onClose: () => void;
}

export default function MappingAccountPicker({ acatId, clientName, accountType, syncing, onSelect, onClose }: Props) {
  const initialSearch = clientName.trim().split(/\s+/).at(-1) ?? "";
  const [input, setInput] = useState(initialSearch);
  const [query, setQuery] = useState(initialSearch);
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error, isLoading } = useSWR<{ accounts: MappingAccount[]; truncated: boolean }>(
    query.length >= 2 ? `/api/asset-mapping/accounts?${new URLSearchParams({ acatId, q: query })}` : null
  );
  const chosen = data?.accounts.find((account) => account.id === selected);

  return (
    <section aria-label="Choose mapping account" className="space-y-3 rounded-lg border border-accent/40 bg-[var(--bg-card)] p-4">
      <h4 className="text-sm font-semibold">Choose mapping account</h4>
      <p className="text-xs text-muted">Link holdings for {clientName}{accountType ? ` — ${accountType}` : ""}. Check the holder and registration before syncing.</p>
      <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); setSelected(null); setQuery(input.trim()); }}>
        <input aria-label="Search mapping accounts" value={input} onChange={(event) => setInput(event.target.value)} minLength={2} maxLength={100} required disabled={syncing} placeholder="Client name or account number" className="min-w-0 flex-1 rounded-md border border-card-border bg-[var(--bg-input)] px-2 py-1.5 text-xs" />
        <button type="submit" disabled={syncing || input.trim().length < 2} className="rounded-md border border-card-border px-3 text-xs disabled:opacity-50">Search</button>
      </form>
      {isLoading && <p className="text-xs text-muted">Searching mapping accounts…</p>}
      {error && <p role="alert" className="text-xs text-[color:var(--danger)]">Unable to load mapping accounts. Try searching again.</p>}
      {data && !data.accounts.length && <p className="text-xs text-muted">No source accounts found. Try another name or add the statement to asset mapping.</p>}
      {data?.truncated && <p className="text-xs text-muted">More accounts match. Narrow your search to find the right registration.</p>}
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {data?.accounts.map((account) => (
          <label key={account.id} className={`flex cursor-pointer gap-2 rounded-md border p-3 text-xs ${selected === account.id ? "border-accent bg-accent-light/30" : "border-card-border"}`}>
            <input type="radio" name={`mapping-account-${acatId}`} value={account.id} checked={selected === account.id} onChange={() => setSelected(account.id)} disabled={syncing} />
            <span className="space-y-1">
              <span className="block font-semibold">{account.holder || account.clientName} — {account.registration || "Registration not provided"}</span>
              <span className="block">{account.custodian || "Custodian not provided"} · {account.accountNumberLast4 ? `Account …${account.accountNumberLast4}` : "No account number"}{account.investorNumberLast4 ? ` · Investor …${account.investorNumberLast4}` : ""}</span>
              <span className="block text-muted">{account.positionCount} positions · Statement: {account.statementDate || "Not provided"}</span>
              {account.isHistorical && <span className="block text-[color:var(--warning)]">Latest available account data is from an earlier household run.</span>}
            </span>
          </label>
        ))}
      </div>
      {chosen && <p className="text-xs text-muted">Sync will replace expected holdings with this registration’s positions. Received quantities and reconciliation notes are retained.</p>}
      <div className="flex gap-2">
        <button type="button" disabled={!chosen || syncing || isLoading || !!error} onClick={() => chosen && void onSelect(chosen.id)} className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{syncing ? "Syncing…" : "Link and sync"}</button>
        <button type="button" disabled={syncing} onClick={onClose} className="rounded-md border border-card-border px-3 py-2 text-xs">Cancel</button>
      </div>
    </section>
  );
}
