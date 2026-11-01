"use client";

import { useEffect, useRef, useState } from "react";
import { CLIENT_IDENTITY_MAX_CLIENTS, type ClientSearchItem } from "@/lib/client-identity-contract";
import ClientIdentityPicker from "./ClientIdentityPicker";

interface Props {
  selected: ClientSearchItem[];
  onChange: (clients: ClientSearchItem[]) => void;
  disabled?: boolean;
}

export default function ClientIdentitySelection({ selected, onChange, disabled = false }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const focusAfterChange = useRef(false);
  const [adding, setAdding] = useState(selected.length === 0);
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const canAdd = selected.length < CLIENT_IDENTITY_MAX_CLIENTS;
  const showSearch = canAdd && (adding || selected.length === 0);

  useEffect(() => {
    if (!focusAfterChange.current) return;
    focusAfterChange.current = false;
    const target = showSearch ? container.current?.querySelector<HTMLElement>('[role="combobox"]')
      : container.current?.querySelector<HTMLElement>('[data-add-client]') ?? container.current?.querySelector<HTMLElement>('[data-remove-client]');
    target?.focus();
  }, [showSearch, selected.length]);

  function remove(client: ClientSearchItem) {
    onChange(selected.filter((item) => item.cedarRidgeUserId !== client.cedarRidgeUserId));
    setAnnouncement(`Removed ${client.displayName}, ID ending ${client.cedarRidgeUserId.slice(-8)}.`);
    focusAfterChange.current = true;
  }

  return <div ref={container}>
    {selected.length > 0 && <ul aria-label="Selected clients" className="mb-2 space-y-2">
      {selected.map((client) => <li key={client.cedarRidgeUserId} className="flex items-start justify-between gap-2 rounded border border-card-border px-3 py-2">
        <span className="min-w-0"><span className="block break-words text-sm font-medium">{client.displayName}</span><span className="block text-xs text-muted">ID ending {client.cedarRidgeUserId.slice(-8)}</span></span>
        <button type="button" data-remove-client disabled={disabled} aria-label={`Remove ${client.displayName}, ID ending ${client.cedarRidgeUserId.slice(-8)}`} className="shrink-0 text-xs text-accent underline disabled:opacity-50" onClick={() => remove(client)}>Remove</button>
      </li>)}
    </ul>}
    {showSearch ? <ClientIdentityPicker query={query} selected={null} excludedIds={selected.map((client) => client.cedarRidgeUserId)} disabled={disabled} autoFocus={adding && selected.length > 0} onQueryChange={setQuery} onSelect={(client) => {
      if (selected.some((item) => item.cedarRidgeUserId === client.cedarRidgeUserId) || !canAdd) return;
      onChange([...selected, client]);
      setQuery(""); setAdding(false);
      setAnnouncement(`Added ${client.displayName}, ID ending ${client.cedarRidgeUserId.slice(-8)}.`);
      focusAfterChange.current = true;
    }} /> : canAdd ? <button type="button" data-add-client disabled={disabled} className="text-xs text-accent underline disabled:opacity-50" onClick={() => { setAdding(true); focusAfterChange.current = true; }}>Add another person</button>
      : <p className="text-xs text-muted">Up to {CLIENT_IDENTITY_MAX_CLIENTS} people can be linked. Remove a person before adding another.</p>}
    <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
  </div>;
}
