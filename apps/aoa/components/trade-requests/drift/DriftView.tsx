"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { exportDriftExclusions } from "@/app/(authenticated)/trade-requests/drift/actions";
import { Button, PageHeader } from "@/components/ui";
import { TradeRequestsSessionEnded } from "@/components/trade-requests/queue/SessionEndedNotice";
import { TRADE_REQUESTS_COPY } from "@/lib/trade-requests/copy";
import type { AccountDriftHistoryRow, AccountDriftRunRow, CostBasisFreshnessSummary, DriftOverrideReason } from "@/lib/trade-requests/shared-types";
import {
  DRIFT_COPY, DriftRequestError, clearDriftOverride, fetchAccountDriftAllowList, fetchAccountDriftExclusionOverlap,
  fetchAccountDriftExclusionOverlapAvailability, fetchAccountDriftHistory, fetchAccountDriftRun, setDriftOverride,
  type DriftAllowListResponse, type ExclusionOverlapResponse,
} from "@/lib/trade-requests/drift-view/api";
import {
  DAY_OPTIONS, DEFAULT_DAYS, MIN_DELTA_OPTIONS, MIN_DELTA_VALUES, SORT_OPTIONS, SORT_VALUES, STATUS_FILTER_LABEL, STATUS_OPTIONS,
  VIEW_OPTIONS, applyMinDelta, availableRunDatesOf, compareAccountRows, driftCsv, driftSummary, exclusionsCsv, filterDriftRows,
  formatPct, formatRunDate, formatSignedUsd, groupByHousehold, isDataQualityStatus, latestRunDateOf, parseBucket, parseDays,
  parseStatus, parseView, type BucketFilter, type DriftHistoryDays, type MinDelta, type SortOption, type StatusFilter, type ViewMode,
} from "@/lib/trade-requests/drift-view/model";
import { AccountsView, HouseholdsView, type DetailState } from "./DriftTables";
import { ExclusionOverlapDialog } from "./ExclusionOverlapDialog";
import { OverrideDialog } from "./OverrideDialog";
import styles from "./Drift.module.css";

// The Drift screen (ticket): the standalone account Drift view (trade-request d41b6c9
// client/src/components/DriftTabV2.tsx:787-1664) on AOA's workspace components. It reads only the live
// drift routes. Override controls render for ADMIN and OPERATIONS; the routes refuse every other role.

const NAME_FILTER_DEBOUNCE_MS = 300;

export type DriftViewParams = { view?: string; days?: string; status?: string; bucket?: string; q?: string };

function downloadCsv(filename: string, lines: string[]): void {
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function FreshnessBanner({ freshness }: { freshness: CostBasisFreshnessSummary | null | undefined }) {
  if (!freshness || freshness.level === "ok") return null;
  const severe = freshness.level === "critical" || freshness.level === "missing";
  return (
    <div className={styles.banner} data-level={freshness.level} role="alert" data-drift-banner>
      <strong>
        {severe ? "🚨" : "⚠️"} Cost-basis data {freshness.level === "missing" ? "unavailable" : "stale"}.
      </strong>{" "}
      {freshness.message}{" "}
      <span className={styles.bannerNote}>Unrealized-gain and transfer-in figures below may be out of date.</span>
    </div>
  );
}

function SummaryStat({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "ok" | "caution" | "info" | "neutral" }) {
  return (
    <div className={styles.stat} data-tone={tone} data-drift-stat>
      <div className={styles.statValue} data-stat-value>{value}</div>
      <div className={styles.statLabel} data-stat-label>{label}</div>
    </div>
  );
}

function AllowList({ list }: { list: DriftAllowListResponse | null }) {
  if (!list) return null;
  return (
    <details className={styles.allowList} data-drift-allow-list>
      <summary>{DRIFT_COPY.allowListTitle} ({list.entries.length})</summary>
      {list.entries.length === 0 ? (
        <p className={styles.lede}>{DRIFT_COPY.allowListEmpty}</p>
      ) : (
        <ul>
          {list.entries.map((entry) => (
            <li key={entry.householdName}>{entry.householdName} — {entry.reason}: {entry.notes}</li>
          ))}
        </ul>
      )}
    </details>
  );
}

export function DriftView({ canOverride, initial = {} }: { canOverride: boolean; initial?: DriftViewParams }) {
  const [rows, setRows] = useState<AccountDriftHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [allowList, setAllowList] = useState<DriftAllowListResponse | null>(null);
  const [overlapAvailable, setOverlapAvailable] = useState(false);
  const [exclusionsExporting, setExclusionsExporting] = useState(false);
  const [exclusionsExportError, setExclusionsExportError] = useState<string | null>(null);
  const [overlapModalOpen, setOverlapModalOpen] = useState(false);
  const [overlapLoading, setOverlapLoading] = useState(false);
  const [overlapError, setOverlapError] = useState<string | null>(null);
  const [overlapReport, setOverlapReport] = useState<ExclusionOverlapResponse | null>(null);
  const [view, setView] = useState<ViewMode>(() => parseView(initial.view ?? null));
  const [days, setDays] = useState<DriftHistoryDays>(() => parseDays(initial.days ?? null));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => parseStatus(initial.status ?? null));
  const [bucketFilter, setBucketFilter] = useState<BucketFilter>(() => parseBucket(initial.bucket ?? null));
  const [nameFilterInput, setNameFilterInput] = useState<string>(initial.q ?? "");
  const [debouncedNameFilter, setDebouncedNameFilter] = useState<string>(initial.q ?? "");
  const [sortBy, setSortBy] = useState<SortOption>("delta_desc");
  const [accountFilterInput, setAccountFilterInput] = useState("");
  const [debouncedAccountFilter, setDebouncedAccountFilter] = useState("");
  const [minDelta, setMinDelta] = useState<MinDelta>(0);
  const [showDataQuality, setShowDataQuality] = useState(false);
  const [overrideTarget, setOverrideTarget] = useState<AccountDriftHistoryRow | null>(null);
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [selectedRunDate, setSelectedRunDate] = useState<string | null>(null);
  const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null);
  const [detailRun, setDetailRun] = useState<AccountDriftRunRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** A gone session ends the screen; any other failure is shown where it happened. */
  const failure = useCallback((err: unknown, fallback: string): string | null => {
    if (err instanceof DriftRequestError && err.signedOut) {
      setSignedOut(true);
      return null;
    }
    return err instanceof DriftRequestError ? err.message : fallback;
  }, []);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetchAccountDriftHistory(days);
      if (!mountedRef.current) return;
      setRows(response.runs);
    } catch (err) {
      if (!mountedRef.current) return;
      setLoadError(failure(err, DRIFT_COPY.historyFailed));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [days, failure]);

  const loadAllowList = useCallback(async () => {
    try {
      const list = await fetchAccountDriftAllowList();
      if (mountedRef.current) setAllowList(list);
    } catch (err) {
      if (mountedRef.current) failure(err, DRIFT_COPY.historyFailed);
    }
  }, [failure]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    void loadAllowList();
  }, [loadAllowList]);

  useEffect(() => {
    fetchAccountDriftExclusionOverlapAvailability()
      .then((available) => { if (mountedRef.current) setOverlapAvailable(available); })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        failure(err, DRIFT_COPY.overlapFailed);
        setOverlapAvailable(false);
      });
  }, [failure]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedNameFilter(nameFilterInput), NAME_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [nameFilterInput]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedAccountFilter(accountFilterInput), NAME_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [accountFilterInput]);

  // The standalone URL contract (DriftTabV2.tsx:907-926): defaults are omitted so a shared link stays clean.
  useEffect(() => {
    const next = new URLSearchParams(window.location.search);
    if (days === DEFAULT_DAYS) next.delete("days");
    else next.set("days", String(days));
    if (view === "accounts") next.delete("view");
    else next.set("view", view);
    if (statusFilter === "all") next.delete("status");
    else next.set("status", statusFilter);
    if (bucketFilter === "all") next.delete("bucket");
    else next.set("bucket", bucketFilter);
    const trimmed = debouncedNameFilter.trim();
    if (trimmed) next.set("q", trimmed);
    else next.delete("q");
    const query = next.toString();
    if (query !== window.location.search.replace(/^\?/, "")) {
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
  }, [days, view, statusFilter, bucketFilter, debouncedNameFilter]);

  const latestRunDate = useMemo(() => latestRunDateOf(rows), [rows]);
  const availableRunDates = useMemo(() => availableRunDatesOf(rows), [rows]);

  useEffect(() => {
    if (availableRunDates.length === 0) return;
    if (selectedRunDate === null || !availableRunDates.includes(selectedRunDate)) setSelectedRunDate(availableRunDates[0]);
  }, [availableRunDates, selectedRunDate]);

  const effectiveRunDate = selectedRunDate && availableRunDates.includes(selectedRunDate) ? selectedRunDate : latestRunDate;
  const latestRunRows = useMemo(
    () => (effectiveRunDate ? rows.filter((r) => r.runDateLocal === effectiveRunDate) : []),
    [rows, effectiveRunDate],
  );
  const costBasisFreshness = useMemo(
    () => latestRunRows.find((r) => r.costBasisFreshness != null)?.costBasisFreshness ?? null,
    [latestRunRows],
  );

  const loadOverlapReport = useCallback(async () => {
    setOverlapLoading(true);
    setOverlapError(null);
    try {
      const report = await fetchAccountDriftExclusionOverlap(latestRunDate ?? undefined);
      if (!mountedRef.current) return;
      setOverlapReport(report);
    } catch (err) {
      if (!mountedRef.current) return;
      setOverlapError(failure(err, DRIFT_COPY.overlapFailed));
      setOverlapReport(null);
    } finally {
      if (mountedRef.current) setOverlapLoading(false);
    }
  }, [latestRunDate, failure]);

  const sortedRows = useMemo(() => [...latestRunRows].sort((a, b) => compareAccountRows(a, b, sortBy)), [latestRunRows, sortBy]);
  const filteredRows = useMemo(
    () => filterDriftRows(sortedRows, {
      statusFilter, bucketFilter, showDataQuality, householdQuery: debouncedNameFilter, accountQuery: debouncedAccountFilter,
    }),
    [sortedRows, statusFilter, bucketFilter, showDataQuality, debouncedNameFilter, debouncedAccountFilter],
  );
  const dataQualityCount = useMemo(() => sortedRows.filter((r) => isDataQualityStatus(r.status)).length, [sortedRows]);
  const visibleRows = useMemo(() => applyMinDelta(filteredRows, minDelta), [filteredRows, minDelta]);
  const summary = useMemo(() => driftSummary(filteredRows), [filteredRows]);
  const groups = useMemo(() => groupByHousehold(visibleRows), [visibleRows]);

  const toggleExpand = useCallback(
    async (row: AccountDriftHistoryRow) => {
      const id = row.accountId;
      if (expandedAccountId === id) {
        setExpandedAccountId(null);
        setDetailRun(null);
        setDetailError(null);
        return;
      }
      setExpandedAccountId(id);
      setDetailRun(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const response = await fetchAccountDriftRun(row.runDateLocal);
        if (!mountedRef.current) return;
        const match = response.accounts.find((a) => a.accountId === id);
        if (!match) {
          setDetailError("Detail row not found in run payload.");
          return;
        }
        setDetailRun(match as AccountDriftRunRow);
      } catch (err) {
        if (!mountedRef.current) return;
        setDetailError(failure(err, DRIFT_COPY.detailFailed));
      } finally {
        if (mountedRef.current) setDetailLoading(false);
      }
    },
    [expandedAccountId, failure],
  );

  const handleRefresh = useCallback(() => {
    void loadHistory();
    void loadAllowList();
  }, [loadHistory, loadAllowList]);

  const handleExportCsv = useCallback(() => {
    if (latestRunRows.length === 0 || !effectiveRunDate) return;
    const { filename, lines } = driftCsv(latestRunRows, effectiveRunDate);
    downloadCsv(filename, lines);
  }, [latestRunRows, effectiveRunDate]);

  const handleExportExclusionsCsv = useCallback(async () => {
    setExclusionsExportError(null);
    setExclusionsExporting(true);
    try {
      const result = await exportDriftExclusions();
      if (!mountedRef.current) return;
      if (!result.ok) {
        setExclusionsExportError(result.message);
        return;
      }
      if (result.rows.length === 0) {
        setExclusionsExportError("No standing exclusions to export.");
        return;
      }
      const { filename, lines } = exclusionsCsv(result.rows, new Date().toISOString().slice(0, 10));
      downloadCsv(filename, lines);
    } catch {
      if (mountedRef.current) setExclusionsExportError(DRIFT_COPY.exportExclusionsFailed);
    } finally {
      if (mountedRef.current) setExclusionsExporting(false);
    }
  }, []);

  const handleOpenOverlapModal = useCallback(() => {
    setOverlapModalOpen(true);
    void loadOverlapReport();
  }, [loadOverlapReport]);

  const acceptSuggestion = useCallback((row: AccountDriftHistoryRow, reason: DriftOverrideReason, note: string) => {
    void setDriftOverride(row.accountId, { reason, note }, DRIFT_COPY.acceptFailed)
      .then(() => loadHistory())
      .catch((err: unknown) => setLoadError(failure(err, DRIFT_COPY.acceptFailed)));
  }, [loadHistory, failure]);

  if (signedOut) return <TradeRequestsSessionEnded />;

  const isFiltered = statusFilter !== "all" || bucketFilter !== "all" || debouncedNameFilter.trim().length > 0
    || debouncedAccountFilter.trim().length > 0 || minDelta > 0;
  const detail: DetailState = { detailRun, detailLoading, detailError };

  return (
    <div className={styles.view} data-testid="trade-requests-drift">
      <PageHeader
        eyebrow={TRADE_REQUESTS_COPY.eyebrow}
        title={DRIFT_COPY.title}
        description="Per-account comparison of live Apex positions against Meridian templates. Headline question per row: is this account inside or outside the 5pp tolerance, and which bucket (or symbol) is driving it?"
      />
      {summary && latestRunDate && (
        <p className={styles.lastRun}>
          Last run: <strong>{formatRunDate(latestRunDate)}</strong>
        </p>
      )}

      <FreshnessBanner freshness={costBasisFreshness} />

      {summary && (
        <div className={styles.stats}>
          <SummaryStat label="Accounts compared" value={summary.accounts.toString()} />
          <SummaryStat label="Out of tolerance" value={summary.out.toString()} tone={summary.out > 0 ? "caution" : "ok"} />
          <SummaryStat label="Uninvested" value={summary.uninvested.toString()} tone={summary.uninvested > 0 ? "info" : "ok"} />
          <SummaryStat label="No template" value={summary.noTemplate.toString()} tone={summary.noTemplate > 0 ? "info" : "ok"} />
          <SummaryStat label="Worst Δ (out of tol.)" value={summary.worst === null ? "—" : formatPct(summary.worst)} tone="caution" />
          <SummaryStat
            label="Realized G/L YTD (visible)"
            value={summary.realizedYtd === null ? "—" : formatSignedUsd(summary.realizedYtd)}
            tone={summary.realizedYtd !== null && summary.realizedYtd < 0 ? "ok" : "neutral"}
          />
        </div>
      )}

      <div className={styles.toolbar}>
        <div className={styles.controls}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>History</span>
            <select value={days} onChange={(e) => setDays(parseDays(e.target.value))} aria-label="History window in days">
              {DAY_OPTIONS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </label>
          {availableRunDates.length > 0 && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Run date</span>
              <select value={effectiveRunDate ?? ""} onChange={(e) => setSelectedRunDate(e.target.value)} aria-label="Run date">
                {availableRunDates.map((d, i) => <option key={d} value={d}>{d}{i === 0 ? " (latest)" : ""}</option>)}
              </select>
            </label>
          )}
          <div role="group" aria-label="View" className={styles.segmented}>
            {VIEW_OPTIONS.map((option) => (
              <button key={option} type="button" onClick={() => setView(option)} aria-pressed={view === option}>{option}</button>
            ))}
          </div>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Status</span>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} aria-label="Status filter">
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_FILTER_LABEL[s]}</option>)}
            </select>
          </label>
          {dataQualityCount > 0 && statusFilter === "all" && (
            <label className={styles.field}>
              <input type="checkbox" checked={showDataQuality} onChange={(e) => setShowDataQuality(e.target.checked)}
                aria-label="Show data-quality accounts" />
              <span className={styles.fieldLabel}>Show data quality ({dataQualityCount})</span>
            </label>
          )}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Worst bucket</span>
            <select value={bucketFilter} onChange={(e) => setBucketFilter(e.target.value as BucketFilter)} aria-label="Worst bucket filter">
              <option value="all">Any</option>
              <option value="cash">Cash</option>
              <option value="fixed">Fixed</option>
              <option value="equity">Equity</option>
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Min Δpp</span>
            <select value={minDelta} aria-label="Minimum Δpp filter" onChange={(e) => {
              const next = parseInt(e.target.value, 10);
              if (MIN_DELTA_VALUES.includes(next as MinDelta)) setMinDelta(next as MinDelta);
            }}>
              {MIN_DELTA_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Sort</span>
            <select value={sortBy} aria-label="Sort accounts" onChange={(e) => {
              const next = e.target.value as SortOption;
              if (SORT_VALUES.includes(next)) setSortBy(next);
            }}>
              {SORT_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
          </label>
          <input type="text" className={styles.textInput} value={nameFilterInput} onChange={(e) => setNameFilterInput(e.target.value)}
            placeholder="Filter by household name…" aria-label="Filter household" />
          <input type="text" className={styles.textInput} value={accountFilterInput} onChange={(e) => setAccountFilterInput(e.target.value)}
            placeholder="Filter by account title…" aria-label="Filter account title" />
        </div>
        <div className={styles.actions}>
          {overlapAvailable && <Button variant="ghost" size="sm" onClick={handleOpenOverlapModal}>Check exclusion overlap</Button>}
          <Button variant="ghost" size="sm" onClick={handleExportCsv} disabled={latestRunRows.length === 0}>Export CSV</Button>
          <Button variant="ghost" size="sm" onClick={() => void handleExportExclusionsCsv()} disabled={exclusionsExporting}
            title="Download every client- and account-level standing exclusion, firm-wide">
            {exclusionsExporting ? "Exporting…" : "Export exclusions"}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={loading}>Refresh</Button>
        </div>
      </div>

      {exclusionsExportError && (
        <div role="status" className={styles.notice}>
          <span>{exclusionsExportError}</span>
          <button type="button" className={styles.linkButton} onClick={() => setExclusionsExportError(null)}
            aria-label="Dismiss exclusions export message">Dismiss</button>
        </div>
      )}

      {loadError && (
        <div className={styles.notice} data-drift-error>
          <span>{loadError}</span>
          <button type="button" className={styles.linkButton} onClick={() => void loadHistory()}>Retry</button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className={styles.state} role="status">Loading…</div>
      ) : !loadError && rows.length === 0 ? (
        <div className={styles.state} data-drift-empty>
          No drift runs yet. The first nightly run posts at ~9:00 AM ET. If the system was deployed today, check back
          tomorrow.
        </div>
      ) : !loadError && visibleRows.length === 0 ? (
        <div className={styles.state}>
          No accounts match this filter. Try clearing the status or bucket filter, or check that the nightly scheduler
          ran.
        </div>
      ) : view === "accounts" ? (
        <AccountsView rows={visibleRows} expandedAccountId={expandedAccountId} detail={detail} onToggle={toggleExpand}
          isFiltered={isFiltered} totalRowCount={sortedRows.length} canOverride={canOverride}
          onEditOverride={(row) => setOverrideTarget(row)} onAcceptOverride={acceptSuggestion} />
      ) : (
        <HouseholdsView groups={groups} expandedAccountId={expandedAccountId} detail={detail} onToggle={toggleExpand} />
      )}

      <AllowList list={allowList} />

      {overlapModalOpen && (
        <ExclusionOverlapDialog report={overlapReport} loading={overlapLoading} error={overlapError}
          onClose={() => setOverlapModalOpen(false)} onRetry={() => void loadOverlapReport()} />
      )}

      {canOverride && overrideTarget && (
        <OverrideDialog
          row={overrideTarget}
          saving={overrideSaving}
          onClose={() => setOverrideTarget(null)}
          onSave={(reason, note, expiresOn) => {
            const accountId = overrideTarget.accountId;
            setOverrideSaving(true);
            void setDriftOverride(accountId, { reason, note, expiresOn })
              .then(() => loadHistory())
              .then(() => setOverrideTarget(null))
              .catch((err: unknown) => setLoadError(failure(err, DRIFT_COPY.saveFailed)))
              .finally(() => setOverrideSaving(false));
          }}
          onClear={() => {
            const accountId = overrideTarget.accountId;
            setOverrideSaving(true);
            void clearDriftOverride(accountId)
              .then(() => loadHistory())
              .then(() => setOverrideTarget(null))
              .catch((err: unknown) => setLoadError(failure(err, DRIFT_COPY.clearFailed)))
              .finally(() => setOverrideSaving(false));
          }}
        />
      )}
    </div>
  );
}
