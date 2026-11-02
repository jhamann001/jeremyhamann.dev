"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { replaceTransferClient, searchTransferClients } from "@/app/(authenticated)/acat-tracking/transfer-drawer-actions";
import {
  canAddClient,
  CLIENT_SEARCH_DEBOUNCE_MS,
  CLIENT_SEARCH_MAX,
  CLIENT_SEARCH_MIN,
  clientSearchKey,
  HAS_MORE_COPY,
  isStaleSearch,
  MAX_SELECTED_CLIENTS,
  NO_MATCH_COPY,
  type AcatClientResult,
  type AcatDirectoryStatus,
  type AcatSelectedClient,
} from "@/lib/data/acat-create-contract";
import {
  ACAT_DRAWER_SEARCH_FAILURE,
  ACAT_WRITE_UNAVAILABLE,
  CLIENT_IDENTITY_REASON_MAX,
  type DrawerTransfer,
} from "@/lib/data/acat-drawer-contract";
import { AcatClientResultRow } from "./AcatClientSearch";
import { dialogKeyDown, useFirstFocus } from "./AcatTransferModals";
import styles from "./AcatTransferDrawer.module.css";

const MAPPING_ACK_COPY =
  "I understand that a changed name clears the saved statement-account mapping link and it will need to be selected again.";
const DIRECTORY_STALE_COPY = "The client directory needs a fresh verified update before linking.";
const DIRECTORY_PAUSED_COPY = "Client verification is unavailable. Linking is paused.";
const DIRECTORY_IDLE_COPY = "Search for a client to check the directory.";
const CEDAR_RIDGE_USER = /^user-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type SearchState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "done"; clients: AcatClientResult[]; hasMore: boolean };

function seededSelection(linkedIds: string | number | boolean | null | undefined, name: string | null): AcatSelectedClient[] {
  const ids = typeof linkedIds === "string"
    ? linkedIds.split(",").map((id) => id.trim()).filter((id) => CEDAR_RIDGE_USER.test(id))
    : [];
  return ids.map((cedarRidgeUserId) => ({
    cedarRidgeUserId,
    displayName: ids.length === 1 && name ? name : "Linked client",
  }));
}

export function AcatClientReplaceDialog({ transfer, linkedIds, onClose, onSaved }: {
  transfer: DrawerTransfer;
  linkedIds: string | number | boolean | null | undefined;
  onClose: (refresh: boolean) => void;
  onSaved: (next: DrawerTransfer) => boolean;
}) {
  const titleId = useId();
  const listId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useFirstFocus(dialog);
  const [reviewed] = useState(() => ({ version: transfer.identityVersion, name: transfer.clientName ?? "" }));
  const [selected, setSelected] = useState<AcatSelectedClient[]>(() => seededSelection(linkedIds, transfer.clientName));
  const [hadLink] = useState(() => selected.length > 0);
  const [reason, setReason] = useState("");
  const [account, setAccount] = useState("");
  const [needAck, setNeedAck] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ reason: string; retryable: boolean } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ kind: "idle" });
  const [directory, setDirectory] = useState<AcatDirectoryStatus | null>(null);
  const [searched, setSearched] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(selected.length === 0);
  const latest = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQuery = useRef("");

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const versionOk = typeof reviewed.version === "number" && Number.isInteger(reviewed.version);
  const canVerify = directory?.health === "FRESH";
  const canSave = selected.length > 0 && reason.trim() !== "" && canVerify && versionOk && !conflict
    && (!needAck || acknowledged) && !saving;

  async function runSearch(text: string) {
    const requestId = ++latest.current;
    lastQuery.current = text;
    setSearch({ kind: "loading" });
    setOpen(true);
    try {
      const result = await searchTransferClients(text);
      if (isStaleSearch(requestId, latest.current)) return;
      if (!result.ok) { setSearch({ kind: "error", reason: ACAT_DRAWER_SEARCH_FAILURE }); return; }
      setSearched(true);
      setDirectory(result.directory);
      const fresh = result.clients.filter((c) => !selected.some((s) => s.cedarRidgeUserId === c.cedarRidgeUserId));
      setSearch({ kind: "done", clients: fresh, hasMore: result.hasMore });
      setHighlight(fresh.length > 0 ? 0 : -1);
    } catch {
      if (!isStaleSearch(requestId, latest.current)) setSearch({ kind: "error", reason: ACAT_DRAWER_SEARCH_FAILURE });
    }
  }

  function onQuery(text: string) {
    setQuery(text);
    latest.current += 1;
    if (timer.current) clearTimeout(timer.current);
    if (text.trim().length < CLIENT_SEARCH_MIN) { setSearch({ kind: "idle" }); setOpen(false); return; }
    setSearch({ kind: "loading" });
    setOpen(true);
    timer.current = setTimeout(() => void runSearch(text.trim()), CLIENT_SEARCH_DEBOUNCE_MS);
  }

  function pick(client: AcatClientResult) {
    if (!canAddClient(selected.length)) return;
    setSelected([...selected, { cedarRidgeUserId: client.cedarRidgeUserId, displayName: client.displayName }]);
    latest.current += 1;
    setQuery("");
    setSearch({ kind: "idle" });
    setOpen(false);
    setAdding(false);
  }

  const results = search.kind === "done" ? search.clients : [];

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    event.preventDefault();
    const next = clientSearchKey(event.key, highlight, results.length);
    setHighlight(next.highlight);
    if (next.select) pick(results[next.highlight]);
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const result = await replaceTransferClient(transfer.id, {
        cedarRidgeUserIds: selected.map((c) => c.cedarRidgeUserId),
        expectedIdentityVersion: reviewed.version,
        reason,
        apexAccountId: account,
        acknowledgeMappingInvalidation: needAck && acknowledged,
      });
      if (result.ok) {
        onSaved(result.transfer);
        onClose(false);
        return;
      }
      if (result.code === "MAPPING_INVALIDATION_REQUIRED") { setNeedAck(true); setAcknowledged(false); }
      if (result.code === "IDENTITY_CONFLICT") setConflict(true);
      if ((result.code === "DIRECTORY_STALE" || result.code === "DIRECTORY_UNAVAILABLE") && lastQuery.current) {
        void runSearch(lastQuery.current);
      }
      setError({ reason: result.reason, retryable: result.retryable });
    } catch {
      setError({ reason: ACAT_WRITE_UNAVAILABLE, retryable: true });
    } finally {
      setSaving(false);
    }
  }

  const directoryCopy = !searched ? DIRECTORY_IDLE_COPY
    : directory?.health === "STALE" ? DIRECTORY_STALE_COPY
      : DIRECTORY_PAUSED_COPY;

  return (
    <div className={styles.dialogScrim}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} data-acat-dialog=""
        className={styles.dialog} onKeyDown={(e) => dialogKeyDown(e, dialog, () => onClose(false), saving)}>
        <div className={styles.dialogHead}>
          <h2 id={titleId} className={styles.dialogTitle}>{hadLink ? "Review client link" : "Link client"}</h2>
        </div>
        <div className={styles.dialogBody}>
          <p className={styles.cardSub}>
            Current record name: <strong>{reviewed.name}</strong>. Linking replaces the saved name with the selected client&apos;s name.
          </p>
          {selected.length > 0 && (
            <ul className={styles.selection} aria-label="Selected clients">
              {selected.map((client) => (
                <li key={client.cedarRidgeUserId} className={styles.chip}>
                  <span>{client.displayName ?? `ID ending ${client.cedarRidgeUserId.slice(-8)}`}</span>
                  <button type="button" className={styles.linkButton} disabled={saving}
                    aria-label={`Remove ${client.displayName ?? "client"}`}
                    onClick={() => {
                      const next = selected.filter((s) => s.cedarRidgeUserId !== client.cedarRidgeUserId);
                      setSelected(next);
                      if (next.length === 0) setAdding(true);
                    }}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          {!canAddClient(selected.length) && (
            <p className={styles.cardSub}>A transfer can include up to {MAX_SELECTED_CLIENTS} people.</p>
          )}
          {canAddClient(selected.length) && !adding && selected.length > 0 && (
            <button type="button" className={styles.linkButton} onClick={() => setAdding(true)}>Add another person</button>
          )}
          {canAddClient(selected.length) && adding && (
            <div className={styles.contraBox}>
              <input role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-label="Search for a Cedar Ridge client"
                className={styles.input} placeholder="Type at least 2 characters" maxLength={CLIENT_SEARCH_MAX}
                value={query} disabled={saving} onChange={(e) => onQuery(e.target.value)} onKeyDown={onSearchKey} />
              {open && (
                <div className={styles.results} id={listId} role="listbox">
                  {search.kind === "loading" && <p className={styles.cardSub} role="status">Searching…</p>}
                  {search.kind === "error" && (
                    <p className={styles.error} role="alert">
                      {search.reason}{" "}
                      <button type="button" className={styles.linkButton} onClick={() => void runSearch(query.trim())}>Retry</button>
                    </p>
                  )}
                  {search.kind === "done" && results.length === 0 && <p className={styles.cardSub}>{NO_MATCH_COPY}</p>}
                  {results.map((client, i) => (
                    <div key={client.cedarRidgeUserId} role="option" aria-selected={i === highlight}
                      className={i === highlight ? `${styles.result} ${styles.resultActive}` : styles.result}
                      onMouseDown={(e) => { e.preventDefault(); pick(client); }} onMouseEnter={() => setHighlight(i)}>
                      <AcatClientResultRow client={client} />
                    </div>
                  ))}
                  {search.kind === "done" && search.hasMore && <p className={styles.cardSub}>{HAS_MORE_COPY}</p>}
                </div>
              )}
            </div>
          )}
          <label className={styles.label}>
            Apex Account #
            <input type="text" className={styles.input} value={account} disabled={saving}
              placeholder="Enter full account number" onChange={(e) => setAccount(e.target.value)} />
          </label>
          {needAck && (
            <label className={styles.checkOption}>
              <input type="checkbox" checked={acknowledged} disabled={saving}
                onChange={(e) => setAcknowledged(e.target.checked)} />
              <span>{MAPPING_ACK_COPY}</span>
            </label>
          )}
          <label className={styles.label}>
            Reason for this change
            <textarea className={styles.input} rows={3} maxLength={CLIENT_IDENTITY_REASON_MAX} value={reason}
              disabled={saving} onChange={(e) => setReason(e.target.value)} />
          </label>
          {!canVerify && (
            <div>
              <p role="status" className={styles.cardSub}>{directoryCopy}</p>
              {searched && (
                <button type="button" className={styles.linkButton} onClick={() => void runSearch(lastQuery.current)}>
                  Check directory again
                </button>
              )}
            </div>
          )}
          {!versionOk && <p role="alert" className={styles.error}>Refresh this record before linking its client.</p>}
          {error && (
            <p role="alert" className={styles.error}>
              {error.reason}
              {error.retryable && !conflict && (
                <> <button type="button" className={styles.linkButton} disabled={saving} onClick={() => void save()}>Retry</button></>
              )}
            </p>
          )}
        </div>
        <div className={styles.dialogFoot}>
          <button type="button" className={styles.secondaryButton} disabled={saving} onClick={() => onClose(conflict)}>
            {conflict ? "Close and refresh record" : "Cancel"}
          </button>
          <button type="button" className={styles.primaryButton} disabled={!canSave} onClick={() => void save()}>
            Save client link
          </button>
        </div>
      </div>
    </div>
  );
}
