"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Pill } from "@/components/ui";
import {
  changeTransferStatus,
  completeTransfer,
  deleteTransfer,
  loadTransferDrawer,
  rejectTransfer,
  saveTransferText,
} from "@/app/(authenticated)/acat-tracking/transfer-drawer-actions";
import { resolveAcatBookStatus, type AcatBookRow } from "@/lib/data/acat-book";
import { bookRowFromSaved } from "@/lib/data/acat-book-edit";
import {
  ACAT_DRAWER_LOAD_FAILURE,
  ACAT_WRITE_UNAVAILABLE,
  TERMINAL_STATUSES,
  drawerStats,
  drawerStatusOptions,
  finalizeFeeLabel,
  finalizeReconLabel,
  formatDrawerDate,
  type DrawerTransfer,
} from "@/lib/data/acat-drawer-contract";
import type { FeeSnapshot } from "@/lib/data/acat-fee-view";
import { AcatClientReplaceDialog } from "./AcatClientReplaceDialog";
import { AcatTransferDetails } from "./AcatTransferDetails";
import { DeleteDialog, FinalizeDialog, type FinalizeValues } from "./AcatTransferModals";
import { useInlineEdit } from "./useInlineEdit";
import { DemoRecordLink } from "@/components/demo/DemoRecordLink";
import { otherDemoLinks } from "@/lib/demo/links";
import { demoMode } from "@/lib/demo/mode";
import styles from "./AcatTransferDrawer.module.css";

// Loaded only when the paperwork release is on, so a closed release adds no code or imports to the drawer.
const AcatPaperworkSection = dynamic(() => import("./AcatPaperworkSection").then((module) => module.AcatPaperworkSection), { ssr: false });

type LoadState = { kind: "loading" } | { kind: "failed"; reason: string } | { kind: "loaded" };
type Alert = { reason: string; retry: () => void } | null;

const TYPING_TARGET = "input, textarea, select, [contenteditable='true'], [contenteditable='']";

function linkedCount(value: string | number | boolean | null | undefined): number {
  return typeof value === "string" ? value.split(",").filter((id) => id.trim() !== "").length : 0;
}

export function AcatTransferDrawerShell({
  row, admin, readOnly, position, onPrevious, onNext, onClose, onChanged, onRemoved,
  paperwork = false, feeSnapshot = null,
}: {
  row: AcatBookRow;
  admin: boolean;
  readOnly: boolean;
  position: { index: number; total: number };
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onClose: () => void;
  onChanged: (row: AcatBookRow) => void;
  onRemoved: (row: AcatBookRow) => void;
  paperwork?: boolean;
  /** The stored fee last reported by the fee section; null uses this drawer's own loaded copy. */
  feeSnapshot?: FeeSnapshot | null;
}) {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [transfer, setTransfer] = useState<DrawerTransfer | null>(null);
  const [alert, setAlert] = useState<Alert>(null);
  const [now] = useState(() => Date.now());
  const [finalizing, setFinalizing] = useState<"Completed" | "Rejected" | null>(null);
  const [finalizeState, setFinalizeState] = useState<{ saving: boolean; error: string | null }>({ saving: false, error: null });
  const [deleting, setDeleting] = useState(false);
  const [deleteState, setDeleteState] = useState<{ saving: boolean; error: string | null }>({ saving: false, error: null });
  const [clientDialog, setClientDialog] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const request = useRef(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const handlers = useRef({ onPrevious, onNext });
  useEffect(() => { handlers.current = { onPrevious, onNext }; }, [onPrevious, onNext]);

  const fetchStored = useCallback(async (): Promise<DrawerTransfer | null> => {
    const current = ++request.current;
    setLoad({ kind: "loading" });
    try {
      const result = await loadTransferDrawer(row.id);
      if (request.current !== current) return null;
      if (!result.ok) { setLoad({ kind: "failed", reason: result.reason }); return null; }
      setTransfer(result.transfer);
      setLoad({ kind: "loaded" });
      return result.transfer;
    } catch {
      if (request.current === current) setLoad({ kind: "failed", reason: ACAT_DRAWER_LOAD_FAILURE });
      return null;
    }
  }, [row.id]);

  useEffect(() => {
    void fetchStored();
    return () => { request.current += 1; };
  }, [fetchStored]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(TYPING_TARGET) || target?.closest("[data-acat-dialog]")) return;
      const go = event.key === "ArrowLeft" ? handlers.current.onPrevious : handlers.current.onNext;
      if (go) { event.preventDefault(); go(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const accept = useCallback((next: DrawerTransfer): boolean => {
    const saved = bookRowFromSaved(next, row, new Date().toISOString());
    if (!saved) {
      setAlert({
        reason: ACAT_WRITE_UNAVAILABLE,
        retry: () => {
          void fetchStored().then((stored) => {
            const confirmed = stored ? bookRowFromSaved(stored, row, new Date().toISOString()) : null;
            if (confirmed) { setAlert(null); onChanged(confirmed); }
          });
        },
      });
      return false;
    }
    setTransfer(next);
    setAlert(null);
    onChanged(saved);
    router.refresh();
    return true;
  }, [fetchStored, onChanged, router, row]);

  const notes = useInlineEdit({
    onSave: async (_field, value) => {
      setNotesError(null);
      try {
        const result = await saveTransferText(row.id, "notes", value);
        if (!result.ok) { setNotesError(result.reason); return false; }
        return accept(result.transfer);
      } catch {
        setNotesError(ACAT_WRITE_UNAVAILABLE);
        return false;
      }
    },
  });

  function changeStatus(status: string) {
    if (!transfer || status === transfer.status) return;
    if (status === "Completed" || status === "Rejected") {
      setFinalizeState({ saving: false, error: null });
      setFinalizing(status);
      return;
    }
    const run = async () => {
      setAlert(null);
      try {
        const result = await changeTransferStatus(row.id, status);
        if (!result.ok) { setAlert({ reason: result.reason, retry: () => void run() }); return; }
        accept(result.transfer);
      } catch {
        setAlert({ reason: ACAT_WRITE_UNAVAILABLE, retry: () => void run() });
      }
    };
    void run();
  }

  async function finalize(values: FinalizeValues) {
    if (!finalizing) return;
    setFinalizeState({ saving: true, error: null });
    try {
      const result = finalizing === "Completed"
        ? await completeTransfer(row.id, { apexCompletionDate: values.apexCompletionDate, controlNumber: values.controlNumber })
        : await rejectTransfer(row.id, values.rejectionReason);
      if (!result.ok) { setFinalizeState({ saving: false, error: result.reason }); return; }
      accept(result.transfer);
      setFinalizing(null);
      setFinalizeState({ saving: false, error: null });
    } catch {
      setFinalizeState({ saving: false, error: ACAT_WRITE_UNAVAILABLE });
    }
  }

  async function remove(reason: string) {
    setDeleteState({ saving: true, error: null });
    try {
      const result = await deleteTransfer(row.id, reason);
      if (!result.ok) { setDeleteState({ saving: false, error: result.reason }); return; }
      onRemoved(row);
    } catch {
      setDeleteState({ saving: false, error: ACAT_WRITE_UNAVAILABLE });
    }
  }

  const bar = (
    <div className={styles.bar}>
      <button type="button" className={styles.barButton} aria-label="Previous record" title="Previous record (←)"
        disabled={!onPrevious} onClick={() => onPrevious?.()}>‹</button>
      <button type="button" className={styles.barButton} aria-label="Next record" title="Next record (→)"
        disabled={!onNext} onClick={() => onNext?.()}>›</button>
      {position.index >= 0 && <span className={styles.position}>{position.index + 1} of {position.total}</span>}
      <span className={styles.spacer} />
      <button ref={closeButton} type="button" className={styles.barButton} aria-label="Close" title="Close (Esc)"
        onClick={onClose}>✕</button>
    </div>
  );

  if (load.kind === "loading" && !transfer) {
    return (
      <div className={styles.shell} data-testid="acat-transfer-shell">
        {bar}
        <p role="status" className={styles.note}>Loading transfer…</p>
      </div>
    );
  }
  if (load.kind === "failed" && !transfer) {
    return (
      <div className={styles.shell} data-testid="acat-transfer-shell">
        {bar}
        <div role="alert" className={styles.failure}>
          <p>{ACAT_DRAWER_LOAD_FAILURE}</p>
          <button type="button" className={styles.primaryButton} onClick={() => void fetchStored()}>Retry</button>
        </div>
      </div>
    );
  }
  if (!transfer) return null;

  const stats = drawerStats(transfer, now);
  const status = transfer.status ?? "";
  const terminal = TERMINAL_STATUSES.has(status);
  const name = transfer.clientName ?? row.clientName ?? "—";
  const linked = linkedCount(row.records?.cedarRidgeUserIds);
  const needsLink = row.records?.needsClientLink === true;
  const statusMeta = resolveAcatBookStatus(status);
  const editingNotes = notes.editingField === "notes";
  const noteText = transfer.notes ?? "";

  return (
    <div className={styles.shell} data-testid="acat-transfer-shell">
      {bar}
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <h2 className={styles.clientName}>
            {readOnly ? name : (
              <button type="button" className={styles.clientButton} aria-label="Review client link"
                onClick={() => setClientDialog(true)}>{name}</button>
            )}
          </h2>
          <p className={styles.subtitle}>
            {needsLink ? "Needs client link" : linked > 0 ? `${linked} linked` : "Linked"}
            {!readOnly && (
              <> <button type="button" className={styles.linkButton} onClick={() => setClientDialog(true)}>
                {needsLink ? "Link client" : "Review link"}
              </button></>
            )}
          </p>
          <p className={styles.subtitle}>
            Record {transfer.id}
            {transfer.wealthAdvisor ? ` | ${transfer.wealthAdvisor}` : ""}
            {` | Updated ${formatDrawerDate(row.lastActivityAt)}`}
            {demoMode() && <> | <DemoRecordLink href={otherDemoLinks.trackerRecord(transfer.id)} demo="Transfer Tracker" /></>}
          </p>
          <p className={styles.hint}>Fields with a pencil can be edited and save automatically</p>
        </div>
        <div className={styles.actions}>
          {!terminal && !readOnly && (
            <button type="button" className={styles.markComplete}
              onClick={() => { setFinalizeState({ saving: false, error: null }); setFinalizing("Completed"); }}>
              Mark Complete
            </button>
          )}
          {admin && !readOnly && (
            <button type="button" className={styles.deleteButton} aria-label="Delete ACAT record" title="Delete ACAT record"
              onClick={() => { setDeleteState({ saving: false, error: null }); setDeleting(true); }}>
              Delete
            </button>
          )}
        </div>
      </div>

      <div className={styles.props}>
        {transfer.controlNumber && <span className={styles.propPill}>Control #: <strong>{transfer.controlNumber}</strong></span>}
        <span className={styles.propPill}>Apex Acct: <strong>{transfer.apexAccountId ?? ""}</strong></span>
        <span className={styles.propPill}>Contra: <strong>{transfer.transferringContra ?? ""}</strong></span>
        {transfer.direction && <span className={styles.propPill}>Direction: <strong>{transfer.direction}</strong></span>}
        <span className={styles.propPill}>Date: <strong>{formatDrawerDate(transfer.acatDate)}</strong></span>
        <select aria-label="Status" className={styles.statusSelect} value={status} disabled={readOnly}
          onChange={(e) => changeStatus(e.target.value)}>
          {drawerStatusOptions(transfer.status).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {status === "Completed" || status === "Rejected"
          ? <span className={status === "Completed" ? styles.statusCompleted : styles.statusRejected}
            data-hue={status === "Completed" ? "completed" : "rejected"}>{statusMeta.label}</span>
          : <Pill hue={statusMeta.hue}>{statusMeta.label}</Pill>}
      </div>

      {alert && (
        <p role="alert" className={styles.error}>
          {alert.reason}{" "}
          <button type="button" className={styles.linkButton} onClick={alert.retry}>Retry</button>
        </p>
      )}

      <div className={styles.stats}>
        <div className={styles.stat} data-color="blue" data-stat="total">
          <span className={styles.statLabel}>Total Assets</span><span className={styles.statValue}>{stats.totalAssets}</span>
        </div>
        <div className={styles.stat} data-color="green" data-stat="matched">
          <span className={styles.statLabel}>Matched</span><span className={styles.statValue}>{stats.matched}</span>
        </div>
        <div className={styles.stat} data-color={stats.issues > 0 ? "red" : "green"} data-stat="issues">
          <span className={styles.statLabel}>Issues</span><span className={styles.statValue}>{stats.issues}</span>
        </div>
        <div className={styles.stat} data-color={stats.daysSince !== null && stats.daysSince > 7 ? "amber" : "blue"} data-stat="days">
          <span className={styles.statLabel}>Days Since Init</span>
          <span className={styles.statValue}>{stats.daysSince === null ? "—" : stats.daysSince}</span>
        </div>
      </div>

      {editingNotes ? (
        <div className={styles.notesEdit}>
          <textarea {...notes.bind("notes")} aria-label="Notes" className={styles.input} rows={2} value={notes.editValue}
            onChange={(e) => notes.change(e.target.value)} />
          <p className={styles.hint}>
            {notes.status === "saving" ? "Saving…" : "Click outside or press Esc to cancel"}
          </p>
        </div>
      ) : noteText !== "" ? (
        readOnly ? <p className={styles.notesBanner}>{noteText}</p> : (
          <div role="button" tabIndex={0} aria-label="Edit notes" className={styles.notesBanner}
            onClick={() => { setNotesError(null); notes.start("notes", noteText); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setNotesError(null); notes.start("notes", noteText); } }}>
            <p>{noteText}</p><span className={styles.pencil} aria-hidden="true">✎</span>
          </div>
        )
      ) : !readOnly && (
        <button type="button" className={styles.linkButton} onClick={() => { setNotesError(null); notes.start("notes", ""); }}>
          + Add notes
        </button>
      )}
      {notesError && <p role="alert" className={styles.error}>{notesError}</p>}

      <AcatTransferDetails transfer={transfer} readOnly={readOnly} onStored={accept} />
      {paperwork && <AcatPaperworkSection key={`paperwork:${transfer.id}`} recordId={transfer.id} readOnly={readOnly} />}

      {finalizing && (
        <FinalizeDialog key={finalizing} mode={finalizing} name={name}
          initial={{
            apexCompletionDate: transfer.apexCompletionDate ?? "",
            controlNumber: transfer.controlNumber ?? "",
            rejectionReason: transfer.rejectionReason ?? "",
          }}
          reconLabel={finalizeReconLabel(String(row.records?.reconStatus ?? ""))}
          feeLabel={finalizeFeeLabel(feeSnapshot ?? transfer)}
          saving={finalizeState.saving} error={finalizeState.error}
          onCancel={() => setFinalizing(null)} onConfirm={(values) => void finalize(values)} />
      )}
      {deleting && (
        <DeleteDialog recordId={transfer.id} name={name} saving={deleteState.saving} error={deleteState.error}
          onCancel={() => setDeleting(false)} onConfirm={(reason) => void remove(reason)} />
      )}
      {clientDialog && (
        <AcatClientReplaceDialog key={`replace:${transfer.id}`} transfer={transfer} linkedIds={row.records?.cedarRidgeUserIds}
          onSaved={accept}
          onClose={(refresh) => { setClientDialog(false); if (refresh) void fetchStored(); }} />
      )}
    </div>
  );
}
