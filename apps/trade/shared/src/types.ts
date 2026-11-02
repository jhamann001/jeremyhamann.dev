// ─── Enums & Literals ────────────────────────────────────────────────────────

export type AccountType = 'Taxable' | 'Joint' | 'Traditional IRA' | 'Roth IRA';

export type AssetLocationMode = 'priority' | 'mirror';

export type UserRole = 'advisor' | 'trader';

export type ThemePreference = 'light' | 'dark' | 'system';

// ─── Auth / User ────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  /** Set after first Google sign-in; null for invited users who have not logged in yet. */
  googleId: string | null;
  email: string;
  name: string;
  picture: string | null;
  role: UserRole;
  slackUserId: string | null;
  themePreference: ThemePreference;
  isActive: boolean;
  lastLogin: string | null;
  createdAt: string;
}

export type TradeType = 'Initial Funding' | 'Rebalance' | 'Cash Deposit' | 'Raise Cash' | 'Liquidate';

export type RequestStatus =
  'Pending Review' | 'Needs Info' | 'Pending Current Asset Liquidation' | 'Approved' | 'Rejected' | 'Completed';

export type Residence = 'NY' | 'CA' | 'Other';

// ─── Pre-approval checklist ─────────────────────────────────────────────────
// A fixed set of items a trader confirms before approving & executing a trade
// request. Shared so client (render) and server (validate) agree on the keys.

export type ChecklistItemKey =
  | 'exclusions'
  | 'templates'
  | 'asset_location'
  | 'transition'
  | 'legacy_liquidation'
  | 'residual_cash'
  | 'advisor_tickers';

export interface ChecklistItemDef {
  key: ChecklistItemKey;
  label: string;
  help: string;
  /** When true, a text field accompanies the checkbox (capture-only). */
  hasField?: boolean;
  fieldLabel?: string;
  fieldPlaceholder?: string;
}

export const PREAPPROVAL_CHECKLIST_ITEMS: readonly ChecklistItemDef[] = [
  {
    key: 'exclusions',
    label: 'Exclusions & restrictions applied (DNB / DNS)',
    help: 'Client- and advisor-level no-buy / no-sell restrictions reflected in the orders.',
  },
  {
    key: 'templates',
    label: 'Meridian templates created for all accounts',
    help: 'Every account in the request has a target model.',
    hasField: true,
    fieldLabel: 'Template name(s)',
    fieldPlaceholder: 'e.g., National Tax Efficient – Risk 20',
  },
  {
    key: 'asset_location',
    label: 'Asset location completed',
    help: 'Tax-ideal sleeve placement set at the household level.',
  },
  {
    key: 'transition',
    label: 'Transition used',
    help: '',
    hasField: true,
    fieldLabel: 'Transition model',
    fieldPlaceholder: 'e.g., National Tax Efficient – Risk 20',
  },
  {
    key: 'legacy_liquidation',
    label: 'Legacy / ACAT positions liquidated',
    help: "Transferred-in holdings that aren't on the model sold to fund the target templates.",
  },
  {
    key: 'residual_cash',
    label: 'Residual cash trades placed',
    help: 'Leftover settlement cash swept into the model.',
  },
  {
    key: 'advisor_tickers',
    label: 'Advisor-instructed tickers traded',
    help: '',
    hasField: true,
    fieldLabel: 'Tickers / instructions',
    fieldPlaceholder: 'e.g., sold legacy AAPL per advisor note…',
  },
];

export const CHECKLIST_ITEM_KEYS: readonly ChecklistItemKey[] = PREAPPROVAL_CHECKLIST_ITEMS.map((i) => i.key);

export interface ChecklistItemState {
  checked: boolean;
  /** Free-text value for items with `hasField` (template/transition/tickers). */
  value?: string;
  /** Display name of who last set this item (audit). */
  by?: string | null;
  /** ISO timestamp of the last change (audit). */
  at?: string | null;
}

/** Per-request checklist state, keyed by item. Items absent until first touched. */
export type PreapprovalChecklist = Partial<Record<ChecklistItemKey, ChecklistItemState>>;

export const ALLOCATION_TRADE_TYPES: TradeType[] = ['Initial Funding', 'Rebalance', 'Cash Deposit'];

export const AMOUNT_TRADE_TYPES: TradeType[] = ['Cash Deposit', 'Raise Cash', 'Liquidate'];

export type Priority = 'Urgent' | 'Standard' | 'Low';

export type LiquidateOption = 'Entire Account' | 'Specific Positions';

export interface LastAllocationData {
  riskProfile: number;
  baseAllocation: BaseAllocation;
  equityStrategies: EquityStrategy[];
}

// ─── Domain Models ───────────────────────────────────────────────────────────

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

export interface EsgFilters {
  fossilFuels: boolean;
  tobacco: boolean;
  weapons: boolean;
  alcohol: boolean;
  gambling: boolean;
  other: boolean;
  otherDescription: string;
  none: boolean;
}

export interface BaseAllocation {
  equity: number;
  fixed: number;
  cash: number;
}

export interface EquityStrategy {
  id: number;
  benchmark: string;
  allocation: number;
  rationale: string;
}

export interface AllocationComparisonInput {
  riskProfile: number;
  baseAllocation: BaseAllocation;
  equityStrategies: EquityStrategy[];
}

const ALLOCATION_COMPARE_TOLERANCE = 0.01;

function differsByTolerance(a: number, b: number): boolean {
  return Math.abs(a - b) > ALLOCATION_COMPARE_TOLERANCE;
}

function normalizeBenchmark(benchmark: string): string {
  return benchmark.trim().toLocaleLowerCase();
}

function hasDuplicateBenchmarks(strategies: EquityStrategy[]): boolean {
  const seen = new Set<string>();
  for (const strategy of strategies) {
    const normalized = normalizeBenchmark(strategy.benchmark);
    if (seen.has(normalized)) return true;
    seen.add(normalized);
  }
  return false;
}

function normalizeStrategyTuples(strategies: EquityStrategy[]): Array<{ benchmark: string; allocation: number }> {
  return strategies
    .map((strategy) => ({
      benchmark: normalizeBenchmark(strategy.benchmark),
      allocation: Number(strategy.allocation),
    }))
    .sort((a, b) => a.benchmark.localeCompare(b.benchmark) || a.allocation - b.allocation);
}

export function isMaterialAllocationChange(
  current: AllocationComparisonInput,
  previous: AllocationComparisonInput,
): boolean {
  if (current.riskProfile !== previous.riskProfile) return true;

  if (
    differsByTolerance(current.baseAllocation.equity, previous.baseAllocation.equity) ||
    differsByTolerance(current.baseAllocation.fixed, previous.baseAllocation.fixed) ||
    differsByTolerance(current.baseAllocation.cash, previous.baseAllocation.cash)
  ) {
    return true;
  }

  if (current.equityStrategies.length !== previous.equityStrategies.length) return true;

  const currentTuples = normalizeStrategyTuples(current.equityStrategies);
  const previousTuples = normalizeStrategyTuples(previous.equityStrategies);
  for (let i = 0; i < currentTuples.length; i++) {
    if (currentTuples[i].benchmark !== previousTuples[i].benchmark) return true;
    if (differsByTolerance(currentTuples[i].allocation, previousTuples[i].allocation)) return true;
  }

  // Duplicate benchmarks are only safe when the normalized benchmark/allocation tuple set is an exact match.
  if (hasDuplicateBenchmarks(current.equityStrategies) || hasDuplicateBenchmarks(previous.equityStrategies)) {
    return currentTuples.some(
      (tuple, index) =>
        tuple.benchmark !== previousTuples[index].benchmark ||
        differsByTolerance(tuple.allocation, previousTuples[index].allocation),
    );
  }

  return false;
}

export interface Trade {
  asset: string;
  type: 'Buy' | 'Sell';
  amount: number;
  rationale: string;
}

export interface CashDepositContext {
  depositAmount: number;
  depositAccountNumber: string;
  existingCash: number;
  availableCash: number;
  targetCash: number;
  cashToDeploy: number;
}

export interface SleeveInstruction {
  sleeve: 'cash' | 'fixed' | 'equity';
  current: number;
  target: number;
  delta: number;
  source?: 'existing_holdings' | 'new_usd_deposit' | 'mixed';
  rationale: string;
}

export interface VarianceAnalysis {
  preTrade: Holdings;
  postTrade: Holdings;
}

export interface AccountExecutionPlan {
  accountNumber: string;
  accountType: AccountType;
  accountValue: number;
  templateName: string;
  modelName: string;
  postTradeHoldings: Holdings;
  trades: Trade[];
  cashDepositContext?: CashDepositContext;
  sleeveInstructions?: SleeveInstruction[];
  varianceAnalysis?: VarianceAnalysis;
  /**
   * Whether this account is being traded now (`execute` — the selected
   * accounts) or is an already-invested same-mandate sibling whose moves are
   * shown as a recommendation only (`recommend` — fixed context, never
   * auto-traded). Absent ⇒ `execute` (the default, single-set behavior).
   */
  action?: 'execute' | 'recommend';
}

export type ValidationIssueKind =
  | 'aggregate_drift'
  | 'account_capacity'
  | 'negative_allocation'
  // Household target can't be reached by trading only the selected accounts
  // (a fixed-context sibling is over/under a class); the recommended sibling
  // trades are required to close the gap.
  | 'household_off_target_without_recommend';

export interface ValidationIssue {
  kind: ValidationIssueKind;
  sleeve?: 'cash' | 'fixed' | 'equity';
  accountNumber?: string;
  expected: number;
  actual: number;
  drift: number;
  driftPct: number;
  message: string;
}

export interface ValidationResult {
  passed: boolean;
  issues: ValidationIssue[];
  tolerances: { aggregate: number; account: number; negative: number };
}

export interface EngineResult {
  plans: AccountExecutionPlan[];
  validation: ValidationResult;
}

export interface AuditEntry {
  id?: string;
  date: string;
  user: string;
  action: string;
  notes: string;
  /** Interface the entry was made through: the standalone app or OPS_PORTAL's delegated surface. */
  channel: AuthChannel;
}

export interface TradeRequest {
  id: string;
  clientId: string;
  clientName: string;
  clientIds: string[];
  clientNames: string[];
  /** Client's advisor of record (currently forced to Rachel Moss for all records). */
  advisor: string;
  /**
   * Name of the user who actually submitted this request. May differ from
   * `advisor` when an ops user (e.g. trade desk) submits on the advisor's
   * behalf. Falls back to `advisor` for legacy records that predate the
   * submitter/advisor split.
   */
  submittedBy: string;
  tradeType: TradeType;
  tradeAmount: string;
  depositAccount: string;
  rebalanceAll: boolean;
  status: RequestStatus;
  date: string;
  updatedAt: string;
  selectedAccounts: string[];
  totalValue: number;
  priority: Priority | '';
  advisorNotes: string;
  residence: Residence;
  liquidationApproval: 'Yes' | 'No' | '';
  advisorExclusions: string;
  clientExclusions: string;
  esgFilters: EsgFilters;
  riskProfile: number | null;
  baseAllocation: BaseAllocation;
  equityStrategies: EquityStrategy[];
  raiseCashReason: string;
  liquidityDeadline: string | null;
  liquidateOption: LiquidateOption | '';
  liquidatePositions: string;
  executionPlan: AccountExecutionPlan[];
  validation?: ValidationResult;
  accountMetadata?: Array<{
    /** Apex custodian_account_id / ULID. Null on legacy or manual rows. */
    accountId?: string | null;
    accountNumber: string;
    accountType: AccountType;
    balance: number;
  }>;
  assetLocationMode?: AssetLocationMode;
  /**
   * Firm-of-record household captured at submit time from Meridian's
   * `active_accounts.json` map. Null when the form's resolved selection
   * spans multiple firm households, when any selected account was
   * unmapped, or when the `active_accounts.json` loader was unavailable
   * (silent-fallback contract). Persisted from POST only — PUT MUST
   * NOT mutate either field. See
   * `docs/plans/2026-q2-trade-request-householding.md` §5.3 / Decision log #5.
   */
  householdId?: number | null;
  householdName?: string | null;
  auditLog: AuditEntry[];
}

export interface Notification {
  id: string;
  message: string;
  isRead: boolean;
  date: string;
  requestId?: string | null;
}

// ─── API Payloads ────────────────────────────────────────────────────────────

export interface CreateTradeRequestPayload {
  clientId: string;
  clientName: string;
  clientIds?: string[];
  clientNames?: string[];
  tradeType: TradeType;
  tradeAmount: string;
  depositAccount: string;
  rebalanceAll: boolean;
  selectedAccounts: string[];
  priority: Priority;
  advisorNotes: string;
  residence: Residence;
  liquidationApproval: 'Yes' | 'No' | '';
  advisorExclusions: string;
  clientExclusions: string;
  esgFilters: EsgFilters;
  riskProfile: number | null;
  equityStrategies: EquityStrategy[];
  raiseCashReason: string;
  liquidityDeadline: string | null;
  liquidateOption: LiquidateOption | '';
  liquidatePositions: string;
  accountsData?: Array<{ accountNumber: string; accountType: AccountType; balance: number }>;
  manualEntry?: boolean;
  manualAccounts?: Array<{ accountNumber: string; accountType: AccountType; balance: number }>;
  existingId?: string | null;
  isClone?: boolean;
  idempotencyKey?: string;
  assetLocationMode?: AssetLocationMode;
  /**
   * Resolved firm household from `active_accounts.json`. Sent by the form
   * iff every submitted account ULID belongs to one and the same household;
   * otherwise both fields are null. See
   * `docs/plans/2026-q2-trade-request-householding.md` §5.3 / Decision log #5.
   */
  householdId?: number | null;
  householdName?: string | null;
}

export interface UpdateStatusPayload {
  status: RequestStatus;
  note: string;
  expectedUpdatedAt?: string;
}

export interface RunEnginePayload {
  holdings: Record<string, Holdings>;
  expectedUpdatedAt?: string;
}

// ─── Client exclusions (per-client standing list) ──────────────────────────

export type ClientExclusionKind = 'advisor' | 'client';

export interface ClientExclusion {
  id: string;
  clientId: string;
  ticker: string;
  kind: ClientExclusionKind;
  reason: string;
  // v3.4: explicit DNB/DNS structure. Today's rows all backfill to true/true
  // (blanket), matching the pre-v3.4 implicit semantic. A row with both
  // false is rejected at three layers: Zod, the DB CHECK constraint, and
  // the modal's Apply-disabled rule.
  noBuy: boolean;
  noSell: boolean;
  createdByName: string;
  createdAt: string;
}

/**
 * One row of the firm-wide exclusions export — client-level and account-level
 * standing exclusions flattened into a single shape so they land in one file.
 *
 * `scope` distinguishes them: a `client` row applies to every account the
 * client holds, an `account` row only to `accountNumber`. IDs are always
 * populated (they're the stable join keys); the name fields are best-effort
 * enrichment from the cached Warehouse client list and come back empty when a
 * client or account is no longer in it.
 */
export interface ExclusionExportRow {
  scope: 'client' | 'account';
  /** Cedar Ridge client id. Populated for client rows, and for account rows when the ULID resolves. */
  clientId: string;
  clientName: string;
  /** Apex account ULID — account rows only. */
  accountId: string;
  /** Human-facing account number — account rows only, when the ULID resolves. */
  accountNumber: string;
  ticker: string;
  kind: ClientExclusionKind;
  reason: string;
  noBuy: boolean;
  noSell: boolean;
  createdByName: string;
  createdAt: string;
}

export interface CreateClientExclusionPayload {
  ticker: string;
  kind: ClientExclusionKind;
  reason: string;
  // Optional in v3.4 for per-row endpoint backward compat — both default to
  // true on the server when omitted (matches today's blanket behavior).
  // The batch endpoint requires both fields explicitly (no defaults) so
  // the modal can't accidentally stage a row with implicit semantics.
  noBuy?: boolean;
  noSell?: boolean;
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

// ─── Household resolution (firm-of-record from active_accounts.json) ───────
//
// All `*AccountId` fields below are Apex ULIDs (26 chars `[0-9A-Z]`), NOT
// the human-readable `Account.accountNumber` that the AdvisorForm's
// `selectedAccts` state carries. The form is responsible for translating
// between the two via `clientMap[clientId].accounts[]`. See
// `docs/plans/2026-q2-trade-request-householding.md` §3 (Identifier
// vocabulary) and Decision log #4.

export interface HouseholdResolutionAccount {
  /** Apex ULID — same value as Client.accounts[].id and Warehouse custodian_account_id. */
  accountId: string;
  /**
   * Human-readable custodian number — same value as Client.accounts[].accountNumber.
   * Carried alongside the ULID so the sidecar can render numbers in its
   * "Choose…" list and the form can splice them into `selectedAccts`
   * without an extra lookup. Null when no Warehouse row joins.
   */
  accountNumber: string | null;
  /** From active_accounts.json `account_title`. */
  accountTitle: string;
  /** Warehouse clientId; null if the account has no CRM owner. */
  clientId: string | null;
  /** From Warehouse if joined; null when unjoined. */
  accountType: AccountType | null;
  /** From Warehouse latest balance; 0 when unjoined. */
  balance: number;
}

export interface HouseholdResolution {
  householdId: number;
  householdName: string;
  /** Every account in the household, from the firm export. */
  accounts: HouseholdResolutionAccount[];
  /** Subset of `accounts` already covered by the advisor's current selection (ULIDs). */
  selectedAccountIds: string[];
  /**
   * Distinct client IDs in this household (back-resolved via Warehouse).
   * May be empty when an account has no matching Warehouse client row
   * (orphaned in Apex but not in the firm CRM).
   */
  clientIds: string[];
}

export interface HouseholdResolveResponse {
  households: HouseholdResolution[];
  /** Selected client IDs with NO account in active_accounts.json. */
  unresolvedClientIds: string[];
  /** Input account ULIDs with no row in active_accounts.json. */
  unresolvedAccountIds: string[];
}

// ─── Household pre-trade holdings (read-only sibling context) ──────────────
//
// Powers the collapsible "Other accounts in this household" panel under the
// trader's pre-trade holdings table. Selected accounts keep the live, editable
// `classified-holdings` path; non-selected siblings are read-only context
// enriched from the latest nightly drift run (current allocation + target +
// drift delta), which shares the daily Warehouse positions feed so it is no
// staler than a live pull within a trading day. All `*Pct` fields are
// percent-scale (0..100) and null when the sibling has no drift row.

/** One non-selected household account, enriched from the latest drift run. */
export interface HouseholdSiblingHolding {
  /** Apex ULID (26 chars). */
  accountId: string;
  /** Human-readable custodian number; null when no Warehouse row joins. */
  accountNumber: string | null;
  accountTitle: string;
  /** From Warehouse if joined; null when unjoined. */
  accountType: AccountType | null;
  /** Latest Warehouse balance; 0 when unjoined. */
  balance: number;
  /** Drift status for the account; null when there is no drift row. */
  status: AccountDriftStatus | null;
  /** Current allocation, percent-scale (0..100); null when no drift row. */
  positionCashPct: number | null;
  positionFixedPct: number | null;
  positionEquityPct: number | null;
  /** Template/target allocation, percent-scale; null for no_template / no row. */
  templateCashPct: number | null;
  templateFixedPct: number | null;
  templateEquityPct: number | null;
  /** Max bucket drift Δ vs target, percent-scale; null for no_template / no row. */
  maxBucketDeltaPct: number | null;
  worstBucket: 'cash' | 'fixed' | 'equity' | null;
  /** True when a drift row was found for this account in the latest run. */
  hasDrift: boolean;
}

export interface HouseholdHoldingsResponse {
  data: {
    siblings: HouseholdSiblingHolding[];
    /** Local run date (`YYYY-MM-DD`) of the drift snapshot the figures came from. */
    driftRunDate: string | null;
  };
  /** 'drift' = enriched from the run; 'demo'; 'unavailable' = silent fallback. */
  source: 'drift' | 'demo' | 'unavailable';
}

// ─── Engine Types ────────────────────────────────────────────────────────────

export type AllocationModel = 'Taxable National' | 'National Tax Efficient' | 'New York' | 'California';

export interface EngineInput {
  tradeType: TradeType;
  tradeAmount: string;
  depositAccountNumber: string;
  rebalanceAll: boolean;
  totalValue: number;
  baseAllocation: BaseAllocation;
  riskProfile: number;
  clientName: string;
  clientNameMap?: Record<string, string>;
  /** The accounts being traded now (the selected set). */
  accounts: Account[];
  /**
   * Already-invested same-mandate siblings held as FIXED context: counted
   * toward the household total and the ideal location, and tagged
   * `action: 'recommend'` (their current→ideal deltas are advisory, never
   * auto-traded). Accounts in `accounts` are tagged `action: 'execute'`.
   * Default empty ⇒ the engine runs over `accounts` alone, byte-identical to
   * prior behavior.
   */
  fixedContextAccounts?: Account[];
  equityStrategies: EquityStrategy[];
  residence: Residence;
  assetLocationMode?: AssetLocationMode;
}

// ─── The advisor platform delegated callers (TRW-01) ──────────────────────────────────────────

/** Roles of an advisor platform (OPS_PORTAL) user, as carried in OPS_PORTAL's signed actor assertion. */
export const OPS_PORTAL_ROLES = ['ADMIN', 'OPERATIONS', 'ADVISOR', 'CLIENT_SERVICE', 'VIEWER'] as const;

export type OpsPortalRole = (typeof OPS_PORTAL_ROLES)[number];

/** Which UI a request came through: the standalone app (session) or the advisor platform (delegated). */
export type AuthChannel = 'standalone' | 'opsPortal';

export function isOpsPortalRole(value: unknown): value is OpsPortalRole {
  return typeof value === 'string' && (OPS_PORTAL_ROLES as readonly string[]).includes(value);
}

/**
 * Owner ruling D1: ADMIN and OPERATIONS act as trader (reviewer), ADVISOR as
 * advisor (submitter); CLIENT_SERVICE and VIEWER have no Trade Request access.
 */
export function mapOpsPortalRole(role: OpsPortalRole): UserRole | null {
  if (role === 'ADMIN' || role === 'OPERATIONS') return 'trader';
  if (role === 'ADVISOR') return 'advisor';
  return null;
}
