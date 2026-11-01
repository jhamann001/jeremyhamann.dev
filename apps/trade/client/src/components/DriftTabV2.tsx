import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { RefreshCw, ChevronDown, ChevronRight, Download } from 'lucide-react';
import { csvEscape, downloadCsv } from '../utils/csv';
import type {
  AccountDriftHistoryRow,
  AccountDriftRunRow,
  AccountDriftStatus,
  AccountTaxSummary,
  CostBasisFreshnessSummary,
  DriftOverrideReason,
  ExclusionExportRow,
  ExclusionOverlapReport,
} from '@trade-request/shared';
import {
  fetchAccountDriftHistory,
  type DriftHistoryDays,
  fetchAccountDriftRun,
  fetchAccountDriftAllowList,
  fetchAccountDriftExclusionOverlap,
  fetchAccountDriftExclusionOverlapAvailability,
  fetchExclusionsExport,
  setDriftOverride,
  clearDriftOverride,
  extractApiError,
} from '../api/client';
import { accountDriftDetailsSchema, type SectorAllocation } from '../api/schemas';
import { DriftExclusionOverlapModal } from './DriftExclusionOverlapModal';
import { useAuth } from '../contexts/AuthContext';

const NAME_FILTER_DEBOUNCE_MS = 300;

// History window options. Mirrors the v1 tab's control, plus 180 so the window
// can reach the first drift runs (v2's first was 2026-05-14) — 90 stopped ~8
// days short of launch. Must stay <= the server's HISTORY_MAX_DAYS (180).
const DAY_OPTIONS: DriftHistoryDays[] = [7, 30, 90, 180];
// 30 stays the default: the tab holds the entire window in memory and refilters
// client-side, so payload grows linearly with the window (~180 accounts/day).
// A long window is opt-in rather than everyone's default page load.
const DEFAULT_DAYS: DriftHistoryDays = 30;

function parseDays(raw: string | null): DriftHistoryDays {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return DAY_OPTIONS.includes(parsed as DriftHistoryDays) ? (parsed as DriftHistoryDays) : DEFAULT_DAYS;
}

type ViewMode = 'accounts' | 'households';
type StatusFilter = 'all' | AccountDriftStatus;
type BucketFilter = 'all' | 'cash' | 'fixed' | 'equity';
type SortOption =
  'delta_desc' | 'delta_asc' | 'gain_asc' | 'gain_desc' | 'value_desc' | 'value_asc' | 'account_az' | 'household_az';
type MinDelta = 0 | 2 | 5 | 10 | 20;

const STATUS_OPTIONS: StatusFilter[] = [
  'all',
  'out',
  'in',
  'uninvested',
  'no_template',
  'negligible',
  'template_invalid',
];
const BUCKET_OPTIONS: BucketFilter[] = ['all', 'cash', 'fixed', 'equity'];
const VIEW_OPTIONS: ViewMode[] = ['accounts', 'households'];
const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'delta_desc', label: 'Δpp (highest first)' },
  { value: 'delta_asc', label: 'Δpp (lowest first)' },
  // Tax-adjusted: "lowest first" floats cheap-to-fix / loss-harvest accounts to
  // the top; "highest first" surfaces tax-locked (often transition) accounts.
  { value: 'gain_asc', label: 'Unrealized G/L (lowest first — cheapest to fix)' },
  { value: 'gain_desc', label: 'Unrealized G/L (highest first — tax-locked)' },
  { value: 'value_desc', label: 'Total value (highest first)' },
  { value: 'value_asc', label: 'Total value (lowest first)' },
  { value: 'account_az', label: 'Account A→Z' },
  { value: 'household_az', label: 'Household A→Z' },
];
const SORT_VALUES: SortOption[] = SORT_OPTIONS.map((o) => o.value);
const MIN_DELTA_OPTIONS: { value: MinDelta; label: string }[] = [
  { value: 0, label: 'All Δpp' },
  { value: 2, label: 'Δpp > 2' },
  { value: 5, label: 'Δpp > 5' },
  { value: 10, label: 'Δpp > 10' },
  { value: 20, label: 'Δpp > 20' },
];
const MIN_DELTA_VALUES: MinDelta[] = MIN_DELTA_OPTIONS.map((o) => o.value);

// B3 fix: percent-scale rendering. v2 stores percent-scale (0..100) — do NOT
// multiply by 100. See docs/plans/2026-q3-drift-v2-accounts.md §6 Step 10.
function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function formatRunDate(value: string): string {
  const [y, m, d] = value.split('-').map((part) => parseInt(part, 10));
  if (!y || !m || !d) return value;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function truncTitle(title: string, max: number = 38): string {
  if (!title) return '(no title)';
  return title.length > max ? title.slice(0, max - 1) + '…' : title;
}

function parseView(raw: string | null): ViewMode {
  return VIEW_OPTIONS.includes(raw as ViewMode) ? (raw as ViewMode) : 'accounts';
}

function parseStatus(raw: string | null): StatusFilter {
  return STATUS_OPTIONS.includes(raw as StatusFilter) ? (raw as StatusFilter) : 'all';
}

function parseBucket(raw: string | null): BucketFilter {
  return BUCKET_OPTIONS.includes(raw as BucketFilter) ? (raw as BucketFilter) : 'all';
}

const BUCKET_LABEL: Record<'cash' | 'fixed' | 'equity', string> = {
  cash: 'Cash',
  fixed: 'Fixed',
  equity: 'Equity',
};

const STATUS_LABEL: Record<AccountDriftStatus, string> = {
  in: 'In tolerance',
  out: 'Out of tolerance',
  uninvested: 'Uninvested',
  no_template: 'No template',
  negligible: 'Negligible balance',
  template_invalid: 'Template error',
};

const STATUS_STYLES: Record<AccountDriftStatus, string> = {
  in: 'text-[var(--green)] bg-[var(--green-light)]',
  out: 'text-[var(--drift-oot-fg)] bg-[var(--drift-oot-bg)]',
  uninvested: 'text-[var(--blue-muted)] bg-[var(--blue-light)]',
  // Neutral surface tone — `no_template` is informational, not a breach.
  no_template: 'text-[var(--text-secondary)] bg-[var(--bg-surface)]',
  // Non-actionable data-quality lanes. `negligible` is dust (muted); a
  // `template_invalid` row gets a red tone to flag it as a data error to fix
  // (distinct from the yellow `out` drift tone).
  negligible: 'text-[var(--text-muted)] bg-[var(--bg-surface)]',
  template_invalid: 'text-[var(--red)] bg-[var(--red-light)]',
};

// The two non-actionable data-quality lanes (drift-checker rules R1/R2). These
// are hidden from the default view behind a toggle and never counted as
// actionable out-of-tolerance accounts.
const DATA_QUALITY_STATUSES: AccountDriftStatus[] = ['negligible', 'template_invalid'];

function isDataQualityStatus(status: AccountDriftStatus): boolean {
  return DATA_QUALITY_STATUSES.includes(status);
}

// ─── Manual status overrides ────────────────────────────────────────────────

const OVERRIDE_REASONS: { value: DriftOverrideReason; label: string }[] = [
  { value: 'asset_location', label: 'Asset location (household-level)' },
  { value: 'tax_constraint', label: 'Tax constraint (embedded gains)' },
  { value: 'active_transition', label: 'Active transition / transfer-in' },
  { value: 'intentional_cash', label: 'Intentional cash / MMF' },
  { value: 'concentrated_position', label: 'Concentrated position (legacy)' },
  { value: 'template_error', label: 'Template config error' },
  { value: 'direct_index_noise', label: 'Direct-index whole-share noise' },
  { value: 'other', label: 'Other (explain in note)' },
];

const OVERRIDE_REASON_LABEL: Record<DriftOverrideReason, string> = Object.fromEntries(
  OVERRIDE_REASONS.map((r) => [r.value, r.label]),
) as Record<DriftOverrideReason, string>;

/** Short label for the badge (the dropdown labels are too long for a chip). */
const OVERRIDE_REASON_SHORT: Record<DriftOverrideReason, string> = {
  asset_location: 'Asset location',
  tax_constraint: 'Tax-constrained',
  active_transition: 'In transition',
  intentional_cash: 'Intentional cash',
  concentrated_position: 'Concentrated',
  template_error: 'Template error',
  direct_index_noise: 'Direct-index noise',
  other: 'Override',
};

function OverrideModal({
  row,
  saving,
  onSave,
  onClear,
  onClose,
}: {
  row: AccountDriftHistoryRow;
  saving: boolean;
  onSave: (reason: DriftOverrideReason, note: string, expiresOn: string | null) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const existing = row.override ?? null;
  const [reason, setReason] = useState<DriftOverrideReason | ''>(existing?.reason ?? '');
  const [note, setNote] = useState<string>(existing?.note ?? '');
  const [expiresOn, setExpiresOn] = useState<string>(existing?.expiresOn ?? '');

  const noteRequired = reason === 'other';
  const canSave = reason !== '' && (!noteRequired || note.trim().length > 0) && !saving;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Set drift status override"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl">
        <header className="flex items-start justify-between border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Override drift status</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">{row.accountTitle || row.accountId}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            ✕
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">Reason</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as DriftOverrideReason | '')}
              aria-label="Override reason"
              className="w-full rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
            >
              <option value="">Select a reason…</option>
              {OVERRIDE_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          {reason !== '' && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                Note{noteRequired ? ' (required)' : ' (optional)'}
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                aria-label="Override note"
                placeholder="Why is this account accepted off-target?"
                className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
              />
            </label>
          )}

          {reason !== '' && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                Re-check on (optional) — the override expires after this date and we'll notify you to revisit it
              </span>
              <input
                type="date"
                value={expiresOn}
                onChange={(e) => setExpiresOn(e.target.value)}
                aria-label="Override expiry date"
                className="rounded-md border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
              />
            </label>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-[var(--border)] px-5 py-3">
          <div>
            {existing && (
              <button
                type="button"
                onClick={onClear}
                disabled={saving}
                className="text-xs font-medium text-[var(--red)] hover:underline disabled:opacity-50"
              >
                Clear override
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!canSave}
              onClick={() => onSave(reason as DriftOverrideReason, note, expiresOn === '' ? null : expiresOn)}
              className="rounded-md bg-[var(--bg-pill)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ─── R3 / R5 auto-suggested overrides (read-time, from existing row fields) ──
// The system proposes an override on an out-of-tolerance account; a trader
// confirms with one click (which creates a real, trader-attributed override).
// Thresholds are tunable — kept as named constants for now.
const SUGGEST_TRANSFER_IN_PCT = 25; // R3 — mid-transition / transfer-in still landing
const SUGGEST_GAIN_ABS_USD = 50_000; // R5 — large embedded gain (absolute)
const SUGGEST_GAIN_REL_FRACTION = 0.15; // R5 — or ≥15% of account value

interface OverrideSuggestion {
  reason: DriftOverrideReason;
  note: string;
}

/**
 * Suggest an override for an actionable, not-yet-overridden account:
 *   R3 active_transition — a confirmed transition or ≥25% transfer-in (timing;
 *     takes precedence since it auto-resolves once the transfer settles).
 *   R5 tax_constraint — embedded gain ≥ $50K or ≥15% of account value (a cheap
 *     rebalance would realize a meaningful tax bill).
 * Returns null when nothing applies.
 */
function suggestOverride(row: AccountDriftHistoryRow): OverrideSuggestion | null {
  if (row.status !== 'out' || row.override) return null;
  // Tax-driven acceptances (tax constraint, tax transition) only apply to
  // taxable accounts — an IRA/Roth realizes no capital gains on sale, so it can
  // always be rebalanced freely. Require an explicit taxable=true.
  if (row.taxable !== true) return null;

  if (row.transitionConfirmed === true || (row.transferInPct ?? 0) >= SUGGEST_TRANSFER_IN_PCT) {
    const pct = typeof row.transferInPct === 'number' ? `, transfer-in ${Math.round(row.transferInPct)}%` : '';
    return { reason: 'active_transition', note: `Auto-suggested: active transition${pct}.` };
  }

  const gain = row.unrealizedGainUsd ?? 0;
  const relTrip = row.totalValueUsd > 0 && gain >= SUGGEST_GAIN_REL_FRACTION * row.totalValueUsd;
  if (gain >= SUGGEST_GAIN_ABS_USD || relTrip) {
    const relPct = row.totalValueUsd > 0 ? Math.round((gain / row.totalValueUsd) * 100) : 0;
    return {
      reason: 'tax_constraint',
      note: `Auto-suggested: embedded gain ${formatUsd(gain)} (${relPct}% of account).`,
    };
  }
  return null;
}

/** The Override-column cell: badge when set, plus a trader-only set/edit affordance. */
function OverrideCell({
  row,
  isTrader,
  onEdit,
  onAccept,
}: {
  row: AccountDriftHistoryRow;
  isTrader: boolean;
  onEdit: () => void;
  onAccept: (reason: DriftOverrideReason, note: string) => void;
}) {
  const ov = row.override ?? null;
  if (ov) {
    return (
      <div className="flex flex-col gap-0.5">
        <span
          className="inline-flex w-fit items-center rounded-md bg-[var(--bg-surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--text-secondary)]"
          title={`${ov.note ? ov.note + ' — ' : ''}set by ${ov.setByName}${ov.expiresOn ? `, expires ${ov.expiresOn}` : ''}`}
        >
          ✓ {OVERRIDE_REASON_SHORT[ov.reason]}
        </span>
        {isTrader && (
          <button type="button" onClick={onEdit} className="w-fit text-[11px] text-[var(--text-muted)] hover:underline">
            Edit
          </button>
        )}
      </div>
    );
  }
  if (!isTrader) return <span className="text-[var(--text-muted)]">—</span>;

  // R3/R5 auto-suggestion: propose an override the trader confirms with one click.
  const suggestion = suggestOverride(row);
  if (suggestion) {
    return (
      <div className="flex flex-col gap-1">
        <span
          className="inline-flex w-fit items-center rounded-md border border-[var(--blue-muted)]/40 bg-[var(--blue-light)] px-2 py-0.5 text-[11px] font-semibold text-[var(--blue-muted)]"
          title={suggestion.note}
        >
          Likely {OVERRIDE_REASON_SHORT[suggestion.reason]}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onAccept(suggestion.reason, suggestion.note)}
            className="rounded-md bg-[var(--bg-pill)] px-2 py-0.5 text-[11px] font-medium text-white"
          >
            Accept
          </button>
          <button type="button" onClick={onEdit} className="text-[11px] text-[var(--text-muted)] hover:underline">
            Set…
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onEdit}
      className="rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    >
      Set override
    </button>
  );
}

function StatusPill({ status }: { status: AccountDriftStatus }) {
  return (
    <span
      className={`px-2.5 py-0.5 rounded-md text-[11px] font-semibold ${STATUS_STYLES[status]}`}
      aria-label={STATUS_LABEL[status]}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function BucketPill({ bucket, emphasised }: { bucket: 'cash' | 'fixed' | 'equity' | null; emphasised: boolean }) {
  if (bucket === null) {
    return <span className="text-[var(--text-muted)]">—</span>;
  }
  const cls = emphasised
    ? 'text-[var(--drift-oot-fg)] bg-[var(--drift-oot-bg)]'
    : 'text-[var(--text-secondary)] bg-[var(--bg-surface)]';
  return <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${cls}`}>{BUCKET_LABEL[bucket]}</span>;
}

function ToleranceBadge({ ok }: { ok: boolean }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-[11px] font-medium ${
        ok ? 'text-[var(--green)] bg-[var(--green-light)]' : 'text-[var(--yellow)] bg-[var(--yellow-light)]'
      }`}
    >
      {ok ? 'In tolerance' : 'Out of tolerance'}
    </span>
  );
}

// ─── Cost-basis tax layer rendering ──────────────────────────────────────────

function formatSignedUsd(n: number): string {
  const rounded = Math.round(n);
  if (rounded === 0) return '$0';
  return `${rounded < 0 ? '−' : '+'}${formatUsd(Math.abs(n))}`;
}

const GAIN_TONE = 'text-[var(--green)]';
const LOSS_TONE = 'text-red-600 dark:text-red-400';

/** Cost-basis staleness banner — invisible when data is fresh or absent. */
function FreshnessBanner({ freshness }: { freshness: CostBasisFreshnessSummary | null | undefined }) {
  if (!freshness || freshness.level === 'ok') return null;
  const severe = freshness.level === 'critical' || freshness.level === 'missing';
  const cls = severe
    ? 'bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300'
    : 'bg-[var(--yellow-light)] border-[var(--yellow)] text-[var(--yellow)]';
  return (
    <div className={`mb-4 px-4 py-3 text-sm border rounded-md ${cls}`} role="alert">
      <span className="font-semibold">
        {severe ? '🚨' : '⚠️'} Cost-basis data {freshness.level === 'missing' ? 'unavailable' : 'stale'}.
      </span>{' '}
      {freshness.message}{' '}
      <span className="opacity-80">Unrealized-gain and transfer-in figures below may be out of date.</span>
    </div>
  );
}

function SignedUsdCell({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) {
    return <span className="text-[var(--text-muted)]">—</span>;
  }
  return (
    <span className={`tabular-nums font-medium ${value < 0 ? LOSS_TONE : GAIN_TONE}`}>{formatSignedUsd(value)}</span>
  );
}

/**
 * A template whose symbol weights don't sum to ~100% is malformed at the
 * source (Meridian) — every bucket delta computed against it is distorted,
 * so the account can look severely "drifted" when the template is the real
 * problem. The 99–101% band matches the server's `template_invalid` rule (R2)
 * so this chip and the "Template error" status always agree.
 */
function templateSumIssuePct(row: AccountDriftHistoryRow): number | null {
  const total = typeof row.templateTotalPct === 'number' ? row.templateTotalPct : null;
  if (total === null) return null;
  return total < 99 || total > 101 ? total : null;
}

/** Transfer-in % / transition / malformed-template chips shown under the account title. */
function AccountFlags({ row }: { row: AccountDriftHistoryRow }) {
  const transferPct = typeof row.transferInPct === 'number' ? row.transferInPct : null;
  const showTransfer = transferPct !== null && transferPct >= 1;
  const showTransition = row.transitionConfirmed || row.transitionCandidate;
  const badTemplateTotal = templateSumIssuePct(row);
  if (!showTransfer && !showTransition && badTemplateTotal === null) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {badTemplateTotal !== null && (
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-[var(--red)] bg-[var(--red-light)]"
          title="The Meridian template's weights don't add up to 100%, so this account's drift numbers are distorted. Fix the template in Meridian."
        >
          ⚠ Template sums to {badTemplateTotal.toFixed(badTemplateTotal % 1 === 0 ? 0 : 1)}%
        </span>
      )}
      {showTransfer && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium text-[var(--blue-muted)] bg-[var(--blue-light)]">
          🔄 Transfer-in {Math.round(transferPct as number)}%
        </span>
      )}
      {showTransition && (
        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-[var(--yellow)] bg-[var(--yellow-light)]">
          {row.transitionConfirmed ? '🔄 Active transition' : 'Transition candidate'}
        </span>
      )}
    </div>
  );
}

/** "Tax & cost basis" panel inside the expanded row. */
function TaxPanel({ tax }: { tax: AccountTaxSummary }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Tax &amp; cost basis</h3>
        <span className="text-xs text-[var(--text-muted)]">basis coverage: {tax.basisCoveragePct.toFixed(0)}%</span>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm mb-3">
        <div>
          <div className="text-xs text-[var(--text-muted)]">Unrealized G/L</div>
          <div className={`font-semibold tabular-nums ${tax.unrealizedGainUsd < 0 ? LOSS_TONE : GAIN_TONE}`}>
            {formatSignedUsd(tax.unrealizedGainUsd)}
          </div>
          <div className="text-[11px] text-[var(--text-muted)]">
            ST {formatSignedUsd(tax.unrealizedShortTermGainUsd)} · LT {formatSignedUsd(tax.unrealizedLongTermGainUsd)}
          </div>
        </div>
        <div>
          <div className="text-xs text-[var(--text-muted)]">Realized G/L YTD</div>
          <div className={`font-semibold tabular-nums ${(tax.realizedGainYtdUsd ?? 0) < 0 ? LOSS_TONE : GAIN_TONE}`}>
            {formatSignedUsd(tax.realizedGainYtdUsd ?? 0)}
          </div>
          <div className="text-[11px] text-[var(--text-muted)]">
            ST {formatSignedUsd(tax.realizedShortTermYtdUsd ?? 0)} · LT{' '}
            {formatSignedUsd(tax.realizedLongTermYtdUsd ?? 0)}
          </div>
        </div>
        <div>
          <div className="text-xs text-[var(--text-muted)]">Transferred-in</div>
          <div className="font-semibold tabular-nums text-[var(--text-primary)]">
            {formatUsd(tax.transferInValueUsd)}
          </div>
          <div className="text-[11px] text-[var(--text-muted)]">{tax.transferInPct.toFixed(0)}% of account</div>
        </div>
        {(tax.transitionConfirmed || tax.transitionCandidate) && (
          <div>
            <div className="text-xs text-[var(--text-muted)]">Transition</div>
            <div className="font-semibold text-[var(--yellow)]">
              {tax.transitionConfirmed ? '🔄 Active transition' : 'Transition candidate'}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {tax.transitionConfirmed
                ? [
                    tax.transitionTargetName ? `→ ${tax.transitionTargetName}` : null,
                    tax.transitionEstRealizedGainUsd != null
                      ? `est. realized ${formatSignedUsd(tax.transitionEstRealizedGainUsd)}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'confirmed by Meridian feed'
                : 'taxable · no template · mostly transfer-in (heuristic)'}
            </div>
          </div>
        )}
      </div>
      {tax.hasMissingBasis && (
        <p className="text-xs text-[var(--text-muted)] italic mb-2">
          ⚠ Some positions have missing/zero cost basis — unrealized gain may be overstated.
        </p>
      )}
      {tax.symbols.length > 0 && (
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg-surface)]">
            <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <th className="px-3 py-2 font-medium">Symbol</th>
              <th className="px-3 py-2 font-medium text-right">Market value</th>
              <th className="px-3 py-2 font-medium text-right">Cost basis</th>
              <th className="px-3 py-2 font-medium text-right">Unrealized</th>
              <th className="px-3 py-2 font-medium">Term</th>
              <th className="px-3 py-2 font-medium">Origin</th>
            </tr>
          </thead>
          <tbody>
            {tax.symbols.map((s) => {
              // Dominant-term hint — a symbol can hold mixed-term lots.
              const term =
                Math.abs(s.unrealizedLongTermGainUsd) >= Math.abs(s.unrealizedShortTermGainUsd) &&
                s.unrealizedLongTermGainUsd !== 0
                  ? 'LT'
                  : 'ST';
              return (
                <tr key={s.symbol} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2 text-[var(--text-primary)]">{s.symbol}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)] tabular-nums text-right">
                    {formatUsd(s.marketValueUsd)}
                  </td>
                  <td className="px-3 py-2 text-[var(--text-secondary)] tabular-nums text-right">
                    {formatUsd(s.costBasisUsd)}
                  </td>
                  <td
                    className={`px-3 py-2 tabular-nums text-right font-medium ${s.unrealizedGainUsd < 0 ? LOSS_TONE : GAIN_TONE}`}
                  >
                    {formatSignedUsd(s.unrealizedGainUsd)}
                  </td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">{term}</td>
                  <td className="px-3 py-2">
                    {s.transferInPct > 0 ? (
                      <span className="text-[var(--blue-muted)]">🔄 transfer-in</span>
                    ) : (
                      <span className="text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Color tone per classification kind for the allocation bar. */
function sliceTone(kind: SectorAllocation['slices'][number]['kind']): string {
  if (kind === 'sector') return 'var(--blue)';
  if (kind === 'assetClass') return 'var(--purple, #8b5cf6)';
  return 'var(--text-muted)';
}

/** Equity-sleeve sector / asset-class breakdown inside the expanded row. */
function SectorAllocationPanel({ allocation }: { allocation: SectorAllocation }) {
  const { slices, classifiedPct, unclassifiedPct } = allocation;
  if (slices.length === 0) return null;
  const total = classifiedPct + unclassifiedPct || 1; // equity-sleeve total (account-relative)

  return (
    <div>
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Equity sleeve — sector / asset class</h3>
      <table className="w-full text-sm">
        <thead className="bg-[var(--bg-surface)]">
          <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
            <th className="px-3 py-2 font-medium">Classification</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium text-right">% of account</th>
            <th className="px-3 py-2 font-medium text-right">% of equity</th>
          </tr>
        </thead>
        <tbody>
          {slices.map((s) => (
            <tr key={s.label} className="border-t border-[var(--border)]">
              <td className="px-3 py-2 text-[var(--text-primary)]">
                <span
                  className="inline-block w-2 h-2 rounded-sm mr-2 align-middle"
                  style={{ backgroundColor: sliceTone(s.kind) }}
                />
                {s.label}
              </td>
              <td className="px-3 py-2 text-[var(--text-muted)]">
                {s.kind === 'sector' ? 'GICS sector' : s.kind === 'assetClass' ? 'Fund / asset class' : '—'}
              </td>
              <td className="px-3 py-2 text-[var(--text-secondary)] tabular-nums text-right">{s.pct.toFixed(1)}%</td>
              <td className="px-3 py-2 text-[var(--text-secondary)] tabular-nums text-right">
                {((s.pct / total) * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface HouseholdGroup {
  household: string;
  accounts: AccountDriftHistoryRow[];
  totalValue: number;
  outCount: number;
  uninvestedCount: number;
  worstDelta: number;
}

// `no_template` rows have a null Δpp; we sink them to the bottom regardless
// of asc/desc so they don't masquerade as "perfectly on target" (0) at the
// top of a delta-asc sort. Same for any other sort — they have no
// measurable delta so their relative position is undefined.
function compareDeltaNullable(aDelta: number | null, bDelta: number | null, order: 'asc' | 'desc'): number | null {
  if (aDelta === null && bDelta === null) return 0;
  if (aDelta === null) return 1;
  if (bDelta === null) return -1;
  return order === 'asc' ? aDelta - bDelta : bDelta - aDelta;
}

function compareAccountRows(a: AccountDriftHistoryRow, b: AccountDriftHistoryRow, sortBy: SortOption): number {
  const aliasOptions: Intl.CollatorOptions = { sensitivity: 'base' };
  switch (sortBy) {
    case 'delta_desc':
      return compareDeltaNullable(a.maxBucketDeltaPct, b.maxBucketDeltaPct, 'desc') ?? 0;
    case 'delta_asc':
      return compareDeltaNullable(a.maxBucketDeltaPct, b.maxBucketDeltaPct, 'asc') ?? 0;
    // Accounts with no tax data (null gain) sink to the bottom regardless of
    // direction — same treatment as null Δpp.
    case 'gain_asc':
      return compareDeltaNullable(a.unrealizedGainUsd ?? null, b.unrealizedGainUsd ?? null, 'asc') ?? 0;
    case 'gain_desc':
      return compareDeltaNullable(a.unrealizedGainUsd ?? null, b.unrealizedGainUsd ?? null, 'desc') ?? 0;
    case 'value_desc':
      return b.totalValueUsd - a.totalValueUsd;
    case 'value_asc':
      return a.totalValueUsd - b.totalValueUsd;
    case 'account_az':
      return (a.accountTitle ?? '').localeCompare(b.accountTitle ?? '', undefined, aliasOptions);
    case 'household_az': {
      const householdCmp = (a.householdName ?? '').localeCompare(b.householdName ?? '', undefined, aliasOptions);
      if (householdCmp !== 0) return householdCmp;
      return (a.accountTitle ?? '').localeCompare(b.accountTitle ?? '', undefined, aliasOptions);
    }
  }
}

function groupByHousehold(rows: AccountDriftHistoryRow[]): HouseholdGroup[] {
  const map = new Map<string, AccountDriftHistoryRow[]>();
  for (const r of rows) {
    const key = r.householdName || 'unmapped';
    const arr = map.get(key) ?? [];
    arr.push(r);
    map.set(key, arr);
  }
  return Array.from(map.entries())
    .map(([household, accounts]) => ({
      household,
      accounts,
      totalValue: accounts.reduce((s, a) => s + a.totalValueUsd, 0),
      outCount: accounts.filter((a) => a.status === 'out').length,
      uninvestedCount: accounts.filter((a) => a.status === 'uninvested').length,
      // Only `out` (out-of-tolerance) rows count toward the worst-delta
      // rollup. `uninvested` rows — e.g. newly-funded accounts still sitting
      // in cash — carry a large cash-vs-target delta but aren't "drifted";
      // they just haven't been invested yet, so they must not dominate the
      // metric. `no_template` (null delta) and `in` rows are excluded too.
      worstDelta: accounts.reduce((m, a) => Math.max(m, a.status === 'out' ? (a.maxBucketDeltaPct ?? 0) : 0), 0),
    }))
    .sort((a, b) => b.worstDelta - a.worstDelta);
}

export function DriftTabV2() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [rows, setRows] = useState<AccountDriftHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Allow-list is fetched on mount to be future-proof; the v2 surface
  // currently renders nothing for it (the array is empty server-side until a
  // real allow-list emerges from shadow-mode review — §6 Step 10).
  const [, setAllowListLoading] = useState(true);
  const [overlapAvailable, setOverlapAvailable] = useState(false);
  // Firm-wide exclusions export (separate file from the drift CSV).
  const [exclusionsExporting, setExclusionsExporting] = useState(false);
  const [exclusionsExportError, setExclusionsExportError] = useState<string | null>(null);

  const [overlapModalOpen, setOverlapModalOpen] = useState(false);
  const [overlapLoading, setOverlapLoading] = useState(false);
  const [overlapError, setOverlapError] = useState<string | null>(null);
  const [overlapReport, setOverlapReport] = useState<ExclusionOverlapReport | null>(null);

  const [view, setView] = useState<ViewMode>(() => parseView(searchParams.get('view')));
  const [days, setDays] = useState<DriftHistoryDays>(() => parseDays(searchParams.get('days')));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => parseStatus(searchParams.get('status')));
  const [bucketFilter, setBucketFilter] = useState<BucketFilter>(() => parseBucket(searchParams.get('bucket')));
  const [nameFilterInput, setNameFilterInput] = useState<string>(() => searchParams.get('q') ?? '');
  const [debouncedNameFilter, setDebouncedNameFilter] = useState<string>(() => searchParams.get('q') ?? '');
  // New filter/sort controls (not URL-synced — local UI affordances only).
  const [sortBy, setSortBy] = useState<SortOption>('delta_desc');
  const [accountFilterInput, setAccountFilterInput] = useState<string>('');
  const [debouncedAccountFilter, setDebouncedAccountFilter] = useState<string>('');
  const [minDelta, setMinDelta] = useState<MinDelta>(0);
  // Data-quality lanes (negligible balance / template error) are hidden from
  // the default view — they're not actionable drift. This toggle reveals them.
  const [showDataQuality, setShowDataQuality] = useState(false);
  // Manual status overrides (trader-only writes; everyone sees the badges).
  const { user } = useAuth();
  const isTrader = user?.role === 'trader';
  const [overrideTarget, setOverrideTarget] = useState<AccountDriftHistoryRow | null>(null);
  const [overrideSaving, setOverrideSaving] = useState(false);
  // Which run date the table + export reflect. Null until history loads, then
  // defaults to the latest available run; lets the user pull/compare prior days.
  const [selectedRunDate, setSelectedRunDate] = useState<string | null>(null);

  const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null);
  const [detailRun, setDetailRun] = useState<AccountDriftRunRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    // Reset on (re)mount, not just cleanup — under React.StrictMode (dev) the
    // mount→unmount→remount cycle would otherwise leave this permanently false,
    // so the loaders' `finally { if (mountedRef.current) setLoading(false) }`
    // never fires and the tab hangs on "Loading…".
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
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
      setLoadError(extractApiError(err, 'Unable to load drift history. Please try again.'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [days]);

  const loadAllowList = useCallback(async () => {
    setAllowListLoading(true);
    try {
      await fetchAccountDriftAllowList();
    } catch {
      // Non-fatal; the v2 surface doesn't render allow-list state today.
    } finally {
      if (mountedRef.current) setAllowListLoading(false);
    }
  }, []);

  const loadOverlapAvailability = useCallback(async () => {
    try {
      const available = await fetchAccountDriftExclusionOverlapAvailability();
      if (!mountedRef.current) return;
      setOverlapAvailable(available);
    } catch {
      if (!mountedRef.current) return;
      setOverlapAvailable(false);
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    loadAllowList();
  }, [loadAllowList]);

  useEffect(() => {
    loadOverlapAvailability();
  }, [loadOverlapAvailability]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedNameFilter(nameFilterInput), NAME_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [nameFilterInput]);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedAccountFilter(accountFilterInput), NAME_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [accountFilterInput]);

  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    // The date-range control is live again (it was retired when v2 shipped with a
    // fixed 30-day window), so `days` round-trips through the URL like the other
    // filters. Omitted at the default so a shared link stays clean.
    if (days === DEFAULT_DAYS) next.delete('days');
    else next.set('days', String(days));
    if (view === 'accounts') next.delete('view');
    else next.set('view', view);
    if (statusFilter === 'all') next.delete('status');
    else next.set('status', statusFilter);
    if (bucketFilter === 'all') next.delete('bucket');
    else next.set('bucket', bucketFilter);
    const trimmed = debouncedNameFilter.trim();
    if (trimmed) next.set('q', trimmed);
    else next.delete('q');
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }, [days, view, statusFilter, bucketFilter, debouncedNameFilter, searchParams, setSearchParams]);

  // `latestRunDate` is sort-independent — we compute it from `rows` rather
  // than `sortedRows[0]` so picking e.g. "Account A→Z" doesn't reach into a
  // different run-date for the summary tiles.
  const latestRunDate = useMemo<string | null>(() => {
    let max: string | null = null;
    for (const r of rows) {
      if (max === null || r.runDateLocal > max) max = r.runDateLocal;
    }
    return max;
  }, [rows]);
  // `/api/drift/v2/history` returns the latest run from EACH date in its
  // window (HISTORY_SQL groups by run_date_local), so the same account can
  // appear multiple times — once per date — when more than one nightly run
  // exists in the window. The UI contract is "each run is a new row, only
  // the most recent run is visible," so we narrow the table source to the
  // latest run-date here. Summary tiles, the table, household groups, and
  // the "Showing X of Y" denominator all flow from `latestRunRows`. The
  // multi-date payload is still useful for a future date picker / history
  // view — we don't drop it on the wire.
  // Distinct run dates in the loaded window (newest first) — drives the date
  // picker. The full multi-date payload is already in `rows` (cap 50k, far above
  // ~30 days × ~180 accounts), so switching dates is an in-memory refilter.
  const availableRunDates = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.runDateLocal);
    return Array.from(set).sort((a, b) => (a < b ? 1 : -1));
  }, [rows]);

  // Default the selected date to the latest once history loads, and clamp it
  // back to latest if the current selection falls out of the window on refresh.
  useEffect(() => {
    if (availableRunDates.length === 0) return;
    if (selectedRunDate === null || !availableRunDates.includes(selectedRunDate)) {
      setSelectedRunDate(availableRunDates[0]);
    }
  }, [availableRunDates, selectedRunDate]);

  const effectiveRunDate =
    selectedRunDate && availableRunDates.includes(selectedRunDate) ? selectedRunDate : latestRunDate;

  // Table source = the SELECTED run date (defaults to latest). Summary tiles,
  // table, household groups, and the export all flow from this cohort.
  const latestRunRows = useMemo(
    () => (effectiveRunDate ? rows.filter((r) => r.runDateLocal === effectiveRunDate) : []),
    [rows, effectiveRunDate],
  );

  // Cost-basis freshness is run-level — denormalized onto every row of a run,
  // so the first latest-run row carries it for the banner.
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
      setOverlapError(extractApiError(err, 'Unable to load exclusion overlap diagnostic.'));
      setOverlapReport(null);
    } finally {
      if (mountedRef.current) setOverlapLoading(false);
    }
  }, [latestRunDate]);

  // Client-side sort keyed on the user's sortBy choice. Defaults to Δpp DESC
  // (the contract the API returns), so a no-sort selection is a no-op resilience
  // re-sort and a future API change doesn't silently regress.
  const sortedRows = useMemo(
    () => [...latestRunRows].sort((a, b) => compareAccountRows(a, b, sortBy)),
    [latestRunRows, sortBy],
  );

  const filteredRows = useMemo(() => {
    const householdQuery = debouncedNameFilter.trim().toLowerCase();
    const accountQuery = debouncedAccountFilter.trim().toLowerCase();
    return sortedRows.filter((row) => {
      // Non-actionable data-quality lanes (negligible / template_invalid) are
      // hidden in the default "all" view unless the toggle is on. When the user
      // explicitly selects one of those statuses below, the statusFilter check
      // lets it through.
      if (statusFilter === 'all' && !showDataQuality && isDataQualityStatus(row.status)) return false;
      if (statusFilter !== 'all' && row.status !== statusFilter) return false;
      if (bucketFilter !== 'all' && row.worstBucket !== bucketFilter) return false;
      if (householdQuery && !(row.householdName ?? '').toLowerCase().includes(householdQuery)) return false;
      if (accountQuery && !(row.accountTitle ?? '').toLowerCase().includes(accountQuery)) return false;
      return true;
    });
  }, [sortedRows, statusFilter, showDataQuality, bucketFilter, debouncedNameFilter, debouncedAccountFilter]);

  // How many rows sit in the hidden data-quality lanes (for the toggle label).
  const dataQualityCount = useMemo(() => sortedRows.filter((r) => isDataQualityStatus(r.status)).length, [sortedRows]);

  // Summary tiles read from the same cohort that produces the table EXCEPT
  // for the min-Δpp slider — so the headline "Worst Δ on the book" doesn't
  // chase its own floor when the user drags the slider up. status / bucket /
  // household / account-title filters all flow into the tiles, but the
  // min-Δpp narrowing is layered on top in `visibleRows` instead. When no
  // filter is active `filterCohort === latestRunRows` and tiles read
  // identically to the unfiltered run.
  const filterCohort = filteredRows;

  // Min-Δpp filter is layered AFTER the filterCohort so summary tiles keep
  // tracking the status/bucket/text filters but stay decoupled from the
  // slider. `no_template` rows have a null delta; they're treated as
  // "below any threshold" so the min-Δpp filter hides them once it's
  // engaged.
  const visibleRows = useMemo(
    () =>
      minDelta > 0
        ? filteredRows.filter((row) => row.maxBucketDeltaPct !== null && row.maxBucketDeltaPct > minDelta)
        : filteredRows,
    [filteredRows, minDelta],
  );

  const summary = useMemo(() => {
    // Empty cohort (no rows after status/bucket/text filters) → return null
    // so the renderer hides the entire tile strip cleanly. The empty-state
    // copy under the table covers the "no rows match" UX.
    if (filterCohort.length === 0) return null;
    // A row with an active manual override is accepted — it drops out of the
    // actionable out-of-tolerance count (and the worst-Δ headline below).
    const out = filterCohort.filter((r) => r.status === 'out' && !r.override).length;
    const uninvested = filterCohort.filter((r) => r.status === 'uninvested').length;
    const noTemplate = filterCohort.filter((r) => r.status === 'no_template').length;
    // "Worst Δ on the book" reflects OUT-OF-TOLERANCE accounts only. An
    // `uninvested` account (newly funded, still parked in cash) has a large
    // cash-vs-target delta but isn't drifted — we just haven't invested it
    // yet — so it must not hijack the headline. `no_template` rows carry a
    // null delta and are excluded for the same reason. When the cohort has
    // no `out` row the list is empty and `worst` is `null`; the tile renders
    // an em-dash instead of `0%`.
    const outDeltas = filterCohort
      .filter((r) => r.status === 'out' && !r.override)
      .map((r) => r.maxBucketDeltaPct)
      .filter((d): d is number => d !== null);
    const worst = outDeltas.length === 0 ? null : Math.max(...outDeltas);
    // Realized YTD across the visible cohort — null when no row carries it (the
    // cost-basis feed isn't wired yet), so the tile hides rather than showing $0.
    const realizedRows = filterCohort.filter((r) => typeof r.realizedGainYtdUsd === 'number');
    const realizedYtd =
      realizedRows.length === 0 ? null : realizedRows.reduce((s, r) => s + (r.realizedGainYtdUsd as number), 0);
    return { accounts: filterCohort.length, out, uninvested, noTemplate, worst, realizedYtd };
  }, [filterCohort]);

  // Households view inherits the user's sort for accounts inside each card
  // (groupByHousehold preserves input order). The household-card ordering
  // itself stays max-Δpp DESC per `groupByHousehold`.
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
          setDetailError('Detail row not found in run payload.');
          return;
        }
        setDetailRun(match);
      } catch (err) {
        if (!mountedRef.current) return;
        setDetailError(extractApiError(err, 'Unable to load run detail.'));
      } finally {
        if (mountedRef.current) setDetailLoading(false);
      }
    },
    [expandedAccountId],
  );

  const handleRefresh = useCallback(() => {
    loadHistory();
    loadAllowList();
  }, [loadHistory, loadAllowList]);

  // Export the selected run-date's full cohort to CSV (all accounts that date,
  // pre-filter — so a downloaded file is a complete snapshot, not the current
  // table filters).
  //
  // Carries every field the row holds, not just the visible table columns, so
  // the file stands alone for review and audit. The original 15 columns keep
  // their positions — day-over-day files get diffed in spreadsheets and
  // reordering them would silently break those — with everything added since
  // appended after them.
  const handleExportCsv = useCallback(() => {
    if (latestRunRows.length === 0 || !effectiveRunDate) return;
    const num = (v: number | null | undefined, dp = 2) => (typeof v === 'number' ? v.toFixed(dp) : '');
    const bool = (v: boolean | null | undefined) => (v == null ? '' : v ? 'yes' : 'no');
    // Collapse newlines so a multi-line override note stays one spreadsheet row.
    const oneLine = (v: string) => v.replace(/\s*\r?\n\s*/g, ' ').trim();
    const header = [
      'Run Date',
      'Account',
      'Household',
      'Template',
      'Template Sum %',
      'Status',
      'Coverage',
      'Max Δpp',
      'Worst Bucket',
      'Symbol Breaches',
      'Total Value USD',
      'Unrealized G/L USD',
      'Realized G/L YTD USD',
      'Transfer-In %',
      'Active Transition',
      // ─── Appended 2026-07: full row detail + override audit ───
      'Account ID',
      // Mirrors the summary tiles' actionable rule (`status === 'out' && !override`)
      // so a filtered spreadsheet reproduces the on-screen count.
      'Actionable',
      'Overridden',
      'Override Reason',
      'Override Note',
      'Override Set By',
      'Override Set At',
      'Override Expires On',
      'Taxable',
      'Transition Candidate',
      'Snapshot Source',
      'Snapshot As Of',
      'Cost Basis Freshness',
    ];
    const lines = [header.map(csvEscape).join(',')];
    // Worst-first, then account — stable, useful ordering for the file.
    const sorted = [...latestRunRows].sort(
      (a, b) =>
        (b.maxBucketDeltaPct ?? -1) - (a.maxBucketDeltaPct ?? -1) ||
        (a.accountTitle ?? '').localeCompare(b.accountTitle ?? ''),
    );
    for (const r of sorted) {
      const ov = r.override ?? null;
      lines.push(
        [
          r.runDateLocal,
          r.accountTitle ?? '',
          r.householdName ?? '',
          r.templateName ?? '',
          num(r.templateTotalPct, 1),
          r.status,
          r.coverage,
          num(r.maxBucketDeltaPct),
          r.worstBucket ?? '',
          String(r.symbolBreachCount ?? 0),
          num(r.totalValueUsd),
          num(r.unrealizedGainUsd),
          num(r.realizedGainYtdUsd),
          num(r.transferInPct, 1),
          r.transitionConfirmed ? 'yes' : '',
          r.accountId,
          r.status === 'out' && !ov ? 'yes' : 'no',
          ov ? 'yes' : 'no',
          ov ? OVERRIDE_REASON_LABEL[ov.reason] : '',
          ov ? oneLine(ov.note) : '',
          ov?.setByName ?? '',
          ov?.setAt ?? '',
          ov?.expiresOn ?? '',
          bool(r.taxable),
          bool(r.transitionCandidate),
          r.snapshotSource ?? '',
          r.snapshotAsOf ?? '',
          r.costBasisFreshness?.level ?? '',
        ]
          .map((v) => csvEscape(String(v)))
          .join(','),
      );
    }
    downloadCsv(`drift_${effectiveRunDate}.csv`, lines);
  }, [latestRunRows, effectiveRunDate]);

  // Firm-wide standing exclusions — a separate file from the drift export, on
  // its own fetch: exclusions aren't run-scoped and aren't held by this tab, so
  // they're pulled fresh on click rather than kept in state.
  const handleExportExclusionsCsv = useCallback(async () => {
    setExclusionsExportError(null);
    setExclusionsExporting(true);
    try {
      const rows = await fetchExclusionsExport();
      if (!mountedRef.current) return;
      if (rows.length === 0) {
        setExclusionsExportError('No standing exclusions to export.');
        return;
      }
      const header = [
        'Scope',
        'Client ID',
        'Client',
        'Account ID',
        'Account Number',
        'Ticker',
        'Kind',
        'Reason',
        'No Buy',
        'No Sell',
        'Created By',
        'Created At',
      ];
      const lines = [header.map(csvEscape).join(',')];
      // Broad-to-specific: client-level rows (which apply to every account the
      // client holds) first, then account-level. Explicit rank rather than
      // localeCompare on `scope`, which would order 'account' first by accident.
      const scopeRank = (s: ExclusionExportRow['scope']) => (s === 'client' ? 0 : 1);
      const sorted = [...rows].sort(
        (a, b) =>
          scopeRank(a.scope) - scopeRank(b.scope) ||
          (a.clientName || a.clientId).localeCompare(b.clientName || b.clientId) ||
          (a.accountNumber || a.accountId).localeCompare(b.accountNumber || b.accountId) ||
          a.ticker.localeCompare(b.ticker),
      );
      for (const r of sorted) {
        lines.push(
          [
            r.scope,
            r.clientId,
            r.clientName,
            r.accountId,
            r.accountNumber,
            r.ticker,
            r.kind,
            r.reason.replace(/\s*\r?\n\s*/g, ' ').trim(),
            r.noBuy ? 'yes' : 'no',
            r.noSell ? 'yes' : 'no',
            r.createdByName,
            r.createdAt,
          ]
            .map((v) => csvEscape(String(v)))
            .join(','),
        );
      }
      downloadCsv(`exclusions_${new Date().toISOString().slice(0, 10)}.csv`, lines);
    } catch (err) {
      if (!mountedRef.current) return;
      setExclusionsExportError(extractApiError(err, 'Unable to export exclusions.'));
    } finally {
      if (mountedRef.current) setExclusionsExporting(false);
    }
  }, []);

  const handleOpenOverlapModal = useCallback(() => {
    setOverlapModalOpen(true);
    void loadOverlapReport();
  }, [loadOverlapReport]);

  const isFiltered =
    statusFilter !== 'all' ||
    bucketFilter !== 'all' ||
    debouncedNameFilter.trim().length > 0 ||
    debouncedAccountFilter.trim().length > 0 ||
    minDelta > 0;

  return (
    <div className="max-w-[110rem] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-[var(--text-primary)]">Account drift</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Per-account comparison of live Apex positions against Meridian templates. Headline question per row: is this
          account inside or outside the 5pp tolerance, and which bucket (or symbol) is driving it?
        </p>
        {summary && latestRunDate && (
          <p className="text-xs text-[var(--text-muted)] mt-2">
            Last run: <span className="text-[var(--text-primary)] font-medium">{formatRunDate(latestRunDate)}</span>
          </p>
        )}
      </div>

      <FreshnessBanner freshness={costBasisFreshness} />

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
          <SummaryStat label="Accounts compared" value={summary.accounts.toString()} />
          <SummaryStat
            label="Out of tolerance"
            value={summary.out.toString()}
            tone={summary.out > 0 ? 'warning' : 'success'}
          />
          <SummaryStat
            label="Uninvested"
            value={summary.uninvested.toString()}
            tone={summary.uninvested > 0 ? 'info' : 'success'}
          />
          <SummaryStat
            label="No template"
            value={summary.noTemplate.toString()}
            tone={summary.noTemplate > 0 ? 'info' : 'success'}
          />
          <SummaryStat
            label="Worst Δ (out of tol.)"
            value={summary.worst === null ? '—' : formatPct(summary.worst)}
            tone="warning"
          />
          <SummaryStat
            label="Realized G/L YTD (visible)"
            value={summary.realizedYtd === null ? '—' : formatSignedUsd(summary.realizedYtd)}
            tone={summary.realizedYtd !== null && summary.realizedYtd < 0 ? 'success' : 'neutral'}
          />
        </div>
      )}

      <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-sm text-[var(--text-primary)]">
            <span className="text-xs text-[var(--text-muted)]">History</span>
            <select
              value={days}
              onChange={(e) => setDays(parseDays(e.target.value))}
              aria-label="History window in days"
              className="px-2 py-1 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
            >
              {DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>

          {availableRunDates.length > 0 && (
            <label className="flex items-center gap-1.5 text-sm text-[var(--text-primary)]">
              <span className="text-xs text-[var(--text-muted)]">Run date</span>
              <select
                value={effectiveRunDate ?? ''}
                onChange={(e) => setSelectedRunDate(e.target.value)}
                aria-label="Run date"
                className="px-2 py-1 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
              >
                {availableRunDates.map((d, i) => (
                  <option key={d} value={d}>
                    {d}
                    {i === 0 ? ' (latest)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div role="group" aria-label="View" className="bg-[var(--bg-surface)] rounded-full p-[3px] flex gap-0.5">
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setView(option)}
                aria-pressed={view === option}
                className={`px-3 py-1 text-[12px] font-medium rounded-full transition-colors capitalize ${
                  view === option
                    ? 'bg-[var(--bg-pill)] text-white'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                {option}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-1.5 text-sm text-[var(--text-primary)]">
            <span className="text-xs text-[var(--text-muted)]">Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              aria-label="Status filter"
              className="px-2 py-1 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
            >
              <option value="all">All accounts</option>
              <option value="out">Out of tolerance only</option>
              <option value="in">In tolerance only</option>
              <option value="uninvested">Uninvested only</option>
              <option value="no_template">No template only</option>
              <option value="negligible">Negligible balance only</option>
              <option value="template_invalid">Template error only</option>
            </select>
          </label>

          {dataQualityCount > 0 && statusFilter === 'all' && (
            <label className="flex items-center gap-1.5 text-sm text-[var(--text-primary)]">
              <input
                type="checkbox"
                checked={showDataQuality}
                onChange={(e) => setShowDataQuality(e.target.checked)}
                aria-label="Show data-quality accounts"
                className="accent-[var(--bg-pill)]"
              />
              <span className="text-xs text-[var(--text-muted)]">Show data quality ({dataQualityCount})</span>
            </label>
          )}

          <label className="flex items-center gap-1.5 text-sm text-[var(--text-primary)]">
            <span className="text-xs text-[var(--text-muted)]">Worst bucket</span>
            <select
              value={bucketFilter}
              onChange={(e) => setBucketFilter(e.target.value as BucketFilter)}
              aria-label="Worst bucket filter"
              className="px-2 py-1 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
            >
              <option value="all">Any</option>
              <option value="cash">Cash</option>
              <option value="fixed">Fixed</option>
              <option value="equity">Equity</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-sm text-[var(--text-primary)]">
            <span className="text-xs text-[var(--text-muted)]">Min Δpp</span>
            <select
              value={minDelta}
              onChange={(e) => {
                const next = parseInt(e.target.value, 10);
                if (MIN_DELTA_VALUES.includes(next as MinDelta)) {
                  setMinDelta(next as MinDelta);
                }
              }}
              aria-label="Minimum Δpp filter"
              className="px-2 py-1 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
            >
              {MIN_DELTA_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-sm text-[var(--text-primary)]">
            <span className="text-xs text-[var(--text-muted)]">Sort</span>
            <select
              value={sortBy}
              onChange={(e) => {
                const next = e.target.value as SortOption;
                if (SORT_VALUES.includes(next)) setSortBy(next);
              }}
              aria-label="Sort accounts"
              className="px-2 py-1 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <input
            type="text"
            value={nameFilterInput}
            onChange={(e) => setNameFilterInput(e.target.value)}
            placeholder="Filter by household name…"
            aria-label="Filter household"
            className="px-3 py-1.5 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
          />

          <input
            type="text"
            value={accountFilterInput}
            onChange={(e) => setAccountFilterInput(e.target.value)}
            placeholder="Filter by account title…"
            aria-label="Filter account title"
            className="px-3 py-1.5 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--bg-pill)]"
          />
        </div>

        <div className="flex items-center gap-2">
          {overlapAvailable && (
            <button
              type="button"
              onClick={handleOpenOverlapModal}
              className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium border border-[var(--border)] text-[var(--text-primary)] rounded-md hover:bg-[var(--bg-surface)] transition-colors"
            >
              Check exclusion overlap
            </button>
          )}
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={latestRunRows.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium border border-[var(--border)] text-[var(--text-primary)] rounded-md hover:bg-[var(--bg-surface)] disabled:opacity-50 transition-colors"
          >
            <Download size={14} />
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => void handleExportExclusionsCsv()}
            disabled={exclusionsExporting}
            title="Download every client- and account-level standing exclusion, firm-wide"
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium border border-[var(--border)] text-[var(--text-primary)] rounded-md hover:bg-[var(--bg-surface)] disabled:opacity-50 transition-colors"
          >
            <Download size={14} />
            {exclusionsExporting ? 'Exporting…' : 'Export exclusions'}
          </button>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium border border-[var(--border)] text-[var(--text-primary)] rounded-md hover:bg-[var(--bg-surface)] disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {exclusionsExportError && (
        <div
          role="status"
          className="mb-4 px-4 py-3 text-sm bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-md flex items-center justify-between gap-3"
        >
          <span>{exclusionsExportError}</span>
          <button
            type="button"
            onClick={() => setExclusionsExportError(null)}
            aria-label="Dismiss exclusions export message"
            className="px-3 py-1 text-xs font-medium border border-red-300 dark:border-red-700 rounded hover:bg-red-100 dark:hover:bg-red-900 transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {loadError && (
        <div className="mb-4 px-4 py-3 text-sm bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded-md flex items-center justify-between gap-3">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => loadHistory()}
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
      ) : !loadError && visibleRows.length === 0 ? (
        <div className="text-center py-12 text-[var(--text-muted)] text-sm border border-dashed border-[var(--border)] rounded-lg">
          No accounts match this filter. Try clearing the status or bucket filter, or check that the nightly scheduler
          ran.
        </div>
      ) : view === 'accounts' ? (
        <AccountsView
          rows={visibleRows}
          expandedAccountId={expandedAccountId}
          detailRun={detailRun}
          detailLoading={detailLoading}
          detailError={detailError}
          onToggle={toggleExpand}
          isFiltered={isFiltered}
          totalRowCount={sortedRows.length}
          isTrader={isTrader}
          onEditOverride={(row) => setOverrideTarget(row)}
          onAcceptOverride={(row, reason, note) => {
            // One-click accept of an R3/R5 suggestion → a real trader-attributed
            // override (reuses the same write path as the manual modal).
            void setDriftOverride(row.accountId, { reason, note })
              .then(() => loadHistory())
              .catch((err) => setLoadError(extractApiError(err, 'Unable to accept the suggestion.')));
          }}
        />
      ) : (
        <HouseholdsView
          groups={groups}
          expandedAccountId={expandedAccountId}
          detailRun={detailRun}
          detailLoading={detailLoading}
          detailError={detailError}
          onToggle={toggleExpand}
        />
      )}

      {overlapModalOpen && (
        <DriftExclusionOverlapModal
          report={overlapReport}
          loading={overlapLoading}
          error={overlapError}
          onClose={() => setOverlapModalOpen(false)}
          onRetry={() => {
            void loadOverlapReport();
          }}
        />
      )}

      {overrideTarget && (
        <OverrideModal
          row={overrideTarget}
          saving={overrideSaving}
          onClose={() => setOverrideTarget(null)}
          onSave={(reason, note, expiresOn) => {
            const accountId = overrideTarget.accountId;
            setOverrideSaving(true);
            void setDriftOverride(accountId, { reason, note, expiresOn })
              .then(() => loadHistory())
              .then(() => {
                setOverrideTarget(null);
              })
              .catch((err) => {
                setLoadError(extractApiError(err, 'Unable to save the override.'));
              })
              .finally(() => setOverrideSaving(false));
          }}
          onClear={() => {
            const accountId = overrideTarget.accountId;
            setOverrideSaving(true);
            void clearDriftOverride(accountId)
              .then(() => loadHistory())
              .then(() => {
                setOverrideTarget(null);
              })
              .catch((err) => {
                setLoadError(extractApiError(err, 'Unable to clear the override.'));
              })
              .finally(() => setOverrideSaving(false));
          }}
        />
      )}
    </div>
  );
}

interface SummaryStatProps {
  label: string;
  value: string;
  tone?: 'success' | 'warning' | 'info' | 'neutral';
}

function SummaryStat({ label, value, tone = 'neutral' }: SummaryStatProps) {
  const toneClass: Record<NonNullable<SummaryStatProps['tone']>, string> = {
    success: 'text-[var(--green)]',
    warning: 'text-[var(--yellow)]',
    info: 'text-[var(--blue-muted)]',
    neutral: 'text-[var(--text-primary)]',
  };
  return (
    <div className="border border-[var(--border)] rounded-lg px-4 py-3 bg-[var(--bg-surface)]">
      <div className={`text-xl font-semibold ${toneClass[tone]}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-[var(--text-muted)] mt-0.5">{label}</div>
    </div>
  );
}

// ─── Resizable table columns ────────────────────────────────────────────────
// Hand-rolled (no table lib): a colgroup drives widths under table-layout:fixed,
// a drag handle on each header edge updates the width, and widths persist to
// localStorage so a trader's layout sticks across sessions.

const MIN_COL_WIDTH = 56;

interface ColumnDef {
  key: string;
  label: string;
  width: number;
  align?: 'right';
  /** Expander column — fixed, no resize handle. */
  fixed?: boolean;
}

const ACCOUNT_COLUMNS: ColumnDef[] = [
  { key: 'expand', label: '', width: 36, fixed: true },
  { key: 'account', label: 'Account', width: 240 },
  { key: 'template', label: 'Template', width: 190 },
  { key: 'household', label: 'Household', width: 150 },
  { key: 'value', label: 'Total value', width: 120, align: 'right' },
  { key: 'bucket', label: 'Worst bucket', width: 120 },
  { key: 'delta', label: 'Δpp', width: 80, align: 'right' },
  { key: 'unrealized', label: 'Unrealized G/L', width: 130, align: 'right' },
  { key: 'realized', label: 'Realized G/L YTD', width: 140, align: 'right' },
  { key: 'status', label: 'Status', width: 130 },
  { key: 'override', label: 'Override', width: 150 },
];

function columnDefaults(cols: ColumnDef[]): Record<string, number> {
  return Object.fromEntries(cols.map((c) => [c.key, c.width]));
}

const ACCOUNT_COL_DEFAULTS = columnDefaults(ACCOUNT_COLUMNS);

function useResizableColumns(storageKey: string, defaults: Record<string, number>) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return { ...defaults, ...(JSON.parse(saved) as Record<string, number>) };
    } catch {
      /* ignore malformed storage */
    }
    return defaults;
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(widths));
    } catch {
      /* ignore quota / disabled storage */
    }
  }, [storageKey, widths]);

  const startResize = useCallback(
    (key: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = widths[key] ?? defaults[key] ?? 120;
      const onMove = (ev: MouseEvent) => {
        const next = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX));
        setWidths((w) => ({ ...w, [key]: next }));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [widths, defaults],
  );

  const reset = useCallback(() => setWidths(defaults), [defaults]);
  const totalWidth = Object.values(widths).reduce((s, w) => s + w, 0);
  return { widths, startResize, reset, totalWidth };
}

/** A draggable column-resize grip pinned to the right edge of a header cell. */
function ColResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-[var(--blue-muted)]/50"
    />
  );
}

/** Shared resizable header row (colgroup + th + grips) for the drift tables. */
function ResizableHead({
  columns,
  widths,
  startResize,
}: {
  columns: ColumnDef[];
  widths: Record<string, number>;
  startResize: (key: string) => (e: React.MouseEvent) => void;
}) {
  return (
    <>
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} style={{ width: widths[c.key] }} />
        ))}
      </colgroup>
      <thead className="bg-[var(--bg-surface)]">
        <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
          {columns.map((c) => (
            <th
              key={c.key}
              className={`relative ${c.fixed ? 'px-3' : 'px-4'} py-2.5 font-medium ${c.align === 'right' ? 'text-right' : ''}`}
              aria-label={c.label || undefined}
            >
              <span className="block truncate pr-1">{c.label}</span>
              {!c.fixed && <ColResizeHandle onMouseDown={startResize(c.key)} />}
            </th>
          ))}
        </tr>
      </thead>
    </>
  );
}

interface AccountsViewProps {
  rows: AccountDriftHistoryRow[];
  expandedAccountId: string | null;
  detailRun: AccountDriftRunRow | null;
  detailLoading: boolean;
  detailError: string | null;
  onToggle: (row: AccountDriftHistoryRow) => void;
  isFiltered: boolean;
  totalRowCount: number;
  isTrader: boolean;
  onEditOverride: (row: AccountDriftHistoryRow) => void;
  onAcceptOverride: (row: AccountDriftHistoryRow, reason: DriftOverrideReason, note: string) => void;
}

function AccountsView({
  rows,
  expandedAccountId,
  detailRun,
  detailLoading,
  detailError,
  onToggle,
  isFiltered,
  totalRowCount,
  isTrader,
  onEditOverride,
  onAcceptOverride,
}: AccountsViewProps) {
  const { widths, startResize, reset, totalWidth } = useResizableColumns(
    'drift:accountsColWidths:v1',
    ACCOUNT_COL_DEFAULTS,
  );
  return (
    <div className="border border-[var(--border)] rounded-lg overflow-x-auto">
      {/* Fill the panel on wide screens (no dead space to the right), but never
          shrink below the summed column widths — the container scrolls instead.
          With table-layout:fixed, extra width is distributed across columns. */}
      <table className="text-sm" style={{ tableLayout: 'fixed', width: '100%', minWidth: totalWidth }}>
        <ResizableHead columns={ACCOUNT_COLUMNS} widths={widths} startResize={startResize} />
        <tbody>
          {rows.map((row) => (
            <AccountRow
              key={row.accountId}
              row={row}
              isExpanded={expandedAccountId === row.accountId}
              detailLoading={detailLoading}
              detailError={detailError}
              detailRun={detailRun}
              onToggle={() => onToggle(row)}
              isTrader={isTrader}
              onEditOverride={() => onEditOverride(row)}
              onAcceptOverride={(reason, note) => onAcceptOverride(row, reason, note)}
            />
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--bg-surface)] px-4 py-2 text-xs text-[var(--text-muted)]">
        <span>{isFiltered ? `Showing ${rows.length} of ${totalRowCount} accounts` : `${rows.length} accounts`}</span>
        <button type="button" onClick={reset} className="hover:text-[var(--text-primary)] hover:underline">
          Reset column widths
        </button>
      </div>
    </div>
  );
}

interface AccountRowProps {
  row: AccountDriftHistoryRow;
  isExpanded: boolean;
  detailLoading: boolean;
  detailError: string | null;
  detailRun: AccountDriftRunRow | null;
  onToggle: () => void;
  isTrader: boolean;
  onEditOverride: () => void;
  onAcceptOverride: (reason: DriftOverrideReason, note: string) => void;
}

function AccountRow({
  row,
  isExpanded,
  detailLoading,
  detailError,
  detailRun,
  onToggle,
  isTrader,
  onEditOverride,
  onAcceptOverride,
}: AccountRowProps) {
  // An overridden row is accepted: mute the out-of-tolerance tint so it reads
  // as resolved, not actionable.
  const toneRowClass = row.override
    ? 'opacity-70'
    : row.status === 'out'
      ? 'bg-[var(--drift-oot-bg)]/30'
      : row.status === 'uninvested'
        ? 'bg-[var(--blue-light)]/20'
        : '';
  return (
    <>
      <tr
        className={`border-t border-[var(--border)] cursor-pointer hover:bg-[var(--bg-surface)] ${toneRowClass} ${
          isExpanded ? 'bg-[var(--bg-surface)]' : ''
        }`}
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <td className="px-3 py-3 text-[var(--text-muted)]">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </td>
        <td className="px-4 py-3 text-[var(--text-primary)]">
          <div className="flex flex-col">
            <span>{truncTitle(row.accountTitle)}</span>
            <span className="text-[11px] font-mono tracking-tight text-[var(--text-muted)] break-all">
              {row.accountId}
            </span>
            <AccountFlags row={row} />
          </div>
        </td>
        <td className="px-4 py-3 align-top">
          {row.templateName ? (
            <span className="block max-w-[15rem] text-xs text-[var(--text-secondary)] break-words">
              {row.templateName}
            </span>
          ) : (
            <span className="text-xs text-[var(--text-muted)]">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-[var(--text-secondary)]">{row.householdName || 'unmapped'}</td>
        <td className="px-4 py-3 text-[var(--text-secondary)] tabular-nums text-right">
          {formatUsd(row.totalValueUsd)}
        </td>
        <td className="px-4 py-3">
          <BucketPill bucket={row.worstBucket} emphasised={row.status === 'out'} />
        </td>
        <td
          className={`px-4 py-3 tabular-nums text-right ${
            row.status === 'out' ? 'text-[var(--text-primary)] font-semibold' : 'text-[var(--text-secondary)]'
          }`}
        >
          {row.maxBucketDeltaPct === null ? '—' : row.maxBucketDeltaPct.toFixed(2)}
        </td>
        <td className="px-4 py-3 text-right">
          <SignedUsdCell value={row.unrealizedGainUsd} />
        </td>
        <td className="px-4 py-3 text-right">
          <SignedUsdCell value={row.realizedGainYtdUsd} />
        </td>
        <td className="px-4 py-3">
          <StatusPill status={row.status} />
        </td>
        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <OverrideCell row={row} isTrader={isTrader} onEdit={onEditOverride} onAccept={onAcceptOverride} />
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-[var(--bg-surface)] border-t border-[var(--border)]">
          <td colSpan={11} className="px-6 py-4">
            <ExpandedDetail row={row} detailLoading={detailLoading} detailError={detailError} detailRun={detailRun} />
          </td>
        </tr>
      )}
    </>
  );
}

interface ExpandedDetailProps {
  row: AccountDriftHistoryRow;
  detailLoading: boolean;
  detailError: string | null;
  detailRun: AccountDriftRunRow | null;
}

function ExpandedDetail({ row, detailLoading, detailError, detailRun }: ExpandedDetailProps) {
  if (detailLoading) {
    return <div className="text-xs text-[var(--text-muted)]">Loading detail…</div>;
  }
  if (detailError) {
    return <div className="text-xs text-red-600 dark:text-red-400">{detailError}</div>;
  }
  if (!detailRun || detailRun.accountId !== row.accountId) {
    return <div className="text-xs text-[var(--text-muted)]">Detail not available.</div>;
  }

  const parsed = accountDriftDetailsSchema.safeParse(detailRun.details);
  if (!parsed.success) {
    return <div className="text-xs text-[var(--text-muted)]">Detail payload could not be decoded.</div>;
  }
  const details = parsed.data;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">Per-bucket comparison</h3>
        <BucketComparisonTable buckets={details.buckets} />
      </div>

      {details.tax && <TaxPanel tax={details.tax} />}

      {details.sectorAllocation && details.sectorAllocation.slices.length > 0 && (
        <SectorAllocationPanel allocation={details.sectorAllocation} />
      )}

      {details.symbolsWithTargets.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
            Per-symbol breakdown — cash &amp; fixed
          </h3>
          <SymbolBreakdownTable symbols={details.symbolsWithTargets} />
        </div>
      )}

      {details.equityHoldings.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
            Equity holdings (rolled up to bucket)
          </h3>
          <EquityHoldingsTable holdings={details.equityHoldings} />
        </div>
      )}

      {details.suspectedCashEquivMisclassified.length > 0 && (
        <small className="block text-xs text-[var(--text-muted)] italic">
          Audit: {details.suspectedCashEquivMisclassified.join(', ')} look like money-market funds but were routed to
          equity (not in INSTRUMENTS).
        </small>
      )}
    </div>
  );
}

interface BucketComparisonProps {
  buckets: {
    cash: { positionPct: number; templatePct: number; deltaPct: number };
    fixed: { positionPct: number; templatePct: number; deltaPct: number };
    equity: { positionPct: number; templatePct: number; deltaPct: number };
  };
}

const TOLERANCE_PCT_RENDER = 5;

function BucketComparisonTable({ buckets }: BucketComparisonProps) {
  const rows: Array<{ name: 'cash' | 'fixed' | 'equity'; data: BucketComparisonProps['buckets']['cash'] }> = [
    { name: 'cash', data: buckets.cash },
    { name: 'fixed', data: buckets.fixed },
    { name: 'equity', data: buckets.equity },
  ];
  return (
    <table className="w-full text-sm">
      <thead className="bg-[var(--bg-surface)]">
        <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
          <th className="px-3 py-2 font-medium">Bucket</th>
          <th className="px-3 py-2 font-medium text-right">Position %</th>
          <th className="px-3 py-2 font-medium text-right">Template %</th>
          <th className="px-3 py-2 font-medium text-right">Δpp</th>
          <th className="px-3 py-2 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ name, data }) => {
          const ok = data.deltaPct <= TOLERANCE_PCT_RENDER;
          return (
            <tr key={name} className="border-t border-[var(--border)]">
              <td className="px-3 py-2 text-[var(--text-primary)]">{BUCKET_LABEL[name]}</td>
              <td className="px-3 py-2 text-[var(--text-secondary)] tabular-nums text-right">
                {formatPct(data.positionPct)}
              </td>
              <td className="px-3 py-2 text-[var(--text-secondary)] tabular-nums text-right">
                {formatPct(data.templatePct)}
              </td>
              <td
                className={`px-3 py-2 tabular-nums text-right ${
                  ok ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)] font-semibold'
                }`}
              >
                {data.deltaPct.toFixed(2)}
              </td>
              <td className="px-3 py-2">
                <ToleranceBadge ok={ok} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface SymbolDetail {
  symbol: string;
  bucket: 'cash' | 'fixed' | 'equity';
  positionPct: number;
  targetPct?: number;
  deltaPct?: number;
  breach?: boolean;
}

function SymbolBreakdownTable({ symbols }: { symbols: SymbolDetail[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-[var(--bg-surface)]">
        <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
          <th className="px-3 py-2 font-medium">Symbol</th>
          <th className="px-3 py-2 font-medium">Bucket</th>
          <th className="px-3 py-2 font-medium text-right">Position %</th>
          <th className="px-3 py-2 font-medium text-right">Target %</th>
          <th className="px-3 py-2 font-medium text-right">Δpp</th>
          <th className="px-3 py-2 font-medium">Status</th>
        </tr>
      </thead>
      <tbody>
        {symbols.map((s) => {
          const target = s.targetPct ?? 0;
          const delta = s.deltaPct ?? Math.abs(s.positionPct - target);
          const ok = delta <= TOLERANCE_PCT_RENDER;
          const label = s.symbol === '__SETTLEMENT_CASH__' ? 'Settlement cash' : s.symbol;
          return (
            <tr key={s.symbol} className="border-t border-[var(--border)]">
              <td className="px-3 py-2 text-[var(--text-primary)]">{label}</td>
              <td className="px-3 py-2 text-[var(--text-secondary)]">{BUCKET_LABEL[s.bucket]}</td>
              <td className="px-3 py-2 text-[var(--text-secondary)] tabular-nums text-right">
                {formatPct(s.positionPct)}
              </td>
              <td className="px-3 py-2 text-[var(--text-secondary)] tabular-nums text-right">{formatPct(target)}</td>
              <td
                className={`px-3 py-2 tabular-nums text-right ${
                  ok ? 'text-[var(--text-secondary)]' : 'text-[var(--text-primary)] font-semibold'
                }`}
              >
                {delta.toFixed(2)}
              </td>
              <td className="px-3 py-2">
                <ToleranceBadge ok={ok} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EquityHoldingsTable({ holdings }: { holdings: Array<{ symbol: string; positionPct: number }> }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-[var(--bg-surface)]">
        <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
          <th className="px-3 py-2 font-medium">Symbol</th>
          <th className="px-3 py-2 font-medium text-right">Position %</th>
        </tr>
      </thead>
      <tbody>
        {holdings.map((h) => (
          <tr key={h.symbol} className="border-t border-[var(--border)]">
            <td className="px-3 py-2 text-[var(--text-primary)]">{h.symbol}</td>
            <td className="px-3 py-2 text-[var(--text-secondary)] tabular-nums text-right">
              {formatPct(h.positionPct)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface HouseholdsViewProps {
  groups: HouseholdGroup[];
  expandedAccountId: string | null;
  detailRun: AccountDriftRunRow | null;
  detailLoading: boolean;
  detailError: string | null;
  onToggle: (row: AccountDriftHistoryRow) => void;
}

function HouseholdsView({
  groups,
  expandedAccountId,
  detailRun,
  detailLoading,
  detailError,
  onToggle,
}: HouseholdsViewProps) {
  // All household cards render collapsed on mount; the headline pill still
  // tells the user whether the group has out/uninvested accounts, and a
  // click opens it. This swaps the previous "auto-expand on issue" behavior
  // so a busy run doesn't dump 100+ rows on the user.
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <HouseholdCard
          key={group.household}
          group={group}
          defaultOpen={false}
          expandedAccountId={expandedAccountId}
          detailRun={detailRun}
          detailLoading={detailLoading}
          detailError={detailError}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

interface HouseholdCardProps {
  group: HouseholdGroup;
  defaultOpen: boolean;
  expandedAccountId: string | null;
  detailRun: AccountDriftRunRow | null;
  detailLoading: boolean;
  detailError: string | null;
  onToggle: (row: AccountDriftHistoryRow) => void;
}

function HouseholdCard({
  group,
  defaultOpen,
  expandedAccountId,
  detailRun,
  detailLoading,
  detailError,
  onToggle,
}: HouseholdCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const hasIssue = group.outCount > 0 || group.uninvestedCount > 0;
  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 bg-[var(--bg-surface)] hover:bg-[var(--bg-surface-hover)] transition-colors"
      >
        <div className="flex items-center gap-2 text-left">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="font-medium text-[var(--text-primary)]">{group.household}</span>
          <span className="text-xs text-[var(--text-muted)]">{formatUsd(group.totalValue)}</span>
        </div>
        <span
          className={`px-2.5 py-0.5 rounded-md text-[11px] font-semibold ${
            hasIssue ? 'text-[var(--yellow)] bg-[var(--yellow-light)]' : 'text-[var(--green)] bg-[var(--green-light)]'
          }`}
        >
          {hasIssue
            ? `${group.outCount} of ${group.accounts.length} out · max ${group.worstDelta.toFixed(2)}pp`
            : `All in tolerance · ${group.accounts.length} acct`}
        </span>
      </button>
      {open && (
        <table className="w-full text-sm">
          <thead className="bg-[var(--bg-surface)]">
            <tr className="text-left text-xs uppercase tracking-wide text-[var(--text-muted)]">
              <th className="px-3 py-2.5 font-medium w-8" aria-label="Expand row" />
              <th className="px-4 py-2.5 font-medium">Account</th>
              <th className="px-4 py-2.5 font-medium">Template</th>
              <th className="px-4 py-2.5 font-medium text-right">Total value</th>
              <th className="px-4 py-2.5 font-medium">Worst bucket</th>
              <th className="px-4 py-2.5 font-medium text-right">Δpp</th>
              <th className="px-4 py-2.5 font-medium text-right">Unrealized G/L</th>
              <th className="px-4 py-2.5 font-medium text-right">Realized G/L YTD</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {group.accounts.map((row) => (
              <HouseholdAccountRow
                key={row.accountId}
                row={row}
                isExpanded={expandedAccountId === row.accountId}
                detailLoading={detailLoading}
                detailError={detailError}
                detailRun={detailRun}
                onToggle={() => onToggle(row)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface HouseholdAccountRowProps {
  row: AccountDriftHistoryRow;
  isExpanded: boolean;
  detailLoading: boolean;
  detailError: string | null;
  detailRun: AccountDriftRunRow | null;
  onToggle: () => void;
}

function HouseholdAccountRow({
  row,
  isExpanded,
  detailLoading,
  detailError,
  detailRun,
  onToggle,
}: HouseholdAccountRowProps) {
  const toneRowClass =
    row.status === 'out'
      ? 'bg-[var(--drift-oot-bg)]/30'
      : row.status === 'uninvested'
        ? 'bg-[var(--blue-light)]/20'
        : '';
  return (
    <>
      <tr
        className={`border-t border-[var(--border)] cursor-pointer hover:bg-[var(--bg-surface)] ${toneRowClass} ${
          isExpanded ? 'bg-[var(--bg-surface)]' : ''
        }`}
        onClick={onToggle}
        aria-expanded={isExpanded}
      >
        <td className="px-3 py-3 text-[var(--text-muted)]">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </td>
        <td className="px-4 py-3 text-[var(--text-primary)]">
          <div className="flex flex-col">
            <span>{truncTitle(row.accountTitle)}</span>
            <span className="text-[11px] font-mono tracking-tight text-[var(--text-muted)] break-all">
              {row.accountId}
            </span>
            <AccountFlags row={row} />
          </div>
        </td>
        <td className="px-4 py-3 align-top">
          {row.templateName ? (
            <span className="block max-w-[15rem] text-xs text-[var(--text-secondary)] break-words">
              {row.templateName}
            </span>
          ) : (
            <span className="text-xs text-[var(--text-muted)]">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-[var(--text-secondary)] tabular-nums text-right">
          {formatUsd(row.totalValueUsd)}
        </td>
        <td className="px-4 py-3">
          <BucketPill bucket={row.worstBucket} emphasised={row.status === 'out'} />
        </td>
        <td
          className={`px-4 py-3 tabular-nums text-right ${
            row.status === 'out' ? 'text-[var(--text-primary)] font-semibold' : 'text-[var(--text-secondary)]'
          }`}
        >
          {row.maxBucketDeltaPct === null ? '—' : row.maxBucketDeltaPct.toFixed(2)}
        </td>
        <td className="px-4 py-3 text-right">
          <SignedUsdCell value={row.unrealizedGainUsd} />
        </td>
        <td className="px-4 py-3 text-right">
          <SignedUsdCell value={row.realizedGainYtdUsd} />
        </td>
        <td className="px-4 py-3">
          <StatusPill status={row.status} />
        </td>
      </tr>
      {isExpanded && (
        <tr className="bg-[var(--bg-surface)] border-t border-[var(--border)]">
          <td colSpan={9} className="px-6 py-4">
            <ExpandedDetail row={row} detailLoading={detailLoading} detailError={detailError} detailRun={detailRun} />
          </td>
        </tr>
      )}
    </>
  );
}
