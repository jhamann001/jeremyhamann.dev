"use client";

import { useEffect, useId, useRef, useState } from "react";
import { NEW_REQUEST_COPY, toggleValue, type NewRequestClient } from "@/lib/trade-requests/new-request";
import styles from "./NewRequestForm.module.css";

export function ClientMultiSelect({ clients, selectedIds, onChange, labelId, disabled = false }: {
  clients: readonly NewRequestClient[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  labelId: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const valueId = useId();

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  useEffect(() => {
    if (open) searchInput.current?.focus();
  }, [open]);

  const term = search.toLowerCase();
  const filtered = term
    ? clients.filter((client) => client.name.toLowerCase().includes(term) || client.id.toLowerCase().includes(term))
    : clients;
  const chosen = selectedIds
    .map((id) => clients.find((client) => client.id === id))
    .filter((client): client is NewRequestClient => !!client);
  const toggle = (id: string) => onChange(toggleValue(selectedIds, id));
  const optionId = (client: NewRequestClient) => `${listboxId}-${client.id}`;

  return (
    <div ref={root} className={styles.select}>
      <button
        type="button" disabled={disabled} className={`${styles.input} ${styles.selectButton}`}
        onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined} aria-labelledby={`${labelId} ${valueId}`}
      >
        <span id={valueId} className={styles.selectValue}>
          {chosen.length === 0 && <span className={styles.placeholder}>{NEW_REQUEST_COPY.selectClients}</span>}
          {chosen.length === 1 && chosen[0].name}
          {chosen.length > 1 && `${chosen.length} clients selected`}
        </span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>

      {chosen.length > 1 && (
        <div className={styles.chips}>
          {chosen.map((client) => (
            <span key={client.id} className={styles.chip}>
              {client.name}
              {!disabled && (
                <button type="button" className={styles.chipRemove} onClick={() => toggle(client.id)} aria-label={`Remove ${client.name}`}>×</button>
              )}
            </span>
          ))}
        </div>
      )}

      {open && !disabled && (
        <div className={styles.dropdown} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
          <div className={styles.dropdownSearch}>
            <input
              ref={searchInput} type="text" role="combobox" aria-expanded aria-controls={listboxId} aria-autocomplete="list"
              aria-label={NEW_REQUEST_COPY.searchClients} placeholder={NEW_REQUEST_COPY.searchClients} className={styles.input}
              aria-activedescendant={active >= 0 && filtered[active] ? optionId(filtered[active]) : undefined}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setActive(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((index) => Math.min(index + 1, filtered.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => Math.max(index - 1, 0));
                } else if (event.key === "Enter" && active >= 0 && filtered[active]) {
                  event.preventDefault();
                  toggle(filtered[active].id);
                } else if (event.key === "Escape") {
                  setOpen(false);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  setActive(0);
                } else if (event.key === "End") {
                  event.preventDefault();
                  setActive(filtered.length - 1);
                }
              }}
            />
          </div>
          <div id={listboxId} role="listbox" aria-multiselectable="true" aria-label={NEW_REQUEST_COPY.clientList} className={styles.options}>
            {filtered.length === 0 && <div className={styles.empty}>{NEW_REQUEST_COPY.noClients}</div>}
            {filtered.map((client, index) => (
              <label
                key={client.id} id={optionId(client)} role="option" aria-selected={selectedIds.includes(client.id)}
                className={`${styles.option} ${index === active ? styles.optionActive : ""}`.trim()}
              >
                <input
                  type="checkbox" tabIndex={-1} className={styles.checkbox}
                  checked={selectedIds.includes(client.id)} onChange={() => toggle(client.id)}
                />
                <span>{client.name}</span>
                <span className={styles.optionCount}>{client.accounts.length} acct{client.accounts.length !== 1 ? "s" : ""}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
