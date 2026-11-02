"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { loadAdvisorTransfers } from "@/app/(authenticated)/client-transfers/actions";
import {
  advisorStatusLabel,
  countAdvisorTransfers,
  filterAdvisorTransfers,
  formatAdvisorDate,
  formatAdvisorValue,
  isAdvisorTerminal,
  type AdvisorTransferRow,
  type AdvisorTransferSet,
} from "@/lib/transfers/advisor-transfer-status";
import { ChevronDown, ChevronRight, LoaderCircle, RefreshCw, Search } from "./advisor-transfer-icons";
import styles from "./AdvisorTransferList.module.css";

// Client Transfers (ticket): a port of the tracker's advisor page list
// (tracker 25555c2 src/components/AdvisorTransfersView.tsx). Read-only: there is no
// edit, delete, fee or drawer action. It only ever receives the whitelisted
// columns the tracker's advisor redaction exposes.
//
// Deliberate deviation: the tracker polls every 60 s and revalidates on focus.
// Here rows refresh on navigation and on Refresh or Retry.

export type AdvisorTransferInitial = { ok: true; rows: AdvisorTransferRow[] } | { ok: false };
type Phase = "ready" | "failed" | "denied";

export function AdvisorTransferList({ initial }: { initial: AdvisorTransferInitial }) {
  const [rows, setRows] = useState<AdvisorTransferRow[]>(initial.ok ? initial.rows : []);
  const [phase, setPhase] = useState<Phase>(initial.ok ? "ready" : "failed");
  const [knownAllowed, setKnownAllowed] = useState(initial.ok);
  const [loading, setLoading] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [set, setSet] = useState<AdvisorTransferSet>("active");
  // A result applies only if it belongs to the most recently started load, so a
  // slower older load never replaces newer rows.
  const latest = useRef(0);

  const load = useCallback(async (manual: boolean) => {
    const id = ++latest.current;
    setLoading(true);
    let result: Awaited<ReturnType<typeof loadAdvisorTransfers>>;
    try {
      result = await loadAdvisorTransfers();
    } catch {
      result = { ok: false, reason: "unavailable" };
    }
    if (id !== latest.current) return;
    setLoading(false);
    if (result.ok) {
      setRows(result.rows);
      setPhase("ready");
      setKnownAllowed(true);
      if (manual) setLastRefreshedAt(Date.now());
    } else if (result.reason === "not_allowed") {
      setRows([]);
      setPhase("denied");
      setKnownAllowed(false);
    } else {
      setPhase("failed");
    }
  }, []);

  const filtered = useMemo(() => filterAdvisorTransfers(rows, query, set), [rows, query, set]);
  const summary = useMemo(() => countAdvisorTransfers(rows), [rows]);

  if (phase === "denied") {
    return (
      <div className={styles.root}>
        <header className={styles.header}>
          <h1 className={styles.title}>Client Transfers</h1>
        </header>
        <p className={styles.denied}>This list isn’t available to your account.</p>
      </div>
    );
  }

  const showControls = knownAllowed;

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <div>
            <h1 className={styles.title}>Client Transfers</h1>
            {showControls && (
              <p className={styles.subtitle}>
                Read-only view of ACAT transfers. Account numbers, fees, and internal notes aren’t shown.
              </p>
            )}
          </div>
          {showControls && (
            <div className={styles.meta}>
              <span><strong>{summary.active}</strong> active</span>
              <span>·</span>
              <span><strong>{summary.completed}</strong> completed</span>
              {lastRefreshedAt && (
                <>
                  <span>·</span>
                  <span role="status" title={formatAdvisorDate(new Date(lastRefreshedAt))}>
                    refreshed {timeAgo(lastRefreshedAt)}
                  </span>
                </>
              )}
              <button
                type="button"
                className={styles.refresh}
                aria-label="Refresh"
                title="Refresh"
                aria-busy={loading}
                onClick={() => void load(true)}
              >
                <RefreshCw size={14} className={loading ? styles.spin : undefined} />
              </button>
            </div>
          )}
        </div>

        {showControls && (
          <div className={styles.controls}>
            <div className={styles.searchWrap}>
              <Search size={14} className={styles.searchIcon} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by client, contra, or advisor"
                aria-label="Search transfers"
                className={styles.search}
              />
            </div>
            <div className={styles.segment} role="group" aria-label="Transfer status">
              <FilterPill label="Active" active={set === "active"} onClick={() => setSet("active")} />
              <FilterPill label="Completed" active={set === "completed"} onClick={() => setSet("completed")} />
              <FilterPill label="All" active={set === "all"} onClick={() => setSet("all")} />
            </div>
          </div>
        )}
      </header>

      <div className={styles.body}>
        {phase === "failed" ? (
          <div role="alert" className={styles.error}>
            <span>Couldn’t load transfers.</span>
            <button type="button" className={styles.retry} aria-busy={loading} onClick={() => void load(false)}>
              Retry
            </button>
          </div>
        ) : loading && rows.length === 0 ? (
          <div className={styles.loading}>
            <LoaderCircle size={14} className={styles.spin} />
            Loading transfers…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState isFilteredQuery={Boolean(query) || set !== "all"} />
        ) : (
          <ul className={styles.list}>
            {filtered.map((row) => (
              <TransferRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={active ? `${styles.pill} ${styles.pillActive}` : styles.pill}
    >
      {label}
    </button>
  );
}

function TransferRow({ row }: { row: AdvisorTransferRow }) {
  const [expanded, setExpanded] = useState(false);
  const terminal = isAdvisorTerminal(row.status);
  const value = typeof row.statementAmount === "number" ? formatAdvisorValue(row.statementAmount) : "—";
  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        className={styles.row}
      >
        <span className={styles.chevron}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <span className={styles.client}>{row.clientName}</span>
        <span className={styles.contra}>{row.transferringContra ?? "—"}</span>
        <span className={styles.kind}>
          {row.direction ?? "—"}
          {row.type ? ` · ${row.type}` : ""}
        </span>
        <span className={styles.value}>{value}</span>
        <span
          className={terminal ? `${styles.badge} ${styles.badgeTerminal}` : `${styles.badge} ${styles.badgeActive}`}
          title={advisorStatusLabel(row.status)}
          data-hue={terminal ? "terminal" : "active"}
        >
          {advisorStatusLabel(row.status)}
        </span>
      </button>
      {expanded && <TransferDetail row={row} />}
    </li>
  );
}

function TransferDetail({ row }: { row: AdvisorTransferRow }) {
  return (
    <div className={styles.detail}>
      <dl className={styles.detailGrid}>
        <DetailField label="Client" value={row.clientName} />
        <DetailField label="Transferring contra" value={row.transferringContra} />
        <DetailField label="Wealth advisor" value={row.wealthAdvisor} />
        <DetailField label="Direction" value={row.direction} />
        <DetailField label="Type" value={row.type} />
        <DetailField label="Account type" value={row.accountType} />
        <DetailField label="Original client request" value={formatAdvisorDate(row.originalClientRequestDate) || null} />
        <DetailField label="Submitted to Apex" value={formatAdvisorDate(row.opsSubmissionDateToApex) || null} />
        <DetailField label="Apex completion" value={formatAdvisorDate(row.apexCompletionDate) || "—"} />
        <DetailField
          label="Expected value"
          value={typeof row.statementAmount === "number" ? formatAdvisorValue(row.statementAmount) : null}
        />
        {row.custodian && (
          <DetailField
            label="Custodian SLA"
            value={`${row.custodian.name} · ~${row.custodian.avgProcessingDays} business days`}
          />
        )}
        {row.additionalResources && <AdditionalResourcesField value={row.additionalResources} />}
      </dl>
    </div>
  );
}

// Free text, by convention a CRM task URL: link a bare http(s) URL, render
// anything else as plain text.
function AdditionalResourcesField({ value }: { value: string }) {
  const trimmed = value.trim();
  const isBareUrl = /^https?:\/\/\S+$/.test(trimmed);
  return (
    <div className={styles.field}>
      <dt className={styles.fieldLabel}>Additional resources</dt>
      <dd className={styles.fieldValue}>
        {isBareUrl ? (
          <a href={trimmed} target="_blank" rel="noopener noreferrer" className={styles.link}>
            Open CRM task
          </a>
        ) : (
          trimmed
        )}
      </dd>
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className={styles.field}>
      <dt className={styles.fieldLabel}>{label}</dt>
      <dd className={styles.fieldValue}>{value || "—"}</dd>
    </div>
  );
}

function EmptyState({ isFilteredQuery }: { isFilteredQuery: boolean }) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>
        {isFilteredQuery ? "No transfers match your filters." : "No transfers yet."}
      </p>
      <p className={styles.emptyHint}>
        {isFilteredQuery
          ? "Try a different search or switch the status filter."
          : "Once a client transfer is opened it will appear here."}
      </p>
    </div>
  );
}

function timeAgo(timestamp: number): string {
  const seconds = Math.round(Math.max(0, Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
