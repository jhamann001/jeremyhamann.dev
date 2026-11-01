"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { ClientSearchItem, CLIENT_SEARCH_MAX_LENGTH, CLIENT_SEARCH_MIN_LENGTH } from "@/lib/client-identity-contract";
import { useClientSearch } from "@/hooks/use-client-search";

interface ClientIdentityPickerProps {
  query: string;
  selected: ClientSearchItem | null;
  onQueryChange: (query: string) => void;
  onSelect: (client: ClientSearchItem) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  excludedIds?: string[];
}

export default function ClientIdentityPicker({ query, selected, onQueryChange, onSelect, disabled = false, autoFocus = false, excludedIds = [] }: ClientIdentityPickerProps) {
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const search = useClientSearch(query, open && !selected && !disabled);
  const items = search.items.filter((client) => !excludedIds.includes(client.cedarRidgeUserId));
  const showResults = open && !selected && query.trim().length >= CLIENT_SEARCH_MIN_LENGTH;
  const active = highlight >= 0 && highlight < items.length ? highlight : -1;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const select = (client: ClientSearchItem) => {
    onSelect(client);
    setOpen(false);
    setHighlight(-1);
  };

  return (
    <div ref={container} className="relative min-w-0">
      <input
        role="combobox"
        aria-label="Search client name"
        aria-autocomplete="list"
        aria-expanded={showResults}
        aria-controls={`${id}-results`}
        aria-describedby={`${id}-help`}
        aria-activedescendant={showResults && active >= 0 ? `${id}-option-${active}` : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        value={query}
        maxLength={CLIENT_SEARCH_MAX_LENGTH}
        disabled={disabled}
        placeholder="Search by client name"
        className="form-input"
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          if (!container.current?.contains(event.relatedTarget as Node)) setOpen(false);
        }}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { if (showResults) { event.preventDefault(); event.stopPropagation(); } setOpen(false); setHighlight(-1); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            if (items.length) setHighlight((value) => event.key === "ArrowDown" ? Math.min(value + 1, items.length - 1) : Math.max(value - 1, 0));
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (showResults && active >= 0) select(items[active]);
          }
        }}
      />
      <p id={`${id}-help`} className="mt-1 text-xs text-muted">
        {selected ? <span className="inline-flex items-center gap-1"><Check size={12} />Selected client · ID ending {selected.cedarRidgeUserId.slice(-8)}</span> : "Type at least two characters, then select the correct person."}
      </p>
      {showResults && (
        <div className="absolute left-0 right-0 z-50 mt-1 rounded-lg border border-card-border bg-[var(--bg-card)] shadow-lg">
          {search.loading && <p role="status" className="flex items-center gap-2 p-3 text-xs text-muted"><Loader2 size={13} className="animate-spin" />Searching clients…</p>}
          {search.error && <div className="p-3 text-xs"><p role="alert">{search.error}</p><button type="button" className="mt-2 text-accent underline" onClick={search.retry}>Try search again</button></div>}
          {search.directory && search.directory.health !== "FRESH" && <p role="status" className="px-3 pt-3 text-xs text-[color:var(--warning)]">Directory verification is unavailable. Results can be reviewed, but linking is paused.</p>}
          <ul id={`${id}-results`} role="listbox" aria-label="Matching clients" className="max-h-64 overflow-y-auto">
            {items.map((client, index) => (
              <li key={client.cedarRidgeUserId}>
                <button
                  type="button"
                  id={`${id}-option-${index}`}
                  role="option"
                  aria-selected={active === index}
                  tabIndex={-1}
                  className={`block w-full px-3 py-2 text-left text-sm ${active === index ? "bg-accent-light" : "hover:bg-[var(--bg-hover)]"}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => select(client)}
                >
                  <span className="block font-medium text-foreground">{client.displayName}</span>
                  <span className="block text-xs text-muted">{client.accountHints.length ? client.accountHints.map((hint) => [hint.custodian, hint.maskedAccountNumber || "Account number pending", hint.relationshipType].filter(Boolean).join(" · ")).join("; ") : "No account number on file"}</span>
                  <span className="block text-xs text-muted">ID ending {client.cedarRidgeUserId.slice(-8)}</span>
                </button>
              </li>
            ))}
          </ul>
          {!search.loading && !search.error && items.length === 0 && <p role="status" className="p-3 text-xs text-muted">{search.items.length ? "Matching clients are already selected. Try another name." : "No matching clients. Check the spelling or try another name."}</p>}
          {search.hasMore && <p className="border-t border-card-border p-3 text-xs text-muted">More matches are available. Enter more of the name.</p>}
        </div>
      )}
    </div>
  );
}
