"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { loadTransferHistory } from "@/app/(authenticated)/acat-tracking/history-actions";
import {
  HISTORY_TEXT,
  formatHistoryTime,
  historyHeadline,
  historyPerson,
  historyValue,
  showsChange,
  type HistoryEntry,
  type HistoryResult,
} from "@/lib/data/acat-history-view";
import styles from "./TransferHistorySection.module.css";

// Read-only History section for the open transfer (ticket), a port of the
// tracker's collapsed History section and RecordHistoryTab. There is no edit,
// delete, or restore control anywhere in this file.

export type HistoryState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; entries: HistoryEntry[] };

/** One load: loading first, then the answer. A stale answer is dropped. */
export async function runHistoryLoad(
  recordId: string,
  load: (recordId: string) => Promise<HistoryResult>,
  apply: (state: HistoryState) => void,
  isCurrent: () => boolean,
): Promise<void> {
  apply({ kind: "loading" });
  let next: HistoryState;
  try {
    const result = await load(recordId);
    next = result.ok ? { kind: "ready", entries: result.entries } : { kind: "error" };
  } catch {
    next = { kind: "error" };
  }
  if (isCurrent()) apply(next);
}

const svg = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

function HistoryIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...svg}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" />
    </svg>
  );
}
function ClockIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...svg}><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
  );
}
function SpinnerIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={styles.spin} {...svg}><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
  );
}
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" className={`${styles.chevron} ${open ? "" : styles.chevronClosed}`} {...svg}><path d="m6 9 6 6 6-6" /></svg>
  );
}

/** The three states and the list, exactly as the tracker's History shows them. */
export function HistoryPanel({ state, onRetry }: { state: HistoryState; onRetry: () => void }) {
  if (state.kind === "loading") {
    return <div className={styles.loading} role="status"><SpinnerIcon size={15} />{HISTORY_TEXT.loading}</div>;
  }
  if (state.kind === "error") {
    return (
      <div className={styles.error} role="alert">
        <p className={styles.errorTitle}>{HISTORY_TEXT.failure}</p>
        <button type="button" className={styles.retry} onClick={onRetry}>{HISTORY_TEXT.retry}</button>
      </div>
    );
  }
  if (state.entries.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyIcon}><HistoryIcon size={22} /></span>
        <p className={styles.emptyTitle}>{HISTORY_TEXT.empty}</p>
        <p className={styles.emptyHint}>{HISTORY_TEXT.emptyHint}</p>
      </div>
    );
  }
  return (
    <ol className={styles.list} aria-label={HISTORY_TEXT.listLabel}>
      {state.entries.map((entry) => (
        <li key={entry.id} className={styles.item}>
          <div className={styles.row}>
            <div className={styles.main}>
              <p className={styles.headline}>{historyHeadline(entry)}</p>
              {showsChange(entry) && (
                <p className={styles.change}>
                  <span className={styles.old}>{historyValue(entry.field, entry.oldValue)}</span>
                  <span className={styles.arrow}>→</span>
                  <span className={styles.new}>{historyValue(entry.field, entry.newValue)}</span>
                </p>
              )}
              <p className={styles.person}>{historyPerson(entry.performedBy)}</p>
            </div>
            <time dateTime={entry.timestamp} className={styles.time}>
              <ClockIcon size={10} />
              {formatHistoryTime(entry.timestamp)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

// Mounted only while the section is open, so a collapsed drawer makes no
// tracker call. A new `version` (the row's last activity) reloads, as the
// tracker's History re-reads after a save.
function HistoryLoader({ recordId, version }: { recordId: string; version: string }) {
  const [state, setState] = useState<HistoryState>({ kind: "loading" });
  const token = useRef(0);
  const load = useCallback(() => {
    const mine = ++token.current;
    void runHistoryLoad(recordId, loadTransferHistory, setState, () => token.current === mine);
  }, [recordId]);
  useEffect(() => {
    load();
    return () => { token.current += 1; };
  }, [load, version]);
  return <HistoryPanel state={state} onRetry={load} />;
}

/** The History section in the transfer drawer: collapsed until opened. */
export function TransferHistorySection({ recordId, version = "" }: { recordId: string; version?: string }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <section className={styles.section}>
      <button type="button" className={styles.head} aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}>
        <span className={styles.title}><span className={styles.icon}><HistoryIcon size={14} /></span>{HISTORY_TEXT.title}</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <div id={panelId} className={styles.body}>
          <HistoryLoader recordId={recordId} version={version} />
        </div>
      )}
    </section>
  );
}
