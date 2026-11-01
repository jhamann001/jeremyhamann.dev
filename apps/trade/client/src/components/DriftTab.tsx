import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import type { DriftAllowListEntry, DriftHistoryRow, DriftRunDetail } from '@trade-request/shared';
import {
  fetchDriftHistory,
  fetchDriftAllowList,
  fetchDriftRunDetail,
  extractApiError,
  type DriftHistoryDays,
} from '../api/client';
import { computeBreachBadge } from '../utils/driftBadge';
import { DriftStatusBadge } from './ui/DriftStatusBadge';
import { DriftBreachBadge } from './ui/DriftBreachBadge';

const DAY_OPTIONS: DriftHistoryDays[] = [7, 30, 90];
const DEFAULT_DAYS: DriftHistoryDays = 30;
const NAME_FILTER_DEBOUNCE_MS = 300;

function parseDays(raw: string | null): DriftHistoryDays {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return DAY_OPTIONS.includes(parsed as DriftHistoryDays) ? (parsed as DriftHistoryDays) : DEFAULT_DAYS;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatRunDate(value: string): string {
  // `value` is `YYYY-MM-DD` (local calendar date America/New_York). Constructing
  // a Date from the bare string treats it as UTC, which can shift the rendered
  // weekday. Use the explicit Y/M/D ctor in local time for correctness.
  const [y, m, d] = value.split('-').map((part) => parseInt(part, 10));
  if (!y || !m || !d) return value;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function rowKey(row: DriftHistoryRow): string {
  return `${row.runDateLocal}|${row.householdName}`;
}

export function DriftTab() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [rows, setRows] = useState<DriftHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [allowListEntries, setAllowListEntries] = useState<DriftAllowListEntry[]>([]);
  const [allowListLoading, setAllowListLoading] = useState(true);

  const [days, setDays] = useState<DriftHistoryDays>(() => parseDays(searchParams.get('days')));
  const [breachOnly, setBreachOnly] = useState<boolean>(() => searchParams.get('breach') === '1');
  const [nameFilterInput, setNameFilterInput] = useState<string>(() => searchParams.get('q') ?? '');
  const [debouncedNameFilter, setDebouncedNameFilter] = useState<string>(() => searchParams.get('q') ?? '');

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<DriftRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    // Set on mount too: React's development double-mount runs the cleanup once before the real mount.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadHistory = useCallback(async (windowDays: DriftHistoryDays) => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetchDriftHistory(windowDays);
      if (!mountedRef.current) return;
      setRows(response.runs);
    } catch (err) {
      if (!mountedRef.current) return;
      setLoadError(extractApiError(err, 'Unable to load drift history. Please try again.'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const loadAllowList = useCallback(async () => {
    setAllowListLoading(true);
    try {
      const response = await fetchDriftAllowList();
      if (!mountedRef.current) return;
      setAllowListEntries(response.entries);
    } catch {
      // Failure to load the allow-list is non-fatal — without it, every breach
      // renders as "Would alert" instead of distinguishing allow-listed rows.
      // The history table itself stays usable; surface no banner.
      if (!mountedRef.current) return;
      setAllowListEntries([]);
    } finally {
      if (mountedRef.current) setAllowListLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHistory(days);
  }, [loadHistory, days]);

  useEffect(() => {
    loadAllowList();
  }, [loadAllowList]);

  // Debounced name filter (matches `useTradeRequests:65-68`).
  useEffect(() => {
    const id = setTimeout(() => setDebouncedNameFilter(nameFilterInput), NAME_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [nameFilterInput]);

  // Mirror state into URL search params on user interaction.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (days === DEFAULT_DAYS) next.delete('days');
    else next.set('days', String(days));
    if (breachOnly) next.set('breach', '1');
    else next.delete('breach');
    const trimmed = debouncedNameFilter.trim();
    if (trimmed) next.set('q', trimmed);
    else next.delete('q');
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [days, breachOnly, debouncedNameFilter, searchParams, setSearchParams]);

  const allowListNames = useMemo(
    () => new Set<string>(allowListEntries.map((entry) => entry.householdName)),
    [allowListEntries],
  );
  const allowListByName = useMemo(() => {
    const map = new Map<string, DriftAllowListEntry>();
    for (const entry of allowListEntries) map.set(entry.householdName, entry);
    return map;
  }, [allowListEntries]);

  const filteredRows = useMemo(() => {
    const q = debouncedNameFilter.trim().toLowerCase();
    return rows.filter((row) => {
      if (breachOnly && !row.breach) return false;
      if (q && !row.householdName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, breachOnly, debouncedNameFilter]);

  const summary = useMemo(() => {
    const today = rows[0]?.runDateLocal ?? null;
    if (!today) return null;
    const todaysRows = rows.filter((row) => row.runDateLocal === today);
    let breachCount = 0;
    let allowListedCount = 0;
    let unmappedCount = 0;
    for (const row of todaysRows) {
      const kind = computeBreachBadge(row, allowListNames);
      if (kind === 'would-alert') breachCount += 1;
      else if (kind === 'allow-listed') allowListedCount += 1;
      else if (kind === 'unmapped') unmappedCount += 1;
    }
    return { runDateLocal: today, breachCount, allowListedCount, unmappedCount };
  }, [rows, allowListNames]);

  const toggleExpand = useCallback(
    async (row: DriftHistoryRow) => {
      const key = rowKey(row);
      if (expandedKey === key) {
        setExpandedKey(null);
        setDetailRow(null);
        setDetailError(null);
        return;
      }
      setExpandedKey(key);
      setDetailRow(null);
      setDetailError(null);
      setDetailLoading(true);
      try {
        const response = await fetchDriftRunDetail(row.runDateLocal, row.householdName);
        if (!mountedRef.current) return;
        // If the user clicked away while the fetch was in flight, ignore the
        // response so we don't render a stale row.
        if (rowKey(response.run) !== key) return;
        setDetailRow(response.run);
      } catch (err) {
        if (!mountedRef.current) return;
        setDetailError(extractApiError(err, 'Unable to load run detail.'));
      } finally {
        if (mountedRef.current) setDetailLoading(false);
      }
    },
    [expandedKey],
  );

  const handleRefresh = useCallback(() => {
    loadHistory(days);
    loadAllowList();
  }, [loadHistory, loadAllowList, days]);

  const isFiltered = breachOnly || debouncedNameFilter.trim().length > 0;

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Registry drift</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Nightly comparison of live Apex positions against Meridian templates. Read-only history view; alerting is
          configured separately.
        </p>
        {summary && (
          <p className="text-xs text-[var(--text-muted)] mt-2">
            Last run:{' '}
            <span className="text-[var(--text-primary)] font-medium">{formatRunDate(summary.runDateLocal)}</span>
            {' · '}
            <span className="text-[var(--red)] font-medium">{summary.breachCount}</span>{' '}
            {summary.breachCount === 1 ? 'breach' : 'breaches'} today
            {', '}
            <span className="text-[var(--yellow)] font-medium">{summary.allowListedCount}</span> allow-listed
            {', '}
            <span className="text-[var(--text-secondary)] font-medium">{summary.unmappedCount}</span> unmapped accounts
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div
            role="group"
            aria-label="Date range"
            className="bg-[var(--bg-surface)] rounded-full p-[3px] flex gap-0.5"
          >
            {DAY_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setDays(option)}
                aria-pressed={days === option}
                className={`px-3 py-1 text-[12px] font-medium rounded-full transition-colors ${
                  days === option
                    ? 'bg-[var(--bg-pill)] text-white'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                {option}d
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
            <input
              type="checkbox"
              checked={breachOnly}
              onChange={(e) => setBreachOnly(e.target.checked)}
              className="rounded border-[var(--border)]"
            />
            Breach only
          </label>

          <input
            type="text"
            value={nameFilterInput}
            onChange={(e) => setNameFilterInput(e.target.value)}
            placeholder="Filter household…"
            aria-label="Filter household"
            className="px-3 py-1.5 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
          />
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={loading || allowListLoading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium border border-[var(--border)] text-[var(--text-primary)] rounded-md hover:bg-[var(--bg-surface)] disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {loadError && (
        <div className="mb-4 px-4 py-3 text-sm bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-md flex items-center justify-between gap-3">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => loadHistory(days)}
            className="px-3 py-1 text-xs font-medium border border-red-300 dark:border-red-700 rounded hover:bg-red-100 dark:hover:bg-red-900 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="text-center py-12 text-[var(--text-muted)] text-sm">Loading…</div>
      ) : !loadError && rows.length === 0 ? (
        <div className="text-center py-12 text-[var(--text-muted)] text-sm border border-dashed border-[var(--border)] rounded-lg">
          No drift runs yet. The first nightly run posts at ~9:00 AM ET. If the system was deployed today, check back
          tomorrow.
        </div>
      ) : !loadError && filteredRows.length === 0 ? (
        <div className="text-center py-12 text-[var(--text-muted)] text-sm border border-dashed border-[var(--border)] rounded-lg">
          No drift runs match your filters. Try widening the date range or clearing the household filter.
        </div>
      ) : (
        <div className="border border-[var(--border)] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-surface)]">
              <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
                <th className="px-3 py-2.5 font-medium w-8" aria-label="Expand row" />
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Household</th>
                <th className="px-4 py-2.5 font-medium">Max delta</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Breach</th>
                <th className="px-4 py-2.5 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => {
                const key = rowKey(row);
                const isExpanded = expandedKey === key;
                const badgeKind = computeBreachBadge(row, allowListNames);
                const allowListEntry = allowListByName.get(row.householdName);
                const tooltip =
                  badgeKind === 'allow-listed' && allowListEntry
                    ? `${allowListEntry.reason}: ${allowListEntry.notes}`
                    : undefined;
                return (
                  <FragmentRow
                    key={key}
                    row={row}
                    rowKeyValue={key}
                    isExpanded={isExpanded}
                    badgeKind={badgeKind}
                    tooltip={tooltip}
                    detailLoading={detailLoading}
                    detailError={detailError}
                    detailRow={detailRow}
                    onToggle={() => toggleExpand(row)}
                  />
                );
              })}
            </tbody>
          </table>
          {isFiltered && (
            <div className="px-4 py-2 text-xs text-[var(--text-muted)] border-t border-[var(--border)] bg-[var(--bg-surface)]">
              Showing {filteredRows.length} of {rows.length} rows
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface FragmentRowProps {
  row: DriftHistoryRow;
  rowKeyValue: string;
  isExpanded: boolean;
  badgeKind: ReturnType<typeof computeBreachBadge>;
  tooltip: string | undefined;
  detailLoading: boolean;
  detailError: string | null;
  detailRow: DriftRunDetail | null;
  onToggle: () => void;
}

function FragmentRow({
  row,
  rowKeyValue,
  isExpanded,
  badgeKind,
  tooltip,
  detailLoading,
  detailError,
  detailRow,
  onToggle,
}: FragmentRowProps) {
  return (
    <>
      <tr
        className={`border-t border-[var(--border)] cursor-pointer hover:bg-[var(--bg-surface)] ${
          isExpanded ? 'bg-[var(--bg-surface)]' : ''
        }`}
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <td className="px-3 py-3 text-[var(--text-muted)]">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </td>
        <td className="px-4 py-3 text-[var(--text-primary)] whitespace-nowrap">{formatRunDate(row.runDateLocal)}</td>
        <td className="px-4 py-3 text-[var(--text-primary)]">{row.householdName}</td>
        <td className="px-4 py-3 text-[var(--text-primary)] tabular-nums">{formatPct(row.maxDeltaPct)}</td>
        <td className="px-4 py-3">
          <DriftStatusBadge status={row.coverageStatus} />
        </td>
        <td className="px-4 py-3">
          <DriftBreachBadge kind={badgeKind} tooltip={tooltip} />
        </td>
        <td className="px-4 py-3 text-[var(--text-muted)]" title={row.snapshotAsOf ?? 'unknown'}>
          {row.snapshotSource}
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-[var(--bg-surface)] border-t border-[var(--border)]">
          <td colSpan={7} className="px-6 py-4">
            <ExpandedDetail
              rowKeyValue={rowKeyValue}
              detailLoading={detailLoading}
              detailError={detailError}
              detailRow={detailRow}
            />
          </td>
        </tr>
      )}
    </>
  );
}

interface ExpandedDetailProps {
  rowKeyValue: string;
  detailLoading: boolean;
  detailError: string | null;
  detailRow: DriftRunDetail | null;
}

function ExpandedDetail({ rowKeyValue, detailLoading, detailError, detailRow }: ExpandedDetailProps) {
  if (detailLoading) {
    return <div className="text-xs text-[var(--text-muted)]">Loading detail…</div>;
  }
  if (detailError) {
    return <div className="text-xs text-red-600 dark:text-red-400">{detailError}</div>;
  }
  if (!detailRow || rowKey(detailRow) !== rowKeyValue) {
    return <div className="text-xs text-[var(--text-muted)]">Detail not available.</div>;
  }
  const details = detailRow.details as { worstSymbol?: unknown; accounts?: unknown } | null | undefined;
  const worstSymbol = typeof details?.worstSymbol === 'string' ? details.worstSymbol : null;
  const accountsLength = Array.isArray(details?.accounts) ? details!.accounts.length : null;
  if (!worstSymbol && accountsLength === null) {
    return (
      <div className="text-xs text-[var(--text-muted)]">
        No per-symbol breakdown available for this run. Detail row is recorded but the JSONB blob is empty.
      </div>
    );
  }
  return (
    <dl className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
      <div>
        <dt className="text-[var(--text-muted)] uppercase tracking-wide">Account count</dt>
        <dd className="text-[var(--text-primary)] font-medium mt-0.5">{detailRow.accountCount}</dd>
      </div>
      <div>
        <dt className="text-[var(--text-muted)] uppercase tracking-wide">Worst bucket</dt>
        <dd className="text-[var(--text-primary)] font-medium mt-0.5">{worstSymbol ?? '—'}</dd>
      </div>
      <div>
        <dt className="text-[var(--text-muted)] uppercase tracking-wide">Accounts in detail</dt>
        <dd className="text-[var(--text-primary)] font-medium mt-0.5">{accountsLength ?? '—'}</dd>
      </div>
    </dl>
  );
}
