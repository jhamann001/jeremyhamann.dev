"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Pill } from "@/components/ui";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import {
  ACAT_BOOK_COLUMNS,
  ACAT_BOOK_EMPTY_MATCH,
  ACAT_BOOK_FILTERS,
  ACAT_BOOK_PREFS_KEY_PREFIX,
  ACAT_BOOK_REMOVED_EMPTY,
  ACAT_BOOK_REMOVED_LABEL,
  ACAT_COLUMNS_NO_MATCH,
  TRANSFER_TRACKER_COLUMNS,
  applyAcatBookFilter,
  bookGroup,
  filterTrackerColumns,
  loadAcatBookColumns,
  maskBookAccountForFee,
  parseAcatBookColumns,
  parseAcatBookPrefs,
  resetTrackerColumns,
  resolveAcatBookStatus,
  saveAcatBookColumns,
  toggleTrackerColumn,
  trackerCellText,
  type AcatBookColumn,
  type AcatBookDensity,
  type AcatBookFilter,
  type AcatBookPrefs,
  type AcatBookRow,
  type TransferTrackerColumn,
} from "@/lib/data/acat-book";
import { AcatUnlinkedDrawer } from "./AcatUnlinkedDrawer";
import { AcatRecordEditor } from "./AcatBookActions";
import { AcatNewTransferDialog } from "./AcatNewTransferDialog";
import { restoreAcatBookRecord } from "@/app/(authenticated)/acat-tracking/book-actions";
import { neighbours } from "@/lib/data/acat-drawer-contract";
import { AcatTransferDrawerShell } from "./AcatTransferDrawerShell";
import { AcatBookExportButton } from "./AcatBookExportButton";
import { TransferFeeSection, type TransferFeeRecord } from "./TransferFeeSection";
import { sameFeeSnapshot, type FeeSnapshot } from "@/lib/data/acat-fee-view";
import { TransferHistorySection } from "./TransferHistorySection";
import { AcatSecurityReconSection } from "./AcatSecurityReconSection";
import styles from "./AcatBookView.module.css";

export function BookRefreshButton({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button type="button" className={styles.action} disabled={pending}
      onClick={() => startTransition(() => router.refresh())}>
      {pending ? "Loading…" : children}
    </button>
  );
}

function accountText(row: AcatBookRow): string {
  return [row.apexAccountId, row.statementAccountNumber].filter(Boolean).join(" · ") || "—";
}

function cell(column: AcatBookColumn, row: AcatBookRow, transferId: string | null): ReactNode {
  switch (column) {
    case "client": return row.clientName ?? "—";
    case "account": return accountText(row);
    case "status": {
      const status = resolveAcatBookStatus(row.status);
      return <Pill hue={status.hue}>{status.label}</Pill>;
    }
    case "contra": return row.transferringContra ?? "—";
    case "direction": return row.direction ?? "—";
    case "type": return row.type ?? "—";
    case "date": return row.acatDate ?? "—";
    case "link": return transferId ? "Linked" : "Not linked";
  }
}

function trackerCell(column: TransferTrackerColumn, row: AcatBookRow, transferId: string | null): ReactNode {
  if (column === "link") return transferId ? "Linked" : "Not linked";
  if (column === "status") {
    const status = resolveAcatBookStatus(row.status);
    return <Pill hue={status.hue}>{status.label}</Pill>;
  }
  const text = trackerCellText(column, row);
  if (text === "—") return text;
  if (column === "direction") {
    const dir = (row.direction ?? "").toLowerCase();
    return <Pill tone={dir.startsWith("in") ? "green" : dir.startsWith("out") ? "red" : "gray"}>{text}</Pill>;
  }
  if (column === "reconStatus") {
    return <Pill tone={text === "Complete" ? "green" : text === "Needs Review" ? "red" : "gray"}>{text}</Pill>;
  }
  if (column === "issueCount" && text !== "0") return <Pill tone="red">{text}</Pill>;
  return text;
}

export function AcatBookColumnsList({ columns, query, onToggle }: {
  columns: readonly TransferTrackerColumn[];
  query: string;
  onToggle: (id: TransferTrackerColumn) => void;
}) {
  const matches = filterTrackerColumns(query);
  if (matches.length === 0) return <p className={styles.empty}>{ACAT_COLUMNS_NO_MATCH}</p>;
  return <>
    {matches.map((c) => (
      <label key={c.id} className={styles.columnOption}>
        <input type="checkbox" checked={columns.includes(c.id)} onChange={() => onToggle(c.id)} />
        <span>{c.label}</span>
        <span className={styles.columnType}>{c.type}</span>
      </label>
    ))}
  </>;
}

function recordString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function feeRecordOf(row: AcatBookRow): TransferFeeRecord {
  return {
    clientName: row.clientName, direction: row.direction, type: row.type, status: row.status,
    transferringContra: row.transferringContra, custodianName: row.custodianName,
    controlNumber: row.controlNumber, apexAccountId: maskBookAccountForFee(row.apexAccountId),
    custodianId: recordString(row.records?.custodianId), transferWorkflow: recordString(row.records?.transferWorkflow),
    cedarRidgeUserId: recordString(row.records?.cedarRidgeUserId),
  };
}

export function AcatBookView({ rows, linkedTransferIds, linkedByRecordId, userName, prefsScope, editsEnabled = false, dayToDayEnabled = false, columnsEnabled = false, removedRows = null, startCreating = false, initialRecordId = null, transferDrawer = null, feeEnabled = false, feeRequestsHref = null, feeReimbursement = false, feeRequestsRead = false, paperwork = false, historyEnabled = false, securityRecon = false }: {
  rows: AcatBookRow[];
  linkedTransferIds: Record<string, string>;
  linkedByRecordId: Record<string, string>;
  userName: string | null;
  prefsScope: string;
  editsEnabled?: boolean;
  dayToDayEnabled?: boolean;
  columnsEnabled?: boolean;
  removedRows?: AcatBookRow[] | null;
  startCreating?: boolean;
  initialRecordId?: string | null;
  transferDrawer?: { admin: boolean } | null;
  /** The fee release (book, edits, and both fee switches on), read on the server. */
  feeEnabled?: boolean;
  /** The Operations Tools fee-request route when this user may open it, decided on the server (ticket). */
  feeRequestsHref?: string | null;
  feeReimbursement?: boolean;
  /** Whether the fee section lists the Operations Tools requests on file for the open transfer, decided on the server. */
  feeRequestsRead?: boolean;
  paperwork?: boolean;
  historyEnabled?: boolean;
  securityRecon?: boolean;
}) {
  const storageKey = ACAT_BOOK_PREFS_KEY_PREFIX + prefsScope;
  const [filter, setFilter] = useState<AcatBookFilter>("all");
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState<AcatBookPrefs>(() => parseAcatBookPrefs(null));
  const [trackerColumns, setTrackerColumns] = useState<TransferTrackerColumn[]>(() => parseAcatBookColumns(null));
  const [columnQuery, setColumnQuery] = useState("");
  const [columnsOpen, setColumnsOpen] = useState(false);
  const columnMenuRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [openId, setOpenId] = useState<string | null>(() =>
    initialRecordId && rows.some((row) => row.id === initialRecordId) ? initialRecordId : null,
  );
  const [creating, setCreating] = useState(startCreating === true);
  const router = useRouter();
  const [saved, setSaved] = useState<Record<string, AcatBookRow>>({});
  const [links, setLinks] = useState<Record<string, string | null>>({});
  const [removedIds, setRemovedIds] = useState<Record<string, true>>({});
  // Stored fee last reported by the open transfer's fee section, keyed by record. It feeds only the Mark
  // Complete dialog and is cleared when the open record changes.
  const [feeSnapshots, setFeeSnapshots] = useState<Record<string, FeeSnapshot>>({});
  useEffect(() => { setFeeSnapshots({}); }, [openId]);
  const reportFee = useCallback((recordId: string, snapshot: FeeSnapshot) => {
    setFeeSnapshots((current) => (recordId in current && sameFeeSnapshot(current[recordId], snapshot) ? current : { ...current, [recordId]: snapshot }));
  }, []);

  useEffect(() => {
    setSaved({});
    setLinks({});
    setRemovedIds((prev) => Object.fromEntries(
      Object.keys(prev).filter((id) => rows.some((r) => r.id === id)).map((id) => [id, true as const]),
    ));
  }, [rows]);

  useEffect(() => {
    try { setPrefs(parseAcatBookPrefs(window.localStorage.getItem(storageKey))); } catch { /* storage unavailable */ }
  }, [storageKey]);

  useEffect(() => {
    try { setTrackerColumns(loadAcatBookColumns(window.localStorage, prefsScope)); } catch { /* storage unavailable */ }
  }, [prefsScope]);

  useEffect(() => {
    if (!columnsOpen) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node) || !columnMenuRef.current?.contains(target)) closeColumnMenu();
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") closeColumnMenu();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [columnsOpen]);

  function saveColumns(next: TransferTrackerColumn[]) {
    setTrackerColumns(next);
    try { saveAcatBookColumns(window.localStorage, prefsScope, next); } catch { /* storage unavailable */ }
  }

  function savePrefs(next: AcatBookPrefs) {
    setPrefs(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* storage unavailable */ }
  }

  function toggleColumn(id: AcatBookColumn) {
    const columns = prefs.columns.includes(id)
      ? prefs.columns.filter((c) => c !== id)
      : ACAT_BOOK_COLUMNS.map((c) => c.id).filter((c) => c === id || prefs.columns.includes(c));
    if (columns.length > 0) savePrefs({ ...prefs, columns });
  }

  const displayed = useMemo(
    () => rows.filter((r) => !removedIds[r.id]).map((r) => (saved[r.id] ? { ...saved[r.id], records: r.records } : r)),
    [rows, saved, removedIds],
  );
  const groups = useMemo(
    () => bookGroup(applyAcatBookFilter(displayed, filter, query, userName, dayToDayEnabled)),
    [displayed, filter, query, userName, dayToDayEnabled],
  );
  const orderedRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const orderedIds = useMemo(() => orderedRows.map((r) => r.id), [orderedRows]);
  const open = openId ? displayed.find((r) => r.id === openId) ?? null : null;
  const nav = open ? neighbours(orderedIds, open.id) : null;
  const shell = open && transferDrawer ? (
    <>
    <AcatTransferDrawerShell key={`shell:${open.id}`} row={open} admin={transferDrawer.admin} readOnly={!editsEnabled}
      paperwork={paperwork} feeSnapshot={feeSnapshots[open.id] ?? null}
      position={{ index: nav?.index ?? -1, total: orderedIds.length }}
      onPrevious={nav?.previous ? () => setOpenId(nav.previous) : null}
      onNext={nav?.next ? () => setOpenId(nav.next) : null}
      onClose={() => setOpenId(null)}
      onChanged={(savedRow) => setSaved((s) => ({ ...s, [savedRow.id]: savedRow }))}
      onRemoved={(gone) => { setRemovedIds((r) => ({ ...r, [gone.id]: true })); setOpenId(null); router.refresh(); }} />
    {securityRecon && <AcatSecurityReconSection key={`recon:${open.id}`} recordId={open.id} clientName={open.clientName ?? ""}
      controlNumber={open.controlNumber ?? ""} accountType={open.accountType ?? ""} type={open.type ?? ""} readOnly={!editsEnabled} />}
    </>
  ) : undefined;
  // Field history (ticket): one collapsed section per open transfer, keyed on the
  // record so another transfer never shows this one's history.
  const historySection = open && historyEnabled
    ? <TransferHistorySection key={`history:${open.id}`} recordId={open.id} version={open.lastActivityAt ?? ""} />
    : null;
  const transferIdFor = (row: AcatBookRow): string | null =>
    row.id in links
      ? links[row.id]
      : linkedByRecordId[row.id] ?? (row.acatTransferId ? linkedTransferIds[row.acatTransferId] : undefined) ?? null;
  const visibleColumns = ACAT_BOOK_COLUMNS.filter((c) => prefs.columns.includes(c.id));
  const tableColumns: ReadonlyArray<{ id: string; label: string }> = columnsEnabled
    ? TRANSFER_TRACKER_COLUMNS.filter((c) => trackerColumns.includes(c.id))
    : visibleColumns;
  const renderCell = (id: string, row: AcatBookRow, transferId: string | null): ReactNode => columnsEnabled
    ? trackerCell(id as TransferTrackerColumn, row, transferId)
    : cell(id as AcatBookColumn, row, transferId);

  function openOnKey(event: KeyboardEvent<HTMLTableRowElement>, row: AcatBookRow) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpenId(row.id);
    }
  }

  function closeColumnMenu() {
    setColumnsOpen(false);
  }

  return (
    <div className={styles.book}>
      <div className={styles.trackerLinkRow}>
        <a href={EXTERNAL_APPS.acatTracking} target="_blank" rel="noopener noreferrer" className={styles.trackerLink}>Open full tracker ↗</a>
      </div>

      <div className={styles.toolbar}>
        <div className={styles.filters} role="group" aria-label="Quick filters">
          {ACAT_BOOK_FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id}
              className={filter === f.id ? `${styles.filter} ${styles.filterOn}` : styles.filter}
              onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <input type="search" className={styles.search} placeholder="Search transfers" aria-label="Search transfers"
          value={query} onChange={(e) => setQuery(e.target.value)} />
        {dayToDayEnabled && (
          <button type="button" className={styles.action} onClick={() => setCreating(true)}>New transfer</button>
        )}
        {columnsEnabled && (
          <div className={styles.columnAnchor} ref={columnMenuRef}>
            <button type="button" className={styles.columnButton} aria-expanded={columnsOpen}
              onClick={() => setColumnsOpen((open) => !open)}>
              Columns <span className={styles.columnCount} data-count={trackerColumns.length}>{trackerColumns.length}</span>
            </button>
            <div className={styles.columnMenu} hidden={!columnsOpen}>
              <div className={styles.columnHead}>
                <input type="text" className={styles.search} placeholder="Search columns…" aria-label="Search columns"
                  value={columnQuery} onChange={(e) => setColumnQuery(e.target.value)} />
                <button type="button" className={styles.action} title="Reset to default columns"
                  onClick={() => saveColumns(resetTrackerColumns())}>Reset</button>
              </div>
              <div className={styles.columnList}>
                <AcatBookColumnsList columns={trackerColumns} query={columnQuery}
                  onToggle={(id) => saveColumns(toggleTrackerColumn(trackerColumns, id))} />
              </div>
            </div>
          </div>
        )}
        {columnsEnabled ? (
          <div className={styles.densityToggle} role="group" aria-label="View">
            <button type="button" aria-pressed={prefs.density !== "compact"}
              onClick={() => savePrefs({ ...prefs, density: "comfortable" })}>Comfortable</button>
            <button type="button" aria-pressed={prefs.density === "compact"}
              onClick={() => savePrefs({ ...prefs, density: "compact" })}>Compact</button>
          </div>
        ) : (
          <details className={styles.viewMenu}>
            <summary>View</summary>
            <fieldset className={styles.columns}>
              <legend>Columns</legend>
              {ACAT_BOOK_COLUMNS.map((c) => (
                <label key={c.id}>
                  <input type="checkbox" checked={prefs.columns.includes(c.id)} onChange={() => toggleColumn(c.id)} />
                  {c.label}
                </label>
              ))}
            </fieldset>
            <label className={styles.density}>
              Density
              <select value={prefs.density} onChange={(e) => savePrefs({ ...prefs, density: e.target.value as AcatBookDensity })}>
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </label>
          </details>
        )}
        {transferDrawer && <AcatBookExportButton rows={orderedRows} columns={tableColumns} tracker={columnsEnabled}
          linkedFor={(row) => transferIdFor(row) !== null} />}
      </div>

      {creating && dayToDayEnabled && (
        <AcatNewTransferDialog onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); router.refresh(); }} />
      )}

      {groups.length === 0 ? (
        <p role="status" className={styles.empty}>{ACAT_BOOK_EMPTY_MATCH}</p>
      ) : groups.map((group) => {
        const isOpen = expanded[group.label] ?? !group.collapsedByDefault;
        return (
          <section key={group.label} className={styles.group}>
            <button type="button" className={styles.groupHead} aria-expanded={isOpen}
              onClick={() => setExpanded((prev) => ({ ...prev, [group.label]: !isOpen }))}>
              <span className={styles.chevron} aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
              <Pill hue={group.hue}>{group.label}</Pill>
              <span className={styles.count}>{group.count}</span>
            </button>
            {isOpen && (
              <table className={prefs.density === "compact" ? `${styles.table} ${styles.compact}` : styles.table}>
                <thead>
                  <tr>{tableColumns.map((c) => <th key={c.id} scope="col">{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => {
                    const transferId = transferIdFor(row);
                    return (
                      <tr key={row.id} tabIndex={0} className={styles.row}
                        onClick={() => setOpenId(row.id)} onKeyDown={(e) => openOnKey(e, row)}>
                        {tableColumns.map((c) => <td key={c.id}>{renderCell(c.id, row, transferId)}</td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      <div className={styles.trackerLinkRow}>
        {removedRows === null
          ? <Link href="/acat-tracking?removed=1" prefetch={false} scroll={false} className={styles.action}>Show removed transfers</Link>
          : <Link href="/acat-tracking" prefetch={false} scroll={false} className={styles.action}>Hide removed transfers</Link>}
      </div>
      {removedRows !== null && <AcatBookRemoved rows={removedRows} editsEnabled={editsEnabled} />}

      {open && (editsEnabled ? (
        <AcatUnlinkedDrawer
          row={open}
          transferId={transferIdFor(open)}
          trackerShell={shell}
          historySection={historySection}
          feeSection={feeEnabled ? <TransferFeeSection key={`fee:${open.id}`} recordId={open.id} record={feeRecordOf(open)} refreshToken={saved[open.id]?.lastActivityAt ?? ""} feeRequestsHref={feeRequestsHref} reimbursement={feeReimbursement} requestsOnFile={feeRequestsRead}
            onFeeChanged={(snapshot) => reportFee(open.id, snapshot)} /> : undefined}
          editor={shell ? undefined : <AcatRecordEditor key={`${open.id}:${open.feeCharged ?? ""}:${open.feeRequestCompleted ?? ""}`} row={open} dayToDay={dayToDayEnabled}
            onSaved={(row) => setSaved((s) => ({ ...s, [row.id]: row }))} />}
          onLinked={(transferId) => setLinks((l) => ({ ...l, [open.id]: transferId }))}
          onUnlinked={() => setLinks((l) => ({ ...l, [open.id]: null }))}
          onClose={() => setOpenId(null)}
        />
      ) : (
        <AcatUnlinkedDrawer
          row={open}
          transferId={transferIdFor(open)}
          readOnly
          trackerShell={shell}
          historySection={historySection}
          dayToDayText={dayToDayEnabled && !shell ? {
            notes: open.notes ?? "",
            tradeInstructions: open.tradeInstructions ?? "",
            loadError: open.textLoadError,
          } : null}
          onClose={() => setOpenId(null)}
          onUnlinked={() => setOpenId(null)}
        />
      ))}
    </div>
  );
}

// Removed rows never join the live groups; restore sends them back through the
// tracker and the next render shows them in the live book.
export function AcatBookRemoved({ rows, editsEnabled }: { rows: AcatBookRow[]; editsEnabled: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [restored, setRestored] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const visible = rows.filter((r) => !restored[r.id]);

  function restore(row: AcatBookRow) {
    setError(null);
    startTransition(async () => {
      const result = await restoreAcatBookRecord(row);
      if (!result.ok) { setError(result.reason); return; }
      setRestored((s) => ({ ...s, [row.id]: true }));
      router.refresh();
    });
  }

  return (
    <section className={styles.group} aria-label={ACAT_BOOK_REMOVED_LABEL}>
      <div className={styles.groupHead}>
        <Pill hue="gray">{ACAT_BOOK_REMOVED_LABEL}</Pill>
        <span className={styles.count}>{visible.length}</span>
      </div>
      {error && <p role="alert" className={styles.empty}>{error}</p>}
      {visible.length === 0 ? (
        <p role="status" className={styles.empty}>{ACAT_BOOK_REMOVED_EMPTY}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Client</th><th scope="col">Account</th><th scope="col">Status</th><th scope="col">Removed</th>
              {editsEnabled && <th scope="col">Action</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const status = resolveAcatBookStatus(row.status);
              return (
                <tr key={row.id}>
                  <td>{row.clientName ?? "—"}</td>
                  <td>{accountText(row)}</td>
                  <td><Pill hue={status.hue}>{status.label}</Pill></td>
                  <td>{row.removedAt ? row.removedAt.slice(0, 10) : "—"}</td>
                  {editsEnabled && (
                    <td>
                      <button type="button" className={styles.action} disabled={pending} onClick={() => restore(row)}>
                        {pending ? "Restoring…" : "Restore"}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
