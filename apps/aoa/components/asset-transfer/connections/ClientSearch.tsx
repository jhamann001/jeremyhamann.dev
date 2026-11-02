"use client";

import { useState, useTransition } from "react";
import { searchTransferClients } from "@/app/(authenticated)/asset-transfer/connection-actions";
import type { ConnectedClient } from "@/lib/transfers/connections";

/** Searches the client directory; transfers are opened for and linked to directory clients only. */
export function ClientSearch({ onChoose, disabled = false }: { onChoose: (client: ConnectedClient) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConnectedClient[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();
  const search = () => startTransition(async () => {
    const found = await searchTransferClients(query);
    setFailed(!found.ok);
    setResults(found.ok ? found.clients : []);
  });
  return <>
    <div className="row">
      <label className="field" style={{ flex: 1 }}><span>Client</span>
        <input value={query} maxLength={120} placeholder="Search the client directory by name"
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); search(); } }} />
      </label>
      <button className="btn" type="button" onClick={search} disabled={disabled || pending || query.trim().length < 2}>
        {pending ? "Searching…" : "Search"}
      </button>
    </div>
    {failed ? <p className="small" role="alert">The client directory could not be searched. Try again.</p> : null}
    {results && !failed ? (results.length ? (
      <label className="field"><span>Matching clients</span>
        <select defaultValue="" disabled={disabled} onChange={event => {
          const chosen = results.find(client => client.sfId === event.target.value);
          if (chosen) onChoose(chosen);
        }}>
          <option value="" disabled>Choose a client</option>
          {results.map(client => <option key={client.sfId} value={client.sfId}>
            {client.householdName ? `${client.name} · ${client.householdName}` : client.name}
          </option>)}
        </select>
      </label>
    ) : <p className="small">No client in the directory matches.</p>) : null}
  </>;
}
