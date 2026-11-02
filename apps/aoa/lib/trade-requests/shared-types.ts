// Ported verbatim from trade-request shared/src/types.ts (lines 3, 136-155, 525-821) for ticket.
export type AccountType = 'Taxable' | 'Joint' | 'Traditional IRA' | 'Roth IRA';

export interface Holdings {
  cash: number;
  fixed: number;
  equity: number;
}

export interface Account {
  id: string;
  clientId: string;
  accountNumber: string;
  accountType: AccountType;
  balance: number;
  holdings: Holdings;
}

export interface Client {
  id: string;
  name: string;
  accounts: Account[];
}

// ─── Registry drift (nightly job → dashboard) ───────────────────────────────

export type DriftCoverageStatus = 'full' | 'partial' | 'engine_only' | 'meridian_only' | 'unmapped_account';

export type DriftAllowListReason = 'awaiting_mirror_mode' | 'awaiting_within_type_spread' | 'awaiting_per_account_risk';

export interface DriftHistoryRow {
  /** Local calendar date in `YYYY-MM-DD` (America/New_York). */
  runDateLocal: string;
  householdName: string;
  /** Decimal fraction (e.g. 0.0741 == 7.41%). */
  maxDeltaPct: number;
  breach: boolean;
  coverageStatus: DriftCoverageStatus;
  schemaVersion: number;
  /** e.g. 'gcs'. */
  snapshotSource: string;
  /** ISO 8601 timestamp from `registry_drift_runs.snapshot_as_of`, or null. */
  snapshotAsOf: string | null;
}

export interface DriftAllowListEntry {
  householdName: string;
  reason: DriftAllowListReason;
  /** Path to the plan whose merge removes this entry. */
  unblocksWhenPlanShips: string;
  /** Mandatory free-text rationale; never blank. */
  notes: string;
}

/**
 * Drill-down per-row payload returned by `GET /api/drift/runs/:date/:household`.
 * `details` is the JSONB blob persisted by `registryDriftRunner.ts:111-117`
 * (`{accountCount, worstSymbol, accounts, source?}`); the wire contract treats
 * it as `unknown` so the route is decoupled from the runner's internal shape.
 */
export interface DriftRunDetail extends DriftHistoryRow {
  /** ISO 8601 from `registry_drift_runs.run_started_at`. */
  runStartedAt: string;
  accountCount: number;
  details: unknown;
}

// ─── Drift v2 (per-account) ─────────────────────────────────────────────────
//
// Wire shape for `position_drift_accounts` — the v2 dashboard surface.
// `maxBucketDeltaPct` is percent-scale (0..100), NOT the v1 decimal
// fraction; renderers MUST NOT multiply by 100 (B3 fix). See
// `docs/plans/2026-q3-drift-v2-accounts.md` §4.5.

/**
 * `no_template` (added 2026-05) is set when an account has positions + a
 * household match but the Meridian snapshot carries no allocation target
 * for it. The comparator emits `maxBucketDeltaPct = null` / `worstBucket =
 * null` for these rows rather than synthesizing 0/0/0 targets that would
 * falsely flag every position-only account as out-of-tolerance.
 *
 * `negligible` and `template_invalid` (added 2026-06) are non-actionable
 * data-quality lanes from the drift-checker tuning rules:
 *   - `negligible`       — total account value <= $5 (incl. residual dust);
 *     drift is meaningless at this size (rule R1).
 *   - `template_invalid` — the Meridian template weights don't sum to ~100%
 *     (outside a 99–101% band), so the drift denominator is wrong (rule R2).
 *     `maxBucketDeltaPct` is still populated (the magnitude is inspectable)
 *     but the row is routed to a data-quality view, not the action list.
 * `out` remains the ONLY actionable status — consumers that count
 * out-of-tolerance accounts key on it, so these lanes are excluded by design.
 */
export type AccountDriftStatus = 'in' | 'out' | 'uninvested' | 'no_template' | 'negligible' | 'template_invalid';

export type AccountDriftCoverage = 'both' | 'positions_only' | 'template_only' | 'unmapped';

export interface AccountDriftHistoryRow {
  /** Local calendar date in `YYYY-MM-DD` (America/New_York). */
  runDateLocal: string;
  /** Apex ULID (26 chars). */
  accountId: string;
  /** From the Meridian snapshot row's `account_title` column; '' when missing. */
  accountTitle: string;
  /** Household name from `households.json`; '' when unmapped. */
  householdName: string;
  status: AccountDriftStatus;
  worstBucket: 'cash' | 'fixed' | 'equity' | null;
  /**
   * Percent-scale (0..100) — DO NOT multiply by 100 when rendering.
   * `null` ONLY for `status === 'no_template'` rows (no allocation target
   * to measure against). Renderers display an em-dash in that case.
   */
  maxBucketDeltaPct: number | null;
  symbolBreachCount: number;
  totalValueUsd: number;
  coverage: AccountDriftCoverage;
  snapshotSource: string;
  snapshotAsOf: string | null;
  schemaVersion: number;
  // ─── Cost-basis tax layer (optional — present once the cost-basis feed is
  // wired; extracted from `details.tax` so the table can render without the
  // full detail payload). All null/absent when the feed is unconfigured. ───
  /** Account-level unrealized gain in USD (signed). */
  unrealizedGainUsd?: number | null;
  /** Realized capital gains YTD in USD (signed) — the gain budget consumed. */
  realizedGainYtdUsd?: number | null;
  /** Share of the account that is ACAT transfer-in (0..100). */
  transferInPct?: number | null;
  /** Meridian template/model name the account is compared against (null for no_template). */
  templateName?: string | null;
  /**
   * Sum of the template's symbol weights (healthy ≈ 100). When Meridian
   * ships a malformed template (e.g. 72%), bucket deltas are distorted — the
   * UI flags any row where this strays from 100 so "drift" caused by a bad
   * template isn't mistaken for real allocation drift. Null for no_template.
   */
  templateTotalPct?: number | null;
  /**
   * Whether the account is taxable (from the tax layer). Tax-driven override
   * suggestions (tax constraint / tax transition) are gated on this — they
   * don't apply to IRAs/Roths. Null/absent when the tax layer is unconfigured.
   */
  taxable?: boolean | null;
  /** Taxable, no-template, mostly transfer-in → likely tax-transition candidate (heuristic). */
  transitionCandidate?: boolean;
  /** Taxable account with an ACTIVE transition confirmed by the Meridian feed. */
  transitionConfirmed?: boolean;
  /** Run-level cost-basis freshness (denormalized onto each row of a run). */
  costBasisFreshness?: CostBasisFreshnessSummary | null;
  /**
   * Active, non-expired manual status override for this account (sticky across
   * runs; set by a trader). Null/absent when none applies. The computed
   * `status` above is left untouched — consumers apply this for display and to
   * exclude the account from the actionable out-of-tolerance count.
   */
  override?: AccountDriftOverride | null;
}

// ─── Manual drift-status overrides (human-judgment acceptance) ──────────────

/**
 * Why a trader accepted an out-of-tolerance account — the false-positive
 * drivers from the drift-checker tuning sheet. `other` carries a free-text
 * explanation in the note. Keep in lockstep with the CHECK constraint in
 * `migrations/..._drift-status-overrides.sql`.
 */
export type DriftOverrideReason =
  | 'asset_location'
  | 'tax_constraint'
  | 'active_transition'
  | 'intentional_cash'
  | 'concentrated_position'
  | 'template_error'
  | 'direct_index_noise'
  | 'other';

export interface AccountDriftOverride {
  reason: DriftOverrideReason;
  /** Free-text note / explanation (required for `other`, optional otherwise). */
  note: string;
  /** ISO date (YYYY-MM-DD) the override stops applying; null = no expiry. */
  expiresOn: string | null;
  /** Display name of the trader who set it (audit). */
  setByName: string;
  /** ISO timestamp the override was last set/updated. */
  setAt: string;
}

// ─── Cost-basis tax enrichment (drift tax layer) ────────────────────────────

export type CostBasisFreshnessLevel = 'ok' | 'warn' | 'critical' | 'missing';

/** Run-level staleness of the two Apex cost-basis tables. */
export interface CostBasisFreshnessSummary {
  /** Worst of the content (process_date) and pipeline (gluerundatetime) signals. */
  level: CostBasisFreshnessLevel;
  fullProcessDate: string | null;
  fullAgeDays: number | null;
  dailyProcessDate: string | null;
  dailyAgeDays: number | null;
  pipelineLatest: string | null;
  pipelineAgeDays: number | null;
  /** Human-readable one-liner for the banner. */
  message: string;
}

/** Per-symbol tax detail shown in the expanded drift row. */
export interface SymbolTaxDetail {
  symbol: string;
  marketValueUsd: number;
  costBasisUsd: number;
  unrealizedGainUsd: number;
  unrealizedShortTermGainUsd: number;
  unrealizedLongTermGainUsd: number;
  /** Share of this symbol's value that is ACAT transfer-in (0..100). */
  transferInPct: number;
  hasMissingBasis: boolean;
}

/** Account-level tax rollup persisted into `position_drift_accounts.details.tax`. */
export interface AccountTaxSummary {
  /** Investable market value (positions ex-settlement-cash), USD. */
  investableValueUsd: number;
  /** Share of investable value accounted for by cost basis or NAV (0..100). */
  basisCoveragePct: number;
  /**
   * Market value in cash equivalents (money-market funds), USD — carried at
   * $1.00 NAV, so it counts as covered and contributes $0 unrealized gain.
   * Optional: absent on rows persisted before the cash-equivalent layer.
   */
  cashEquivalentValueUsd?: number;
  unrealizedGainUsd: number;
  unrealizedShortTermGainUsd: number;
  unrealizedLongTermGainUsd: number;
  transferInValueUsd: number;
  transferInPct: number;
  hasMissingBasis: boolean;
  /**
   * True when the account is taxable (authoritative ownership type, falling
   * back to the account-type heuristic). Tax-driven acceptances — embedded-gain
   * tax constraints and tax transitions — only make sense here; an IRA/Roth
   * realizes no capital gains on sale, so it can always be rebalanced freely.
   */
  taxable?: boolean;
  /** Taxable + no template + mostly transfer-in → likely tax-transition candidate (heuristic). */
  transitionCandidate: boolean;
  // ─── Transition CONFIRMED by the Meridian transitions feed (vs the heuristic
  // candidate above). Catches accounts the heuristic misses — e.g. a templated
  // account actively being transitioned. Optional — absent when the feed is
  // unconfigured or has no transition for the account. ───
  /** True when the transitions feed has an active transition for this account. */
  transitionConfirmed?: boolean;
  /** Target model/template name from the transition (e.g. "Risk 18 URTH Russell"). */
  transitionTargetName?: string | null;
  /** Estimated realized gain to fully transition (source_pnl.net_pnl), USD. */
  transitionEstRealizedGainUsd?: number | null;
  /** ISO timestamp of the latest transition record for this account. */
  transitionUpdatedAt?: string | null;
  // ─── Realized capital gains, year-to-date (the gain "budget" consumed). From
  // the closed-lot feed. Optional — absent on rows that predate the realized
  // layer or when the realized query is unavailable. ───
  realizedGainYtdUsd?: number;
  realizedShortTermYtdUsd?: number;
  realizedLongTermYtdUsd?: number;
  /** Top positions by |unrealized gain|, pre-sorted. */
  symbols: SymbolTaxDetail[];
}

export interface AccountDriftRunRow extends AccountDriftHistoryRow {
  /**
   * JSONB blob persisted by `positionDriftAccountsPersistence.persistAccountDriftRows`.
   * Treated as `unknown` here so the route is decoupled from the runner's
   * internal shape; the client zod-validates before consuming.
   */
  details: unknown;
}

export interface AccountDriftRunDetail {
  runDateLocal: string;
  /** ISO 8601 from `position_drift_accounts.run_started_at`. */
  runStartedAt: string;
  snapshotSource: string;
  snapshotAsOf: string | null;
  /** Tolerance in effect for this run (percent-scale). */
  tolerancePct: number;
  uninvestedCashThresholdPct: number;
  accounts: AccountDriftRunRow[];
}

export type ExclusionOverlapLockClass =
  'actionable' | 'locked_blanket' | 'locked_dnb_under' | 'locked_dns_over' | 'sign_mismatch_unlocked';

export interface ExclusionOverlapCounts {
  actionable: number;
  locked_blanket: number;
  locked_dnb_under: number;
  locked_dns_over: number;
  sign_mismatch_unlocked: number;
}

export interface ExclusionOverlapAccountSummary {
  accountId: string;
  accountTitle: string;
  household: string;
  status: AccountDriftStatus;
  maxDelta: number | null;
  breachCount: number;
  lockedCount: number;
}

export interface ExclusionOverlapReport {
  runDateLocal: string;
  totalAccounts: number;
  outAccounts: number;
  totalExclusions: number;
  totalBreaches: number;
  lockedTotal: number;
  lockedSharePct: number;
  counts: ExclusionOverlapCounts;
  worstAccounts: ExclusionOverlapAccountSummary[];
}
