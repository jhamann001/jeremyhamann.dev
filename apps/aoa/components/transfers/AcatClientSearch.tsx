"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { searchAcatBookClients } from "@/app/(authenticated)/acat-tracking/book-actions";
import {
  canAddClient,
  CLIENT_SEARCH_DEBOUNCE_MS,
  CLIENT_SEARCH_MAX,
  CLIENT_SEARCH_MIN,
  clientSearchKey,
  HAS_MORE_COPY,
  isStaleSearch,
  MAX_SELECTED_CLIENTS,
  NO_ACCOUNT_COPY,
  NO_MATCH_COPY,
  type AcatAccountHint,
  type AcatClientResult,
  type AcatDirectoryStatus,
  type AcatSelectedClient,
} from "@/lib/data/acat-create-contract";
import styles from "./AcatNewTransferDialog.module.css";

export function accountHintText(hint: AcatAccountHint): string {
  return [hint.custodian, hint.maskedAccountNumber ?? "Account number pending", hint.relationshipType]
    .filter(Boolean)
    .join(" · ");
}

export function AcatClientResultRow({ client }: { client: AcatClientResult }) {
  return (
    <>
      <span className={styles.resultName}>{client.displayName}</span>
      {client.accountHints.length === 0
        ? <span className={styles.resultHint}>{NO_ACCOUNT_COPY}</span>
        : client.accountHints.map((hint, i) => (
          <span key={i} className={styles.resultHint}>{accountHintText(hint)}</span>
        ))}
      <span className={styles.resultId}>ID ending {client.cedarRidgeUserId.slice(-8)}</span>
    </>
  );
}

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "done"; clients: AcatClientResult[]; hasMore: boolean };

export function AcatClientSearch({ selected, onChange, onDirectory }: {
  selected: AcatSelectedClient[];
  onChange: (next: AcatSelectedClient[]) => void;
  onDirectory: (directory: AcatDirectoryStatus | null, query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ kind: "idle" });
  const [highlight, setHighlight] = useState(-1);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(selected.length === 0);
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function run(text: string) {
    const requestId = ++latest.current;
    if (timer.current) clearTimeout(timer.current);
    if (text.trim().length < CLIENT_SEARCH_MIN) {
      setSearch({ kind: "idle" });
      setOpen(false);
      return;
    }
    setSearch({ kind: "loading" });
    setOpen(true);
    timer.current = setTimeout(async () => {
      const result = await searchAcatBookClients(text.trim());
      if (isStaleSearch(requestId, latest.current)) return;
      if (!result.ok) { setSearch({ kind: "error", reason: result.reason }); return; }
      onDirectory(result.directory, text.trim());
      const fresh = result.clients.filter((c) => !selected.some((s) => s.cedarRidgeUserId === c.cedarRidgeUserId));
      setSearch({ kind: "done", clients: fresh, hasMore: result.hasMore });
      setHighlight(fresh.length > 0 ? 0 : -1);
    }, CLIENT_SEARCH_DEBOUNCE_MS);
  }

  function pick(client: AcatClientResult) {
    if (!canAddClient(selected.length)) return;
    onChange([...selected, { cedarRidgeUserId: client.cedarRidgeUserId, displayName: client.displayName }]);
    latest.current += 1;
    setQuery("");
    setSearch({ kind: "idle" });
    setOpen(false);
    setAdding(false);
  }

  const results = search.kind === "done" ? search.clients : [];

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
    event.preventDefault();
    const next = clientSearchKey(event.key, highlight, results.length);
    setHighlight(next.highlight);
    if (next.close) setOpen(false);
    if (next.select) pick(results[next.highlight]);
  }

  const listId = "acat-client-search-results";
  const canAdd = canAddClient(selected.length);

  return (
    <div className={styles.clientSearch}>
      {selected.length > 0 && (
        <ul className={styles.chips} aria-label="Selected clients">
          {selected.map((client) => (
            <li key={client.cedarRidgeUserId} className={styles.chip}>
              <span>{client.displayName ?? `ID ending ${client.cedarRidgeUserId.slice(-8)}`}</span>
              <button type="button" className={styles.linkButton}
                aria-label={`Remove ${client.displayName ?? "client"}`}
                onClick={() => {
                  const next = selected.filter((s) => s.cedarRidgeUserId !== client.cedarRidgeUserId);
                  onChange(next);
                  if (next.length === 0) setAdding(true);
                }}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {!canAdd && <p className={styles.hint}>A transfer can include up to {MAX_SELECTED_CLIENTS} people.</p>}
      {canAdd && !adding && selected.length > 0 && (
        <button type="button" className={styles.linkButton} onClick={() => setAdding(true)}>Add another person</button>
      )}
      {canAdd && adding && (
        <div className={styles.comboWrap}>
          <input
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            aria-label="Search for a Cedar Ridge client"
            placeholder="Type at least 2 characters"
            maxLength={CLIENT_SEARCH_MAX}
            value={query}
            onChange={(e) => { setQuery(e.target.value); run(e.target.value); }}
            onKeyDown={onKey}
          />
          {open && (
            <div className={styles.results} id={listId} role="listbox">
              {search.kind === "loading" && <p className={styles.hint} role="status">Searching…</p>}
              {search.kind === "error" && (
                <div className={styles.hint} role="alert">
                  {search.reason}{" "}
                  <button type="button" className={styles.linkButton} onClick={() => run(query)}>Try search again</button>
                </div>
              )}
              {search.kind === "done" && results.length === 0 && <p className={styles.hint}>{NO_MATCH_COPY}</p>}
              {results.map((client, i) => (
                <div key={client.cedarRidgeUserId} role="option" aria-selected={i === highlight}
                  className={i === highlight ? `${styles.result} ${styles.resultActive}` : styles.result}
                  onMouseDown={(e) => { e.preventDefault(); pick(client); }}
                  onMouseEnter={() => setHighlight(i)}>
                  <AcatClientResultRow client={client} />
                </div>
              ))}
              {search.kind === "done" && search.hasMore && <p className={styles.hint}>{HAS_MORE_COPY}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
