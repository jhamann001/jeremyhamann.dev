"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { applyExclusionBatch, loadAccountExclusions, loadClientExclusions } from "@/app/(authenticated)/trade-requests/new/actions";
import { Button, SectionLabel, TabPane, Tabs } from "@/components/ui";
import {
  EXCLUSIONS_COPY,
  EXCLUSION_KINDS,
  KIND_LABELS,
  KIND_REASON_PLACEHOLDERS,
  KIND_TICKER_PLACEHOLDERS,
  MAX_REASON_LENGTH,
  MAX_TICKER_LENGTH,
  NO_PENDING,
  addedByText,
  applyEnabled,
  applyLabel,
  batchFromPending,
  discardMessage,
  effectiveSides,
  formatRestrictionReason,
  pendingCount,
  savedSummary,
  sideChangeText,
  sideLocked,
  stagedAdd,
  withRemovalToggled,
  withSavedSideToggled,
  withStagedField,
  withStagedSide,
  type ExclusionKind,
  type PendingChanges,
  type StandingExclusion,
} from "@/lib/trade-requests/new-request-exclusions";
import styles from "./Exclusions.module.css";

export type ManageExclusionsEntity = { id: string; label: string; shortLabel: string };

type Rows = { status: "loading" } | { status: "loaded"; rows: StandingExclusion[]; error: string | null };

/**
 * The Manage exclusions dialog (client scope) and Manage Account Restrictions
 * dialog (account scope). Each tab is its own batch; unsaved changes are kept
 * per tab. onSavedChanges fires once, on close, when any Apply succeeded.
 * While an Apply is in flight the tabs and every close path are locked; an
 * Apply that resolves after the dialog was unmounted still reports its save.
 */
export function ManageExclusionsDialog({ scope, entities, onClose, onSavedChanges }: {
  scope: "client" | "account";
  entities: ManageExclusionsEntity[];
  onClose: () => void;
  onSavedChanges?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [activeId, setActiveId] = useState(entities[0]?.id ?? "");
  const [pendingById, setPendingById] = useState<Record<string, PendingChanges>>({});
  const [rows, setRows] = useState<Rows>({ status: "loading" });
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const saved = useRef(false);
  const reported = useRef(false);
  const mounted = useRef(true);
  const applyingRef = useRef(false);
  const activeIdRef = useRef<string | undefined>(undefined);
  const onSavedChangesRef = useRef(onSavedChanges);
  const loadSequence = useRef(0);
  const tempIds = useRef(0);
  const active = entities.find((entity) => entity.id === activeId) ?? entities[0];
  const activeEntityId = active?.id;
  const pending = (active && pendingById[active.id]) || NO_PENDING;
  const labels = useMemo(() => new Map(entities.map((entity) => [entity.id, entity.shortLabel])), [entities]);
  activeIdRef.current = activeEntityId;
  onSavedChangesRef.current = onSavedChanges;

  const reportSaved = useCallback(() => {
    if (!saved.current || reported.current) return;
    reported.current = true;
    try {
      onSavedChangesRef.current?.();
    } catch {
      // A failed refresh must not keep the dialog open.
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      reportSaved();
    };
  }, [reportSaved]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (!activeEntityId) return;
    const sequence = ++loadSequence.current;
    setRows({ status: "loading" });
    setLastSaved(null);
    setApplyError(null);
    const fallback = scope === "client" ? EXCLUSIONS_COPY.loadFailed : EXCLUSIONS_COPY.accountLoadFailedDialog;
    (scope === "client" ? loadClientExclusions([activeEntityId]) : loadAccountExclusions([activeEntityId]))
      .then((result) => {
        if (loadSequence.current !== sequence) return;
        setRows(result.ok
          ? { status: "loaded", rows: result.data[activeEntityId] ?? [], error: null }
          : { status: "loaded", rows: [], error: result.message || fallback });
      })
      .catch(() => {
        if (loadSequence.current === sequence) setRows({ status: "loaded", rows: [], error: fallback });
      });
  }, [activeEntityId, scope]);

  const mutate = useCallback((change: (current: PendingChanges) => PendingChanges) => {
    if (!activeEntityId) return;
    setPendingById((current) => ({ ...current, [activeEntityId]: change(current[activeEntityId] ?? NO_PENDING) }));
    setLastSaved(null);
  }, [activeEntityId]);

  const clearPending = useCallback((entityId: string) => {
    setPendingById((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== entityId)));
  }, []);

  const handleClose = useCallback(() => {
    if (applyingRef.current) return;
    const message = discardMessage(pendingById, labels);
    if (message && !window.confirm(message)) return;
    reportSaved();
    onClose();
  }, [pendingById, labels, reportSaved, onClose]);

  async function handleApply() {
    if (!active || applyingRef.current || !applyEnabled(pending, applying)) return;
    const entityId = active.id;
    const stillShowing = () => mounted.current && activeIdRef.current === entityId;
    applyingRef.current = true;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyExclusionBatch(scope, entityId, batchFromPending(pending));
      if (result.ok) {
        saved.current = true;
        if (!mounted.current) {
          reportSaved();
          return;
        }
        clearPending(entityId);
        if (stillShowing()) {
          setRows({ status: "loaded", rows: result.data.exclusions, error: null });
          setLastSaved(savedSummary(result.data));
        }
      } else if (stillShowing()) {
        setApplyError(result.message || EXCLUSIONS_COPY.applyFailed);
      }
    } catch {
      if (stillShowing()) setApplyError(EXCLUSIONS_COPY.applyFailed);
    } finally {
      applyingRef.current = false;
      if (mounted.current) setApplying(false);
    }
  }

  if (!active || typeof document === "undefined") return null;

  const editor = (
    <div className={styles.editor}>
      {rows.status === "loading" && <p className={styles.muted} role="status">{EXCLUSIONS_COPY.loading}</p>}
      {rows.status === "loaded" && rows.error && <div className={`${styles.message} ${styles.messageDanger}`} role="alert">{rows.error}</div>}
      {lastSaved && <div className={`${styles.message} ${styles.messageOk}`} role="status">{lastSaved}</div>}
      {applyError && <div className={`${styles.message} ${styles.messageDanger}`} role="alert">{applyError}</div>}
      {rows.status === "loaded" && EXCLUSION_KINDS.map((kind) => (
        <KindSection
          key={kind} kind={kind} rows={rows.rows.filter((row) => row.kind === kind)} pending={pending} disabled={applying}
          onAdd={() => mutate((current) => ({ ...current, adds: [...current.adds, stagedAdd(`staged-${++tempIds.current}`, kind)] }))}
          mutate={mutate}
        />
      ))}
    </div>
  );

  return createPortal(
    <dialog
      ref={ref} className={styles.dialog} aria-labelledby={titleId} data-testid="manage-exclusions-dialog"
      onCancel={(event) => {
        event.preventDefault();
        handleClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) handleClose();
      }}
    >
      <div className={styles.dialogPanel}>
        <header className={styles.dialogHeader}>
          <div>
            <h2 id={titleId} className={styles.dialogTitle}>
              {scope === "account" ? EXCLUSIONS_COPY.dialogAccount : EXCLUSIONS_COPY.dialogClient}
            </h2>
            {entities.length === 1 ? (
              <p className={styles.dialogSub}>for <span className={styles.dialogSubName}>{entities[0].shortLabel}</span></p>
            ) : (
              <p className={styles.dialogSub}>
                {scope === "account"
                  ? `${entities.length} accounts selected — each tab is its own batch`
                  : `${entities.length} clients in this household — each tab is its own batch`}
              </p>
            )}
          </div>
          <button type="button" className={styles.close} onClick={handleClose} disabled={applying} aria-label={EXCLUSIONS_COPY.closeDialog}>×</button>
        </header>
        <div className={styles.dialogBody}>
          {entities.length > 1 ? (
            <Tabs
              label={scope === "account" ? EXCLUSIONS_COPY.selectAccount : EXCLUSIONS_COPY.selectClient}
              tabs={entities.map((entity) => {
                const n = pendingCount(pendingById[entity.id]);
                return { id: entity.id, label: entity.label, badge: n > 0 ? <span className={styles.badge} title={`${n} unsaved`}>{n}</span> : undefined };
              })}
              activeId={active.id}
              disabled={applying}
              onActiveChange={(id) => {
                if (!applyingRef.current) setActiveId(id);
              }}
            >
              {entities.map((entity) => <TabPane key={entity.id} tabId={entity.id}>{entity.id === active.id ? editor : null}</TabPane>)}
            </Tabs>
          ) : editor}
        </div>
        <footer className={styles.dialogFooter}>
          {pendingCount(pending) > 0 && (
            <button type="button" className={styles.discard} onClick={() => { clearPending(active.id); setApplyError(null); }} disabled={applying}>
              ↺ Discard {pendingCount(pending)} pending
            </button>
          )}
          <div className={styles.footerActions}>
            <Button variant="ghost" onClick={handleClose} disabled={applying}>{EXCLUSIONS_COPY.close}</Button>
            <Button className={styles.apply} onClick={handleApply} disabled={!applyEnabled(pending, applying)} aria-busy={applying || undefined}>
              {applyLabel(pending)}
            </Button>
          </div>
        </footer>
      </div>
    </dialog>,
    document.body,
  );
}

function KindSection({ kind, rows, pending, disabled, onAdd, mutate }: {
  kind: ExclusionKind;
  rows: StandingExclusion[];
  pending: PendingChanges;
  disabled: boolean;
  onAdd: () => void;
  mutate: (change: (current: PendingChanges) => PendingChanges) => void;
}) {
  const adds = pending.adds.filter((add) => add.kind === kind);
  return (
    <section className={styles.kind} aria-label={KIND_LABELS[kind]}>
      <SectionLabel>{KIND_LABELS[kind]}</SectionLabel>
      {rows.length === 0 && adds.length === 0 && <p className={styles.empty}>{EXCLUSIONS_COPY.noStanding}</p>}
      {rows.length > 0 && (
        <ul className={styles.rows}>
          {rows.map((row) => {
            const removed = pending.removeIds.includes(row.id);
            const sides = effectiveSides(pending, row);
            const edited = !!pending.edits[row.id] && !removed;
            const reason = formatRestrictionReason(row.reason);
            const struck = removed ? styles.struck : "";
            return (
              <li key={row.id} className={`${styles.row} ${removed ? styles.rowRemoved : edited ? styles.rowEdited : ""}`.trim()}>
                <div className={styles.rowMain}>
                  <div className={styles.rowTitle}>
                    <span className={`${styles.ticker} ${struck}`.trim()}>{row.ticker}</span>
                    {reason && <span className={struck || undefined}>— {reason}</span>}
                  </div>
                  <div className={styles.rowMeta}>
                    {(["noBuy", "noSell"] as const).map((side) => (
                      <SideCheckbox
                        key={side} label={side === "noBuy" ? "DNB" : "DNS"} checked={sides[side]} disabled={disabled || removed}
                        locked={sideLocked(pending, row, side)}
                        ariaLabel={`${row.ticker}: ${side === "noBuy" ? "do not buy" : "do not sell"}`}
                        onToggle={() => mutate((current) => withSavedSideToggled(current, row, side))}
                      />
                    ))}
                    <p className={styles.rowNote}>
                      {removed ? EXCLUSIONS_COPY.markedForRemoval : edited ? sideChangeText(row, sides) : addedByText(row)}
                    </p>
                  </div>
                </div>
                <button
                  type="button" className={styles.icon} disabled={disabled}
                  aria-label={removed ? `Unmark ${row.ticker} for removal` : `Mark ${row.ticker} for removal`}
                  onClick={() => mutate((current) => withRemovalToggled(current, row.id))}
                >
                  {removed ? "↺" : "✕"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {adds.length > 0 && (
        <ul className={styles.rows}>
          {adds.map((add) => (
            <li key={add.tempId} className={styles.staged}>
              <input
                type="text" className={`${styles.input} ${styles.tickerInput}`} value={add.ticker} maxLength={MAX_TICKER_LENGTH} disabled={disabled}
                placeholder={KIND_TICKER_PLACEHOLDERS[kind]} aria-label={`Ticker for new ${kind} exclusion`}
                onChange={(event) => mutate((current) => withStagedField(current, add.tempId, "ticker", event.target.value))}
              />
              <input
                type="text" className={styles.input} value={add.reason} maxLength={MAX_REASON_LENGTH} disabled={disabled}
                placeholder={KIND_REASON_PLACEHOLDERS[kind]} aria-label={`Reason for new ${kind} exclusion`}
                onChange={(event) => mutate((current) => withStagedField(current, add.tempId, "reason", event.target.value))}
              />
              <div className={styles.stagedSides}>
                {(["noBuy", "noSell"] as const).map((side) => (
                  <SideCheckbox
                    key={side} label={side === "noBuy" ? "DNB" : "DNS"} checked={add[side]} disabled={disabled}
                    ariaLabel={`New ${kind} exclusion: ${side === "noBuy" ? "do not buy" : "do not sell"}`}
                    onToggle={() => mutate((current) => withStagedSide(current, add.tempId, side))}
                  />
                ))}
              </div>
              <button
                type="button" className={styles.icon} disabled={disabled} aria-label={`Discard staged ${kind} exclusion`}
                onClick={() => mutate((current) => ({ ...current, adds: current.adds.filter((entry) => entry.tempId !== add.tempId) }))}
              >
                ×
              </button>
              {!add.noBuy && !add.noSell && <p className={styles.stagedAlert} role="alert">{EXCLUSIONS_COPY.pickSide}</p>}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className={styles.addRow} onClick={onAdd} disabled={disabled}>+ {EXCLUSIONS_COPY.addRow}</button>
    </section>
  );
}

// A side that would leave neither DNB nor DNS ticked stays focusable but does not toggle.
function SideCheckbox({ label, checked, disabled, locked = false, ariaLabel, onToggle }: {
  label: string; checked: boolean; disabled: boolean; locked?: boolean; ariaLabel: string; onToggle: () => void;
}) {
  const className = disabled ? styles.sideDisabled : locked ? styles.sideLocked : "";
  return (
    <label className={`${styles.side} ${className}`.trim()} title={locked && !disabled ? EXCLUSIONS_COPY.keepBothSides : undefined}>
      <input
        type="checkbox" className={styles.checkbox} checked={checked} disabled={disabled} aria-label={ariaLabel}
        onChange={() => {
          if (!locked) onToggle();
        }}
      />
      {label}
    </label>
  );
}
