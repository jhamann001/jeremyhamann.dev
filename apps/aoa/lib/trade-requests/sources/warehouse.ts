import { z } from 'zod';
import type { Client, Account, AccountType, Holdings } from '@/lib/trade-requests/shared-types';
import { classifySymbol, isCashEquivalentSymbol, type AssetCategory } from '@/lib/trade-requests/sources/data/instruments';
import { normalizeTicker } from '@/lib/trade-requests/sources/data/sic-to-sector';
import { getClassificationMap } from '@/lib/trade-requests/sources/security-sector';
import logger from '@/lib/trade-requests/log';
// `costBasisEnrichment.ts` imports `AccountPositions` from here as type-only,
// so the runtime dependency is one-way (warehouse → costBasisEnrichment) — no cycle.
import { mergeOpenLotRows } from '@/lib/trade-requests/sources/cost-basis-enrichment';
import type { OpenLot, RawLotRow } from '@/lib/trade-requests/sources/cost-basis-enrichment';
import { serviceFetch } from "@/lib/demo/stand-ins/fetch";

function env() {
  return {
    url: (process.env.WAREHOUSE_URL ?? '').replace(/\/+$/, ''),
    apiKey: process.env.WAREHOUSE_API_KEY ?? '',
    qidContacts: process.env.WAREHOUSE_CONTACTS_QUESTION_ID ?? '',
    qidInvestments: process.env.WAREHOUSE_INVESTMENTS_QUESTION_ID ?? '',
    qidBalances: process.env.WAREHOUSE_BALANCES_QUESTION_ID ?? '',
    qidStockRecord: process.env.WAREHOUSE_STOCK_RECORD_QUESTION_ID ?? '',
  };
}

export function isConfigured(): boolean {
  const e = env();
  return !!(e.url && e.apiKey && e.qidContacts && e.qidInvestments && e.qidBalances);
}

export function isMachineAccountIdentityConfigured(): boolean {
  const e = env();
  return !!(e.url && e.apiKey && e.qidContacts && e.qidInvestments);
}

export function isStockRecordConfigured(): boolean {
  return isConfigured() && !!env().qidStockRecord;
}

// ─── Warehouse API helper ─────────────────────────────────────────────────────

const WAREHOUSE_TIMEOUT_MS = 45_000;
const WAREHOUSE_RETRIES = 1;

// ticket: the saved cards and warehouse databases this transport may query. Every card id is also in
// RUNTIME_WAREHOUSE_CARD_IDS (lib/warehouse/client.ts); adding one is a security-reviewed change.
export const TRADE_REQUEST_WAREHOUSE_CARD_IDS = [6043, 6040, 6042, 6139] as const;
const COST_BASIS_ALLOWED_DATABASE_IDS: ReadonlySet<number> = new Set([4, 101]);

function assertHttps(baseUrl: string): void {
  if (!baseUrl.startsWith('https://')) throw new Error('Warehouse URL must use HTTPS');
}

async function runQuestion<T>(questionId: string): Promise<T[]> {
  const { url: baseUrl, apiKey } = env();
  assertHttps(baseUrl);
  if (!(TRADE_REQUEST_WAREHOUSE_CARD_IDS as readonly number[]).includes(Number(questionId))) {
    throw new Error(`Warehouse question ${questionId} is not allowed`);
  }
  const url = `${baseUrl}/api/card/${questionId}/query/json`;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= WAREHOUSE_RETRIES; attempt++) {
    try {
      const res = await serviceFetch(url, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(WAREHOUSE_TIMEOUT_MS),
      });

      if (!res.ok) {
        await res.text().catch(() => '');
        logger.debug({ questionId, status: res.status }, 'Warehouse error response');
        throw new Error(`Warehouse question ${questionId} returned ${res.status}`);
      }

      return res.json() as Promise<T[]>;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isTimeout = lastError.name === 'TimeoutError' || lastError.name === 'AbortError';
      if (isTimeout && attempt < WAREHOUSE_RETRIES) {
        logger.warn({ questionId, attempt }, 'Warehouse request timed out, retrying');
        continue;
      }
      throw lastError;
    }
  }
  throw lastError!;
}

// ─── Row shapes matching Warehouse raw-table columns ──────────────────────────

const contactRowSchema = z.object({
  cedar_ridge_user_id__c: z.coerce.string(),
  name: z.coerce.string(),
  crm__primary_entity_stage__c: z.string().nullable().default(null),
});

const investmentRowSchema = z.object({
  user_id: z.coerce.string(),
  custodian_account_number: z.coerce.string(),
  custodian_account_id: z.coerce.string(),
  account_type: z.coerce.string(),
});

const balanceRowSchema = z.object({
  account_id: z.coerce.string(),
  total_equity: z.coerce.number().default(0),
  // Authoritative settlement-cash equity from `apex_daily_overnight_balances`.
  // Defaulted to 0 so a NULL upstream value does not crash the parse — the
  // §5.C step 9 reconcile check (`cashEquity + Σ stockRecord ≈ totalEquity`)
  // surfaces systematic gaps via a `drift_balance_mismatch` warn log.
  cash_equity: z.coerce.number().default(0),
  snapshot_timestamp: z.coerce.string().default(''),
});

const stockRecordRowSchema = z.object({
  account_id: z.coerce.string(),
  symbol: z.coerce.string().default(''),
  // Trade-date position value. Pairs with `cash_equity` on the balance row
  // (which is itself trade-date — verified against `cash_trade_balance`), so
  // the reconcile invariant `cashEquity + Σ position_value ≈ totalEquity`
  // holds cleanly through T+1 settlement windows. Using `settled_position_value`
  // here previously caused the cash and stock-record sides to see a security
  // sale on two different days, double-counting MMF positions like SWVXX/VMSXX
  // on the trade date and silently under-counting freshly-bought positions
  // until they settled.
  trade_position_value: z.coerce.number().default(0),
  business_date: z.coerce.string().default(''),
  // ─── Cash-equivalent discriminators ───
  // Already present on the saved stock-record question (it returns all 38
  // `apex_daily_stock_record` columns) — these were simply being dropped here.
  // Parsing them costs nothing on the wire and lets `isCashEquivalentSymbol`
  // identify money-market funds from the feed instead of the hand-maintained
  // `CASH_SYMBOLS` list. Optional so a narrowed question still parses.
  asset_type: z.coerce.string().optional(),
  closing_price: z.coerce.number().optional(),
  symbol_description: z.coerce.string().optional(),
});

type ContactRow = z.infer<typeof contactRowSchema>;
type InvestmentRow = z.infer<typeof investmentRowSchema>;
type BalanceRow = z.infer<typeof balanceRowSchema>;
type StockRecordRow = z.infer<typeof stockRecordRowSchema>;

// ─── Account type mapping ────────────────────────────────────────────────────
// Apex types → app types (Taxable | Traditional IRA | Roth IRA)

const ACCOUNT_TYPE_MAP: Record<string, AccountType> = {
  BROKERAGE: 'Taxable',
  JOINT_BROKERAGE_COMMUNITY_PROPERTY: 'Joint',
  JOINT_BROKERAGE_TENANTS_IN_COMMON: 'Joint',
  JOINT_BROKERAGE_TENANTS_WITH_RIGHT_OF_SURVIVORSHIP: 'Joint',
  ROTH_IRA: 'Roth IRA',
  ROTH_IRA_INHERITED: 'Roth IRA',
  TRADITIONAL_IRA: 'Traditional IRA',
  TRADITIONAL_IRA_INHERITED: 'Traditional IRA',
};

function mapAccountType(raw: string): AccountType {
  return ACCOUNT_TYPE_MAP[raw] ?? 'Taxable';
}

// ─── Stock record → classified holdings ──────────────────────────────────────

/**
 * Bucket a symbol into cash/fixed/equity, letting the security-sector cache
 * CORRECT bond/MMF funds that `classifySymbol()` defaults to 'equity' (the
 * curated lists don't enumerate every bond ETF). Promote-only — never demotes a
 * curated cash/fixed classification — mirroring the drift comparator's
 * `effectiveBucket` so the engine's holdings bucket exactly as drift does.
 */
export function effectiveBucket(symbol: string, overrides?: ReadonlyMap<string, AssetCategory>): AssetCategory {
  const base = classifySymbol(symbol);
  if (base !== 'equity' || !overrides || overrides.size === 0) return base;
  const promoted = overrides.get(normalizeTicker(symbol) ?? symbol);
  return promoted === 'fixed' || promoted === 'cash' ? promoted : base;
}

function classifyStockRecord(
  rows: StockRecordRow[],
  bucketOverrides?: ReadonlyMap<string, AssetCategory>,
): Map<string, Holdings> {
  // Keep only the most recent business_date per account
  const latestDate = new Map<string, string>();
  for (const r of rows) {
    const aid = String(r.account_id);
    const d = String(r.business_date ?? '');
    const prev = latestDate.get(aid);
    if (!prev || d > prev) latestDate.set(aid, d);
  }

  const holdingsMap = new Map<string, Holdings>();
  for (const r of rows) {
    const aid = String(r.account_id);
    if (String(r.business_date ?? '') !== latestDate.get(aid)) continue;

    const h = holdingsMap.get(aid) ?? { cash: 0, fixed: 0, equity: 0 };
    const category = effectiveBucket(r.symbol, bucketOverrides);
    h[category] += Number(r.trade_position_value) || 0;
    holdingsMap.set(aid, h);
  }
  return holdingsMap;
}

/**
 * Build the promote-only bucket-override map from the security-sector cache:
 * funds the cache classifies as fixed/cash. Guarded — an empty or unavailable
 * cache yields no overrides (pure `classifySymbol` behavior). Keyed by
 * normalized ticker, matching `effectiveBucket`.
 */
async function loadBucketOverrides(): Promise<ReadonlyMap<string, AssetCategory> | undefined> {
  try {
    // Lazy import so merely importing this module has no DB/dotenv side-effect
    // (the database client is created on first use). Only the runtime cache build pays it.
    const { appPool } = await import('@/lib/trade-requests/pg-compat');
    const pool = await appPool();
    const classification = await getClassificationMap(pool);
    const m = new Map<string, AssetCategory>();
    for (const c of classification.values()) {
      if (c.kind === 'fund' && (c.bucket === 'fixed' || c.bucket === 'cash')) m.set(c.ticker, c.bucket);
    }
    return m.size > 0 ? m : undefined;
  } catch (err) {
    logger.warn(
      { message: err instanceof Error ? err.message : String(err) },
      'security-sector bucket overrides unavailable; classifying holdings with classifySymbol only',
    );
    return undefined;
  }
}

// ─── Per-account positions snapshot (drift pipeline) ─────────────────────────

/**
 * Per-account snapshot consumed by the position-vs-Meridian drift pipeline
 * (`positionDrift.ts`). Distinct from the client-dashboard `Holdings` shape
 * because:
 *   - drift comparison needs per-symbol granularity, not just the
 *     cash/fixed/equity rollup;
 *   - drift comparison treats `cashEquity` as a first-class numerator (the
 *     authoritative settlement-cash balance from
 *     `apex_daily_overnight_balances`), separate from money-market sweep
 *     positions that show up in `apex_daily_stock_record`.
 *
 * Keyed off the Apex custodian ULID (`stock_record.account_id`, equivalently
 * `balances.account_id`). The same ULID joins to Meridian's
 * `external_account_no` and to `households.json` `accountNumber` — see plan
 * §5.B for the join-key audit.
 */
export interface AccountPositions {
  /** Apex ULID, coerced to string. */
  accountId: string;
  /**
   * Σ `trade_position_value` across symbols at the latest `business_date`.
   * Does NOT include `cashEquity` (settlement cash). The drift comparison
   * adds `cashEquity` separately so the bucket math doesn't double-count.
   *
   * Trade-date basis (not settled-date) is required for the reconcile
   * invariant to hold through T+1 settlement windows: `cash_equity` on the
   * balance row is itself a trade-date number (it equals `cash_trade_balance`
   * verbatim in the Apex feed), so the stock-record side must agree.
   */
  positionsTotal: number;
  /** `apex_daily_overnight_balances.total_equity` (latest snapshot). Denominator. */
  totalEquity: number;
  /** `apex_daily_overnight_balances.cash_equity` (latest snapshot). Trade-date settlement cash. */
  cashEquity: number;
  /** Per-symbol trade-date position value at the latest `business_date`. */
  positionsBySymbol: Record<string, number>;
  /** Latest `business_date` observed for this account (YYYY-MM-DD). Empty if no stock_record rows. */
  businessDate: string;
  /**
   * Symbols in `positionsBySymbol` that are cash equivalents (money-market
   * funds), identified from the feed's `asset_type`/`closing_price`/
   * `symbol_description` or the curated cash list.
   *
   * These have no tax lots in the Apex cost-basis feed and need none: at a
   * $1.00 NAV, basis equals market value and unrealized gain is exactly $0.
   * Consumed by `costBasisEnrichment.ts`. Optional — absent when the feed
   * doesn't carry the discriminator columns.
   */
  cashEquivalentSymbols?: ReadonlySet<string>;
}

/**
 * Fetch per-account positions for the drift pipeline. Reads
 * `apex_daily_stock_record` (per-symbol trade-date position value at the
 * latest `business_date` per account) and `apex_daily_overnight_balances`
 * (`total_equity` and `cash_equity` from the latest `snapshot_timestamp` per
 * account), and returns one entry per account that appears in EITHER feed.
 *
 * An account that has a balance row but zero stock_record rows still gets an
 * entry (with `positionsBySymbol = {}` and `positionsTotal = 0`) so an
 * all-cash account's `cashEquity / totalEquity` still drives a real
 * cash-bucket weight rather than vanishing from the comparison. See plan
 * §5.D and §12 Q5 RESOLVED.
 *
 * Bypasses `getCachedClients` deliberately: the drift runner reads on its own
 * schedule and a stale 30-min cache hit could silently mask anomalies.
 */
export async function fetchAccountPositions(): Promise<Map<string, AccountPositions>> {
  const { qidBalances, qidStockRecord } = env();
  if (!qidStockRecord || !qidBalances) {
    throw new Error(
      'fetchAccountPositions requires WAREHOUSE_STOCK_RECORD_QUESTION_ID and WAREHOUSE_BALANCES_QUESTION_ID',
    );
  }

  const [rawStock, rawBalances] = await Promise.all([
    runQuestion<Record<string, unknown>>(qidStockRecord),
    runQuestion<Record<string, unknown>>(qidBalances),
  ]);

  const stockRows = rawStock
    .map((r, i) => {
      const parsed = stockRecordRowSchema.safeParse(r);
      if (!parsed.success) {
        logger.warn(
          { row: i, errors: parsed.error.issues },
          'fetchAccountPositions: skipping malformed stock record row',
        );
        return null;
      }
      return parsed.data;
    })
    .filter((r): r is StockRecordRow => r !== null);

  const balanceRows = rawBalances
    .map((r, i) => {
      const parsed = balanceRowSchema.safeParse(r);
      if (!parsed.success) {
        logger.warn({ row: i, errors: parsed.error.issues }, 'fetchAccountPositions: skipping malformed balance row');
        return null;
      }
      return parsed.data;
    })
    .filter((r): r is BalanceRow => r !== null);

  // Latest business_date per account (mirrors classifyStockRecord:122-129).
  const latestBusinessDate = new Map<string, string>();
  for (const r of stockRows) {
    const aid = String(r.account_id);
    const d = String(r.business_date ?? '');
    const prev = latestBusinessDate.get(aid);
    if (!prev || d > prev) latestBusinessDate.set(aid, d);
  }

  // Latest snapshot_timestamp per account, retaining BOTH total_equity and
  // cash_equity from the winning row (mirrors fetchClients:218-228).
  interface LatestBalance {
    timestamp: string;
    totalEquity: number;
    cashEquity: number;
  }
  const latestBalance = new Map<string, LatestBalance>();
  for (const b of balanceRows) {
    const aid = String(b.account_id);
    const ts = String(b.snapshot_timestamp ?? '');
    const prev = latestBalance.get(aid);
    if (!prev || ts > prev.timestamp) {
      latestBalance.set(aid, {
        timestamp: ts,
        totalEquity: Number(b.total_equity) || 0,
        cashEquity: Number(b.cash_equity) || 0,
      });
    }
  }

  // Build positionsBySymbol per account from the latest-date stock_record rows,
  // tagging cash equivalents (money-market funds) as we go.
  const positionsByAccount = new Map<string, Record<string, number>>();
  const cashEquivByAccount = new Map<string, Set<string>>();
  for (const r of stockRows) {
    const aid = String(r.account_id);
    if (String(r.business_date ?? '') !== latestBusinessDate.get(aid)) continue;
    const sym = String(r.symbol ?? '');
    if (!sym) continue;
    const value = Number(r.trade_position_value) || 0;
    const map = positionsByAccount.get(aid) ?? {};
    map[sym] = (map[sym] ?? 0) + value;
    positionsByAccount.set(aid, map);

    if (
      isCashEquivalentSymbol(sym, {
        assetType: r.asset_type,
        closingPrice: r.closing_price,
        symbolDescription: r.symbol_description,
      })
    ) {
      const set = cashEquivByAccount.get(aid) ?? new Set<string>();
      set.add(sym);
      cashEquivByAccount.set(aid, set);
    }
  }

  // Union of accounts present in EITHER feed so an all-cash account
  // (balance row, no stock_record) still surfaces.
  const allAccountIds = new Set<string>([...positionsByAccount.keys(), ...latestBalance.keys()]);

  const result = new Map<string, AccountPositions>();
  for (const accountId of allAccountIds) {
    const positionsBySymbol = positionsByAccount.get(accountId) ?? {};
    const positionsTotal = Object.values(positionsBySymbol).reduce((sum, v) => sum + v, 0);
    const balance = latestBalance.get(accountId);
    const totalEquity = balance?.totalEquity ?? 0;
    const cashEquity = balance?.cashEquity ?? 0;
    const businessDate = latestBusinessDate.get(accountId) ?? '';

    // Data-quality reconcile: |cashEquity + positionsTotal - totalEquity| > $0.01.
    // One warn line per offending account per run; never aborts the run.
    if (totalEquity > 0) {
      const reconcileDelta = Math.abs(cashEquity + positionsTotal - totalEquity);
      if (reconcileDelta > 0.01) {
        logger.warn(
          {
            event: 'drift_balance_mismatch',
            accountId,
            cashEquity,
            stockRecordTotal: positionsTotal,
            totalEquity,
            deltaUsd: reconcileDelta,
          },
          'drift balance reconcile mismatch',
        );
      }
    }

    const cashEquivalentSymbols = cashEquivByAccount.get(accountId);

    result.set(accountId, {
      accountId,
      positionsTotal,
      totalEquity,
      cashEquity,
      positionsBySymbol,
      businessDate,
      ...(cashEquivalentSymbols ? { cashEquivalentSymbols } : {}),
    });
  }

  return result;
}

// ─── Realized capital gains, YTD (closed-lot aggregate) ──────────────────────

// db 4 = Prod-redshift (apex schema), same warehouse as the cost-basis cards.
const COST_BASIS_DATABASE_ID = Number(process.env.WAREHOUSE_COST_BASIS_DB_ID ?? '4');

/**
 * Cost-basis warehouse sources, in config order.
 *
 * WHY MORE THAN ONE: the Apex feed is replicated into more than one Warehouse
 * database and they go stale INDEPENDENTLY. Observed 2026-08-27 — db 4
 * (Prod-redshift) had daily deltas current to 08-26 but its weekly open-lot
 * full-refresh loader had not run since 08-15, leaving the baseline stranded at
 * 08-14 (13 days, CRITICAL); db 101 (Prod-redshift-crw) carried the 08-21
 * weekly snapshot db 4 never loaded, but its daily deltas stopped at 08-25.
 * Neither database alone was current. Together they are: newest baseline from
 * one, newest deltas from the other.
 *
 * `WAREHOUSE_COST_BASIS_DB_IDS` is a comma-separated list. Defaults to the
 * single legacy `WAREHOUSE_COST_BASIS_DB_ID` (itself defaulting to 4), so
 * behavior is unchanged until the list is set.
 */
const COST_BASIS_DATABASE_IDS: number[] = (() => {
  const raw = process.env.WAREHOUSE_COST_BASIS_DB_IDS;
  if (!raw || !raw.trim()) return [COST_BASIS_DATABASE_ID];
  const ids = raw
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? Array.from(new Set(ids)) : [COST_BASIS_DATABASE_ID];
})();

/** Freshness of one cost-basis source, reported independently of the merge. */
export interface CostBasisSourceFreshness {
  databaseId: number;
  fullRefreshLatest: string | null;
  dailyRefreshLatest: string | null;
  fullGlueRunLatest: string | null;
  dailyGlueRunLatest: string | null;
  /** True when this source supplied the merged baseline snapshot. */
  baselineSource: boolean;
  /** Open-lot rows this source contributed (baseline + deltas) before dedupe. */
  rowsContributed: number;
}

// Per-account YTD realized gain, aggregated server-side (the closed-lot table
// is huge — far too large to pull raw, and we only need a ~130-row rollup).
// Runs via the ad-hoc dataset API rather than a saved question.
//
// CRITICAL — DEDUP BY closed_lot_id: within a single `process_date` snapshot the
// Apex closed-lot full-refresh table repeats each `closed_lot_id` N times (every
// copy carries an identical gain_loss/term — verified 0 non-uniform lots). N
// varies by snapshot (observed 6×–42×), so a naive SUM(gain_loss) over all rows
// inflates realized G/L by that factor AND makes it swing wildly day-to-day as
// the dup factor drifts. We collapse to one row per (account_id, closed_lot_id)
// first, then sum. (The open-lot/unrealized query is already protected by its
// ROW_NUMBER()…rn=1 dedup.)
const REALIZED_GAINS_YTD_SQL = `
WITH latest AS (
  SELECT MAX(process_date) AS d FROM apex.apex_cost_basis_closed_lot_full_refresh
),
lots AS (
  SELECT account_id, closed_lot_id,
         MAX(gain_loss) AS gain_loss,
         MAX(term)      AS term
  FROM apex.apex_cost_basis_closed_lot_full_refresh
  WHERE process_date = (SELECT d FROM latest)
    AND disposal_trade_date >= DATE_TRUNC('year', CURRENT_DATE)
  GROUP BY account_id, closed_lot_id
)
SELECT
  account_id,
  ROUND(SUM(gain_loss), 2)                                               AS realized_gain_ytd,
  ROUND(SUM(CASE WHEN term = 'SHORT_TERM' THEN gain_loss ELSE 0 END), 2) AS realized_st_ytd,
  ROUND(SUM(CASE WHEN term = 'LONG_TERM'  THEN gain_loss ELSE 0 END), 2) AS realized_lt_ytd
FROM lots
GROUP BY account_id`;

/**
 * Run ad-hoc native SQL via Warehouse's dataset EXPORT endpoint
 * (`/api/dataset/json`), returning an array of row objects keyed by column name.
 *
 * NOT the plain `/api/dataset` endpoint: that caps results at ~2000 rows (the
 * interactive limit), which silently truncated the ~50k-row open-lot query and
 * left the nightly cost-basis enrichment seeing only a fraction of holdings.
 * The export endpoint honors `MB_DOWNLOAD_ROW_LIMIT` (default 1,048,576).
 */
async function runNativeQuery<T = Record<string, unknown>>(databaseId: number, sql: string): Promise<T[]> {
  const { url: baseUrl, apiKey } = env();
  assertHttps(baseUrl);
  if (!COST_BASIS_ALLOWED_DATABASE_IDS.has(databaseId)) throw new Error(`Warehouse database ${databaseId} is not allowed`);
  const body = new URLSearchParams({
    query: JSON.stringify({ database: databaseId, type: 'native', native: { query: sql } }),
  });
  const res = await serviceFetch(`${baseUrl}/api/dataset/json`, {
    method: 'POST',
    redirect: 'error',
    cache: 'no-store',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(WAREHOUSE_TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.text().catch(() => '');
    throw new Error(`Warehouse dataset export returned ${res.status}`);
  }
  const json = (await res.json()) as unknown;
  // The export endpoint returns a bare array of row objects; an error comes back
  // as an object envelope instead.
  if (!Array.isArray(json)) {
    throw new Error('Warehouse dataset export: unexpected (non-array) response');
  }
  return json as T[];
}

export interface RealizedGainYtd {
  realizedGainYtdUsd: number;
  realizedShortTermYtdUsd: number;
  realizedLongTermYtdUsd: number;
}

export function isWarehouseQueryConfigured(): boolean {
  return !!(env().url && env().apiKey);
}

// Authoritative per-account ownership type (INDIVIDUAL/JOINT/ENTITY/RETIREMENT)
// from the Apex account master. One row per account (~450). Drives the
// taxable gate for the transition-candidate flag.
const OWNERSHIP_TYPES_SQL = `
SELECT account_id, MAX(ownership_type) AS ownership_type
FROM apex.apex_daily_accounts
WHERE gluerundatetime = (SELECT MAX(gluerundatetime) FROM apex.apex_daily_accounts)
GROUP BY account_id`;

/**
 * Per-account ownership type keyed by Apex ULID. Returns an empty map when
 * Warehouse isn't configured; query failures are left to the caller's guard.
 */
export async function fetchOwnershipTypes(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!isWarehouseQueryConfigured()) return out;
  const rows = await runNativeQuery(COST_BASIS_DATABASE_ID, OWNERSHIP_TYPES_SQL);
  for (const r of rows) {
    const accountId = String(r.account_id ?? '');
    const ownershipType = r.ownership_type == null ? '' : String(r.ownership_type);
    if (accountId && ownershipType) out.set(accountId, ownershipType);
  }
  return out;
}

// Per-account title (the human-readable ownership description, e.g.
// "WILLIE DOE REVOCABLE TRUST") from the Apex account master. Used to label
// funded-but-unmapped accounts that aren't in the Meridian active_accounts
// feed — without this they'd surface as a bare ULID.
const ACCOUNT_TITLES_SQL = `
SELECT account_id, MAX(title) AS title
FROM apex.apex_daily_accounts
WHERE gluerundatetime = (SELECT MAX(gluerundatetime) FROM apex.apex_daily_accounts)
GROUP BY account_id`;

/**
 * Per-account title keyed by Apex ULID. Returns an empty map when Warehouse
 * isn't configured; query failures are left to the caller's guard.
 */
export async function fetchAccountTitles(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!isWarehouseQueryConfigured()) return out;
  const rows = await runNativeQuery(COST_BASIS_DATABASE_ID, ACCOUNT_TITLES_SQL);
  for (const r of rows) {
    const accountId = String(r.account_id ?? '');
    const title = r.title == null ? '' : String(r.title).trim();
    if (accountId && title) out.set(accountId, title);
  }
  return out;
}

/** Newest `process_date` in a source's closed-lot full-refresh table, or null. */
const CLOSED_LOT_PROBE_SQL = `
SELECT MAX(process_date) AS closed_full_latest FROM apex.apex_cost_basis_closed_lot_full_refresh`;

/**
 * Choose which source to read realized gains from: the one whose closed-lot
 * full-refresh snapshot is newest.
 *
 * The same independent-staleness problem applies here as to open lots. Observed
 * 2026-08-27: db 4's closed-lot snapshot was 08-21 while db 101's was 08-25.
 * Note this reads ONLY the full-refresh table, so db 101's empty
 * `apex_cost_basis_closed_lot_refresh` is irrelevant to the choice.
 *
 * Falls back to the first configured source when every probe fails, so realized
 * gains degrade to the previous single-source behavior rather than vanishing.
 */
async function pickClosedLotSource(): Promise<number> {
  if (COST_BASIS_DATABASE_IDS.length === 1) return COST_BASIS_DATABASE_IDS[0];
  const probes = await Promise.all(
    COST_BASIS_DATABASE_IDS.map(async (databaseId) => {
      try {
        const rows = await runNativeQuery(databaseId, CLOSED_LOT_PROBE_SQL);
        const latest = rows[0]?.closed_full_latest;
        return { databaseId, latest: latest == null ? null : String(latest) };
      } catch (err) {
        logger.warn(
          {
            event: 'cost_basis_closed_probe_failed',
            databaseId,
            message: err instanceof Error ? err.message : String(err),
          },
          'closed-lot probe failed; source skipped for realized gains',
        );
        return { databaseId, latest: null };
      }
    }),
  );
  let best = COST_BASIS_DATABASE_IDS[0];
  let bestMs = -Infinity;
  for (const p of probes) {
    if (p.latest == null) continue;
    const ms = Date.parse(p.latest);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = p.databaseId;
    }
  }
  logger.info(
    { event: 'cost_basis_closed_source_selected', databaseId: best, probes },
    'selected closed-lot source for realized gains',
  );
  return best;
}

/**
 * Per-account YTD realized gain (the capital-gains "budget" consumed this tax
 * year), aggregated in-warehouse. Returns an empty map when Warehouse isn't
 * configured. Throwing on a query failure is left to the caller's guard.
 */
export async function fetchRealizedGainsYtd(): Promise<Map<string, RealizedGainYtd>> {
  const out = new Map<string, RealizedGainYtd>();
  if (!isWarehouseQueryConfigured()) return out;
  const databaseId = await pickClosedLotSource();
  const rows = await runNativeQuery(databaseId, REALIZED_GAINS_YTD_SQL);
  for (const r of rows) {
    const accountId = String(r.account_id ?? '');
    if (!accountId) continue;
    out.set(accountId, {
      realizedGainYtdUsd: Number(r.realized_gain_ytd) || 0,
      realizedShortTermYtdUsd: Number(r.realized_st_ytd) || 0,
      realizedLongTermYtdUsd: Number(r.realized_lt_ytd) || 0,
    });
  }
  return out;
}

// ─── Cost-basis open lots (drift tax-enrichment layer) ───────────────────────

function isYes(raw: string): boolean {
  const v = raw.trim().toUpperCase();
  return v === 'Y' || v === 'YES' || v === 'TRUE' || v === '1';
}

// ─── Open-lot SQL, split into three narrow queries ──────────────────────────
//
// Previously one query per database did anchor-find + baseline + deltas + merge
// server-side. With MORE THAN ONE source that shape would pull a full ~60k-row
// baseline from every database just to discard all but the newest — doubling the
// payload that OOM-killed the 1 GB container once already (PR #92).
//
// So: probe every source cheaply (one row each), pick the single database with
// the newest weekly snapshot, pull the baseline from THAT one only, then pull
// the (tiny) post-anchor deltas from every source and merge in-process. Measured
// 2026-08-27: baseline 59,073 rows + 1,353 delta rows across both databases —
// the same order as today's single-source pull, not double.

/** One row: the newest content date and ETL load time for each open-lot table. */
const OPEN_LOTS_PROBE_SQL = `
SELECT
  (SELECT MAX(process_date)    FROM apex.apex_cost_basis_open_lot_full_refresh) AS full_refresh_latest,
  (SELECT MAX(gluerundatetime) FROM apex.apex_cost_basis_open_lot_full_refresh) AS full_gluerun_latest,
  (SELECT MAX(process_date)    FROM apex.apex_cost_basis_open_lot_refresh)      AS daily_refresh_latest,
  (SELECT MAX(gluerundatetime) FROM apex.apex_cost_basis_open_lot_refresh)      AS daily_gluerun_latest`;

const OPEN_LOT_COLUMNS = `open_lot_id, process_date, account_id, symbol, quantity, term,
         acquisition_event_type, acquisition_adjusted_net, acquisition_true_zero_cost_indicator,
         wash_sale_adjustment, open_closed_indicator`;

/**
 * Reject anything that is not a bare `YYYY-MM-DD` date before it reaches SQL.
 *
 * The anchor is derived from our own probe rather than user input, but it is
 * still interpolated into a native query, so it gets validated rather than
 * trusted. Warehouse's dataset endpoint takes the SQL as a string; there is no
 * bind-parameter path here.
 */
function assertSqlDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`refusing to interpolate non-date value into cost-basis SQL: ${JSON.stringify(value)}`);
  }
  return value;
}

/** The weekly full snapshot AT a specific process_date. OPEN lots only. */
function openLotsBaselineSql(anchorDate: string): string {
  return `
SELECT ${OPEN_LOT_COLUMNS}
FROM apex.apex_cost_basis_open_lot_full_refresh
WHERE process_date = '${assertSqlDate(anchorDate)}' AND open_closed_indicator = 'OPEN'`;
}

/** Daily deltas strictly AFTER the baseline snapshot. OPEN lots only. */
function openLotsDeltaSql(anchorDate: string): string {
  return `
SELECT ${OPEN_LOT_COLUMNS}
FROM apex.apex_cost_basis_open_lot_refresh
WHERE process_date > '${assertSqlDate(anchorDate)}' AND open_closed_indicator = 'OPEN'`;
}

/** Every OPEN daily row, used when no source has a weekly snapshot at all. */
const OPEN_LOTS_DELTA_ALL_SQL = `
SELECT ${OPEN_LOT_COLUMNS}
FROM apex.apex_cost_basis_open_lot_refresh
WHERE open_closed_indicator = 'OPEN'`;

export interface CostBasisData {
  lots: OpenLot[];
  /** Newest `process_date` of the weekly full-refresh table ACROSS sources, or null. */
  fullRefreshLatest: string | null;
  /** Newest `process_date` of the daily-refresh table ACROSS sources, or null. */
  dailyRefreshLatest: string | null;
  /** Newest `gluerundatetime` of the full-refresh table across sources, or null. */
  fullGlueRunLatest: string | null;
  /** Newest `gluerundatetime` of the daily-refresh table across sources, or null. */
  dailyGlueRunLatest: string | null;
  /**
   * Per-source freshness, so a dead loader stays visible even when the MERGED
   * result is healthy. Without this, adding a second source silently converts
   * "db 4's weekly loader has been down for 12 days" into no signal at all.
   */
  sources: CostBasisSourceFreshness[];
}

/** `2026-08-21T00:00:00-04:00` → `2026-08-21`; null when unparseable. */
function toDateOnly(value: unknown): string | null {
  if (value == null) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : null;
}

function newestOf(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    if (v == null) continue;
    const ms = Date.parse(v);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

function toRawLotRow(r: Record<string, unknown>): RawLotRow | null {
  const accountId = String(r.account_id ?? '');
  const symbol = String(r.symbol ?? '');
  const openLotId = String(r.open_lot_id ?? '');
  if (!accountId || !symbol || !openLotId) return null;
  const eventType = String(r.acquisition_event_type ?? '')
    .trim()
    .toUpperCase();
  const term = String(r.term ?? '')
    .trim()
    .toUpperCase();
  return {
    openLotId,
    openClosedIndicator: String(r.open_closed_indicator ?? 'OPEN'),
    processDate: String(r.process_date ?? ''),
    gluerun: null,
    accountId,
    symbol,
    quantity: Number(r.quantity) || 0,
    costBasisUsd: Number(r.acquisition_adjusted_net) || 0,
    term: term.startsWith('SHORT') ? 'short' : 'long',
    acquisitionEventType: eventType,
    isTransferExternal: eventType === 'TRANSFER_EXTERNAL',
    missingBasis: isYes(String(r.acquisition_true_zero_cost_indicator ?? '')),
    washSaleAdjustmentUsd: Number(r.wash_sale_adjustment) || 0,
  };
}

interface SourceProbe {
  databaseId: number;
  fullRefreshLatest: string | null;
  dailyRefreshLatest: string | null;
  fullGlueRunLatest: string | null;
  dailyGlueRunLatest: string | null;
}

/**
 * Probe one source for its content dates and ETL load times. Returns null (and
 * logs) on failure so ONE unreachable database cannot take down the cost-basis
 * step — the merge proceeds with whatever sources answered.
 */
async function probeCostBasisSource(databaseId: number): Promise<SourceProbe | null> {
  try {
    const rows = await runNativeQuery(databaseId, OPEN_LOTS_PROBE_SQL);
    const r = rows[0] ?? {};
    return {
      databaseId,
      fullRefreshLatest: r.full_refresh_latest == null ? null : String(r.full_refresh_latest),
      dailyRefreshLatest: r.daily_refresh_latest == null ? null : String(r.daily_refresh_latest),
      fullGlueRunLatest: r.full_gluerun_latest == null ? null : String(r.full_gluerun_latest),
      dailyGlueRunLatest: r.daily_gluerun_latest == null ? null : String(r.daily_gluerun_latest),
    };
  } catch (err) {
    logger.warn(
      {
        event: 'cost_basis_source_probe_failed',
        databaseId,
        message: err instanceof Error ? err.message : String(err),
      },
      'cost-basis source probe failed; continuing with remaining sources',
    );
    return null;
  }
}

/**
 * Fetch the current open lots by merging every configured warehouse source.
 *
 * Takes the newest weekly baseline available anywhere, then layers the daily
 * deltas from ALL sources on top of it, so a source that is behind on one table
 * still contributes the table it is ahead on. See `COST_BASIS_DATABASE_IDS` for
 * the incident that motivated this.
 */
export async function fetchCostBasisData(): Promise<CostBasisData> {
  if (!isWarehouseQueryConfigured()) {
    throw new Error('fetchCostBasisData requires WAREHOUSE_URL and WAREHOUSE_API_KEY');
  }

  const probes = (await Promise.all(COST_BASIS_DATABASE_IDS.map(probeCostBasisSource))).filter(
    (p): p is SourceProbe => p !== null,
  );
  if (probes.length === 0) {
    throw new Error('fetchCostBasisData: every cost-basis source probe failed');
  }

  // Baseline = the source with the newest weekly snapshot. Ties go to config
  // order, which keeps the primary database authoritative when both are current.
  let baseline: SourceProbe | null = null;
  for (const p of probes) {
    if (p.fullRefreshLatest == null) continue;
    if (baseline == null || Date.parse(p.fullRefreshLatest) > Date.parse(baseline.fullRefreshLatest!)) {
      baseline = p;
    }
  }

  const anchorDate = baseline ? toDateOnly(baseline.fullRefreshLatest) : null;
  const rowsBySource = new Map<number, number>();
  const allRows: RawLotRow[] = [];

  const collect = async (databaseId: number, sql: string): Promise<void> => {
    const rows = await runNativeQuery(databaseId, sql);
    let kept = 0;
    for (const r of rows) {
      const parsed = toRawLotRow(r);
      if (parsed) {
        allRows.push(parsed);
        kept += 1;
      }
    }
    rowsBySource.set(databaseId, (rowsBySource.get(databaseId) ?? 0) + kept);
  };

  if (baseline && anchorDate) {
    await collect(baseline.databaseId, openLotsBaselineSql(anchorDate));
    // Deltas from every source, including the baseline's own.
    await Promise.all(probes.map((p) => collect(p.databaseId, openLotsDeltaSql(anchorDate))));
  } else {
    // No weekly snapshot anywhere — fall back to the daily tables alone rather
    // than returning nothing. Freshness will report the missing full refresh.
    logger.warn(
      { event: 'cost_basis_no_full_snapshot', databaseIds: probes.map((p) => p.databaseId) },
      'no cost-basis full-refresh snapshot found in any source; using daily deltas only',
    );
    await Promise.all(probes.map((p) => collect(p.databaseId, OPEN_LOTS_DELTA_ALL_SQL)));
  }

  const lots = mergeOpenLotRows(allRows);

  const sources: CostBasisSourceFreshness[] = probes.map((p) => ({
    databaseId: p.databaseId,
    fullRefreshLatest: p.fullRefreshLatest,
    dailyRefreshLatest: p.dailyRefreshLatest,
    fullGlueRunLatest: p.fullGlueRunLatest,
    dailyGlueRunLatest: p.dailyGlueRunLatest,
    baselineSource: baseline != null && p.databaseId === baseline.databaseId,
    rowsContributed: rowsBySource.get(p.databaseId) ?? 0,
  }));

  return {
    lots,
    fullRefreshLatest: newestOf(probes.map((p) => p.fullRefreshLatest)),
    dailyRefreshLatest: newestOf(probes.map((p) => p.dailyRefreshLatest)),
    fullGlueRunLatest: newestOf(probes.map((p) => p.fullGlueRunLatest)),
    dailyGlueRunLatest: newestOf(probes.map((p) => p.dailyGlueRunLatest)),
    sources,
  };
}

// ─── Fetch & join ────────────────────────────────────────────────────────────

export async function fetchClients(): Promise<Client[]> {
  const { qidContacts, qidInvestments, qidBalances, qidStockRecord } = env();

  const stockRecordPromise = qidStockRecord
    ? runQuestion<Record<string, unknown>>(qidStockRecord).catch((err) => {
        logger.warn({ err }, 'Stock record question failed — falling back to all-cash holdings');
        return null;
      })
    : Promise.resolve(null);

  const [rawContacts, rawInvestments, rawBalances, rawStockRecord] = await Promise.all([
    runQuestion<Record<string, unknown>>(qidContacts),
    runQuestion<Record<string, unknown>>(qidInvestments),
    runQuestion<Record<string, unknown>>(qidBalances),
    stockRecordPromise,
  ]);

  const contacts = rawContacts
    .map((r, i) => {
      const parsed = contactRowSchema.safeParse(r);
      if (!parsed.success) {
        logger.warn({ row: i, errors: parsed.error.issues }, 'Skipping malformed contact row');
        return null;
      }
      return parsed.data;
    })
    .filter((r): r is ContactRow => r !== null);

  const investments = rawInvestments
    .map((r, i) => {
      const parsed = investmentRowSchema.safeParse(r);
      if (!parsed.success) {
        logger.warn({ row: i, errors: parsed.error.issues }, 'Skipping malformed investment row');
        return null;
      }
      return parsed.data;
    })
    .filter((r): r is InvestmentRow => r !== null);

  const balances = rawBalances
    .map((r, i) => {
      const parsed = balanceRowSchema.safeParse(r);
      if (!parsed.success) {
        logger.warn({ row: i, errors: parsed.error.issues }, 'Skipping malformed balance row');
        return null;
      }
      return parsed.data;
    })
    .filter((r): r is BalanceRow => r !== null);

  // Parse stock record rows (if available)
  let classifiedHoldings = new Map<string, Holdings>();
  if (rawStockRecord) {
    const stockRecordRows = rawStockRecord
      .map((r, i) => {
        const parsed = stockRecordRowSchema.safeParse(r);
        if (!parsed.success) {
          logger.warn({ row: i, errors: parsed.error.issues }, 'Skipping malformed stock record row');
          return null;
        }
        return parsed.data;
      })
      .filter((r): r is StockRecordRow => r !== null);

    const bucketOverrides = await loadBucketOverrides();
    classifiedHoldings = classifyStockRecord(stockRecordRows, bucketOverrides);
    logger.info(
      { accountsWithPositions: classifiedHoldings.size, bucketOverrides: bucketOverrides?.size ?? 0 },
      'Stock record classified',
    );
  }

  // 1. Filter contacts to clients only
  const clients = contacts.filter((c) => c.crm__primary_entity_stage__c === 'Client');

  // 2. Get latest balance per account_id (by snapshot_timestamp)
  const latestBalance = new Map<string, number>();
  const latestTimestamp = new Map<string, string>();
  for (const b of balances) {
    const aid = String(b.account_id);
    const ts = String(b.snapshot_timestamp ?? '');
    const prev = latestTimestamp.get(aid);
    if (!prev || ts > prev) {
      latestTimestamp.set(aid, ts);
      latestBalance.set(aid, Number(b.total_equity) || 0);
    }
  }

  // 3. Build accounts from investments, joining to balances via custodian_account_id
  const accountsByClient = new Map<string, Account[]>();

  for (const inv of investments) {
    const custodianId = String(inv.custodian_account_id);
    const balance = latestBalance.get(custodianId) ?? 0;

    // Use classified stock record holdings when available; otherwise default to all-cash
    let holdings: Holdings = { cash: balance, fixed: 0, equity: 0 };
    const classified = classifiedHoldings.get(custodianId);
    if (classified) {
      const classifiedTotal = classified.cash + classified.fixed + classified.equity;
      const residual = balance - classifiedTotal;
      holdings = {
        cash: Math.round((classified.cash + residual) * 100) / 100,
        fixed: Math.round(classified.fixed * 100) / 100,
        equity: Math.round(classified.equity * 100) / 100,
      };
    }

    const account: Account = {
      id: custodianId,
      clientId: String(inv.user_id),
      accountNumber: String(inv.custodian_account_number),
      accountType: mapAccountType(inv.account_type),
      balance,
      holdings,
    };

    const clientId = String(inv.user_id);
    const list = accountsByClient.get(clientId) ?? [];
    list.push(account);
    accountsByClient.set(clientId, list);
  }

  // 4. Assemble final client list (sorted by name)
  return clients
    .map((c) => {
      const id = String(c.cedar_ridge_user_id__c);
      return {
        id,
        name: String(c.name),
        accounts: accountsByClient.get(id) ?? [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

let cachedClients: Client[] | null = null;
let cacheExpiry = 0;
let inflightRefresh: Promise<Client[]> | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000;

export async function getCachedClients(): Promise<Client[]> {
  if (cachedClients && Date.now() < cacheExpiry) return cachedClients;

  if (inflightRefresh) return inflightRefresh;

  const STALE_GRACE_MS = 5 * 60 * 1000;

  inflightRefresh = fetchClients()
    .then((clients) => {
      cachedClients = clients;
      cacheExpiry = Date.now() + CACHE_TTL_MS;
      return clients;
    })
    .catch((err) => {
      logger.error({ err }, 'Warehouse client refresh failed');
      if (cachedClients) {
        cacheExpiry = Date.now() + STALE_GRACE_MS;
        return cachedClients;
      }
      throw err;
    })
    .finally(() => {
      inflightRefresh = null;
    });

  return inflightRefresh;
}

export async function getClientAccounts(clientId: string): Promise<Account[]> {
  const clients = await getCachedClients();
  const client = clients.find((c) => c.id === clientId);
  return client?.accounts ?? [];
}

export async function getAccountTypeMap(accountNumbers: string[]): Promise<Record<string, AccountType>> {
  const clients = await getCachedClients();
  const map: Record<string, AccountType> = {};
  for (const client of clients) {
    for (const acct of client.accounts) {
      if (accountNumbers.includes(acct.accountNumber)) {
        map[acct.accountNumber] = acct.accountType;
      }
    }
  }
  return map;
}

export async function getAccountClientIdMap(accountNumbers: string[]): Promise<Record<string, string>> {
  const clients = await getCachedClients();
  const map: Record<string, string> = {};
  for (const client of clients) {
    for (const acct of client.accounts) {
      if (accountNumbers.includes(acct.accountNumber)) {
        map[acct.accountNumber] = acct.clientId;
      }
    }
  }
  return map;
}

/** Human-readable custodian number → stable Apex custodian_account_id / ULID. */
export async function getAccountIdMap(accountNumbers: string[]): Promise<Record<string, string>> {
  const clients = await getCachedClients();
  const requested = new Set(accountNumbers);
  const map: Record<string, string> = {};
  for (const client of clients) {
    for (const acct of client.accounts) {
      if (requested.has(acct.accountNumber)) map[acct.accountNumber] = acct.id;
    }
  }
  return map;
}

// Machine reads need identity only. Keep this cache independent of the full
// client/holdings cache so its refresh, stale grace, and retries cannot delay a
// queue read (2026-09-18). The existing write-path helpers above are unchanged.
const MACHINE_IDENTITY_TIMEOUT_MS = 5_000;
let cachedMachineAccountIds: ReadonlyMap<string, string> | null = null;
let machineIdentityExpiry = 0;
let inflightMachineIdentity: Promise<ReadonlyMap<string, string>> | null = null;

function machineIdentifier(value: unknown): string | null {
  // Preserve exact string identity, including leading zeroes and case. Only
  // safe integer scalars retain the existing String(value) compatibility;
  // null/object/boolean coercion must never manufacture a matching identity.
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  const content = value.trim();
  if (!content || /^(null|undefined)$/i.test(content)) return null;
  return value;
}

function identityRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchMachineAccountIds(): Promise<ReadonlyMap<string, string>> {
  const { url, apiKey, qidContacts, qidInvestments } = env();
  if (!url || !apiKey || !qidContacts || !qidInvestments) {
    throw new Error('Machine account identity is not configured');
  }

  const controller = new AbortController();
  const deadline = Date.now() + MACHINE_IDENTITY_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const unavailable = () => new Error('Machine account identity unavailable');

  const runIdentityQuestion = async (questionId: string): Promise<unknown[]> => {
    if (!url.startsWith('https://') || !(TRADE_REQUEST_WAREHOUSE_CARD_IDS as readonly number[]).includes(Number(questionId))) throw unavailable();
    const response = await serviceFetch(`${url}/api/card/${questionId}/query/json`, {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    // Do not read or log an error body: it can contain account data and may
    // itself hang. Aborting in finally also cancels the sibling request.
    if (controller.signal.aborted || !response.ok) throw unavailable();
    const rows: unknown = await response.json();
    if (!Array.isArray(rows)) throw unavailable();
    return rows;
  };

  const load = async (): Promise<ReadonlyMap<string, string>> => {
    const [contacts, investments] = await Promise.all([
      runIdentityQuestion(qidContacts),
      runIdentityQuestion(qidInvestments),
    ]);
    if (controller.signal.aborted) throw unavailable();
    const eligibleClients = new Set<string>();
    for (const contact of contacts) {
      if (!identityRow(contact) || contact.crm__primary_entity_stage__c !== 'Client') continue;
      const clientId = machineIdentifier(contact.cedar_ridge_user_id__c);
      if (clientId !== null) eligibleClients.add(clientId);
    }

    const identities = new Map<string, string>();
    const unresolved = new Set<string>();
    for (const investment of investments) {
      if (!identityRow(investment)) continue;
      const clientId = machineIdentifier(investment.user_id);
      if (clientId === null || !eligibleClients.has(clientId)) continue;
      const accountNumber = machineIdentifier(investment.custodian_account_number);
      if (accountNumber === null || unresolved.has(accountNumber)) continue;
      const accountId = machineIdentifier(investment.custodian_account_id);
      const previousId = identities.get(accountNumber);
      if (accountId === null || (previousId !== undefined && previousId !== accountId)) {
        // Neither row order nor duplicate joint ownership may choose between
        // conflicting identities. A malformed ID is unresolved as well.
        identities.delete(accountNumber);
        unresolved.add(accountNumber);
      } else {
        identities.set(accountNumber, accountId);
      }
    }
    return identities;
  };

  try {
    // The deadline covers both requests AND body parsing. Promise.race bounds
    // even a transport/body implementation that ignores the abort signal.
    const result = await Promise.race([
      load(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(unavailable());
        }, MACHINE_IDENTITY_TIMEOUT_MS);
      }),
    ]);
    // Synchronous JSON parsing or mapping can delay the timer callback. Check
    // elapsed time before allowing any result to populate the identity cache.
    if (controller.signal.aborted || Date.now() >= deadline) throw unavailable();
    return result;
  } catch {
    // Never expose upstream payloads, URLs, or arbitrary error messages to a
    // caller that might log this error. Failure is distinct from an empty map.
    throw unavailable();
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

/**
 * Optional machine-read enrichment: exact custodian number → stable Apex ID,
 * scoped to contacts at the Client stage. Uses only the existing contacts and
 * investments questions. Failed/expired refreshes reject; no stale identity is
 * served. Concurrent batches share one refresh and each receives its own subset.
 */
export async function getMachineAccountIdMap(accountNumbers: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  if (accountNumbers.length === 0) return result;

  let identities = cachedMachineAccountIds;
  if (!identities || Date.now() >= machineIdentityExpiry) {
    if (!inflightMachineIdentity) {
      inflightMachineIdentity = fetchMachineAccountIds()
        .then((result) => {
          cachedMachineAccountIds = result;
          machineIdentityExpiry = Date.now() + CACHE_TTL_MS;
          return result;
        })
        .finally(() => {
          inflightMachineIdentity = null;
        });
    }
    identities = await inflightMachineIdentity;
  }

  for (const number of new Set(accountNumbers)) {
    const id = identities.get(number);
    if (id !== undefined) result[number] = id;
  }
  return result;
}

/**
 * Apex-ULID-keyed client lookup. Returns one entry per requested ULID, mapping
 * to the sorted, deduplicated list of Warehouse `Client.id` (user_id) values
 * that own that ULID through the `investments` table.
 *
 * Joint accounts: when `investments` carries multiple rows for the same
 * `custodian_account_id` with different `user_id` values, the cached client
 * list contains the same Apex ULID under each owning client. This loop
 * captures all of them.
 *
 * Unknown ULIDs return `[]` (not `undefined`) so callers can rely on the
 * map shape without per-key guards.
 *
 * NOTE: This is distinct from `getAccountClientIdMap` above, which is keyed
 * on `Account.accountNumber` (Apex `custodian_account_number`) and is used
 * by trade-request flows. Drift uses the ULID (`Account.id` / Apex
 * `custodian_account_id`), so the two helpers cannot share an implementation.
 */
export async function getClientIdsByAccountUlid(ulids: string[]): Promise<Record<string, string[]>> {
  const clients = await getCachedClients();
  const ulidSet = new Set(ulids);
  const accumulator = new Map<string, Set<string>>();
  for (const client of clients) {
    for (const acct of client.accounts) {
      if (!ulidSet.has(acct.id)) continue;
      const set = accumulator.get(acct.id) ?? new Set<string>();
      set.add(client.id);
      accumulator.set(acct.id, set);
    }
  }
  const out: Record<string, string[]> = {};
  for (const ulid of ulids) {
    const set = accumulator.get(ulid);
    out[ulid] = set ? Array.from(set).sort() : [];
  }
  return out;
}

// The names the native reads (ticket) import.
export type SourceClient = Client;
export function tradeRequestWarehouseConfigured(): boolean {
  return isConfigured();
}
export function machineAccountIdentityConfigured(): boolean {
  return isMachineAccountIdentityConfigured();
}

/**
 * Returns classified holdings (cash/fixed/equity) for the given account numbers.
 * Uses stock record data from the shared cache. Falls back to all-cash if
 * the stock record question is not configured or account is not found.
 */
export async function getClassifiedHoldings(accountNumbers: string[]): Promise<Record<string, Holdings>> {
  const clients = await getCachedClients();
  const result: Record<string, Holdings> = {};
  for (const client of clients) {
    for (const acct of client.accounts) {
      if (accountNumbers.includes(acct.accountNumber)) {
        result[acct.accountNumber] = { ...acct.holdings };
      }
    }
  }
  return result;
}
