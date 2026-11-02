import type { AccountPositions } from '@/lib/trade-requests/sources/warehouse';

/**
 * Cost-basis enrichment for the drift analysis. Pure functions — no I/O, no DB.
 *
 * Turns the drift surface from "% off target" into "% off target AND the tax
 * reality of fixing it": unrealized gain (short- vs long-term), how much of an
 * account is transferred-in (ACAT) legacy stock, and basis data-quality flags.
 *
 * Data sources (see docs/specs/cost-basis-feed.md and memory
 * drift-enrichment-data-sources):
 *   - Open lots: Warehouse `apex_cost_basis_open_lot_full_refresh` (weekly full
 *     snapshot) UNION the daily `apex_cost_basis_open_lot_refresh` deltas.
 *     `fetchOpenLots()` in `warehouse.ts` does the merge.
 *   - Held quantity / market value: the existing live positions feed
 *     (`AccountPositions`, fresh daily). We ANCHOR to this so the weekly↔daily
 *     staleness gap and closed-lot lag self-correct: a fully-sold symbol is
 *     absent from positions and drops out; a partial sale is bounded by the
 *     held market value.
 *
 *   - Cash equivalents (money-market funds): the positions feed itself. Apex's
 *     cost-basis feed carries almost no MMF lots, so these are valued at their
 *     $1.00 NAV — basis = market value, gain = $0 — via
 *     `enrichCashEquivalent`. Identified by `AccountPositions.cashEquivalentSymbols`,
 *     derived in `warehouse.ts` from the stock-record `asset_type`/`closing_price`/
 *     `symbol_description` columns.
 *
 * KNOWN LIMITATION (v1): the positions feed gives per-symbol market value in
 * dollars, not share count, so per-lot market value is prorated by lot
 * `quantity`. If a symbol was partially sold since the last cost-basis refresh,
 * the prorated unrealized gain can be overstated by up to the size of the
 * unrefreshed sale. Bounded by the daily-delta freshness window — surfaced via
 * `costBasisFreshness.ts`.
 */

/** A single open tax lot, normalized from the Apex cost-basis feed. */
export interface OpenLot {
  /** Apex ULID — same join key as positions/household. */
  accountId: string;
  symbol: string;
  /** Open share quantity for this lot. */
  quantity: number;
  /** Cost basis for the lot in USD (`acquisition_adjusted_net`). */
  costBasisUsd: number;
  /** Holding-period term, normalized from `term` (`SHORT_TERM`/`LONG_TERM`). */
  term: 'short' | 'long';
  /** Raw `acquisition_event_type` (e.g. BUY, TRANSFER_EXTERNAL, TRANSFER_INTERNAL). */
  acquisitionEventType: string;
  /** True when `acquisition_event_type === 'TRANSFER_EXTERNAL'` (ACAT transfer-in). */
  isTransferExternal: boolean;
  /** True when Apex flags the lot as missing/zero cost basis (`acquisition_true_zero_cost_indicator`). */
  missingBasis: boolean;
  /** Wash-sale adjustment in USD (0 when none). */
  washSaleAdjustmentUsd: number;
}

/** Per-symbol tax enrichment within an account. */
export interface SymbolTaxEnrichment {
  symbol: string;
  /** Market value from the live positions feed (USD). */
  marketValueUsd: number;
  /** Σ lot cost basis for the symbol (USD). */
  costBasisUsd: number;
  /** marketValueUsd − costBasisUsd. */
  unrealizedGainUsd: number;
  /** Unrealized gain attributable to short-term lots (USD). */
  unrealizedShortTermGainUsd: number;
  /** Unrealized gain attributable to long-term lots (USD). */
  unrealizedLongTermGainUsd: number;
  /** Market value attributable to TRANSFER_EXTERNAL lots (USD). */
  transferInValueUsd: number;
  /** transferInValueUsd / marketValueUsd × 100 (0..100). */
  transferInPct: number;
  /** Number of open lots backing this symbol. */
  lotCount: number;
  /** True when any backing lot is flagged missing/zero basis. */
  hasMissingBasis: boolean;
  /** True when any backing lot carries a wash-sale adjustment. */
  hasWashSaleAdjustment: boolean;
  /**
   * True when this is a cash equivalent (money-market fund) valued at its
   * $1.00 NAV rather than from tax lots: `costBasisUsd === marketValueUsd`,
   * gain exactly $0, `lotCount === 0`.
   */
  isCashEquivalent?: boolean;
}

/** Per-account tax enrichment, attached to the drift result. */
export interface AccountTaxEnrichment {
  accountId: string;
  /** Investable market value (positions excluding settlement cash), USD. */
  investableValueUsd: number;
  /** Market value of symbols we found cost-basis lots for, USD. */
  enrichedValueUsd: number;
  /**
   * enrichedValueUsd / investableValueUsd × 100 (0..100).
   *
   * Money-market funds no longer drag this down — they're accounted for at NAV
   * (see `cashEquivalentValueUsd`), so a fully-covered account reads ~100% even
   * with a large sweep sleeve. A genuine shortfall now means genuinely missing
   * cost-basis data.
   */
  basisCoveragePct: number;
  /**
   * Market value held in cash equivalents (money-market funds), USD. Carried at
   * NAV: included in `enrichedValueUsd`, contributes $0 of unrealized gain, and
   * EXCLUDED from the `transferInPct` denominator.
   */
  cashEquivalentValueUsd: number;
  unrealizedGainUsd: number;
  unrealizedShortTermGainUsd: number;
  unrealizedLongTermGainUsd: number;
  /** Market value of TRANSFER_EXTERNAL lots across the account, USD. */
  transferInValueUsd: number;
  /**
   * transferInValueUsd / (investableValueUsd − cashEquivalentValueUsd) × 100.
   *
   * Cash equivalents are out of the denominator on purpose: this ratio gates
   * the transition-candidate flag, and it should measure how much of the
   * SECURITIES book was transferred in — not how much cash happens to be parked
   * in a sweep fund. Counting a money-market sleeve as un-transferred dilutes
   * the ratio and hides real transition candidates.
   */
  transferInPct: number;
  /** True when any symbol in the account has a missing-basis lot. */
  hasMissingBasis: boolean;
  /** Symbols with enrichment, sorted by |unrealizedGainUsd| desc. */
  symbols: SymbolTaxEnrichment[];
}

/**
 * A raw open-lot row as read from one of the two Apex cost-basis questions
 * (full-refresh = weekly baseline, refresh = daily deltas) before merging.
 * Carries the bookkeeping columns the merge needs on top of the `OpenLot`
 * fields: lot identity, open/closed state, the business `processDate`, and the
 * ETL `gluerun` load time.
 */
export interface RawLotRow extends OpenLot {
  openLotId: string;
  openClosedIndicator: string;
  processDate: string;
  gluerun: string | null;
}

export interface MergedCostBasis {
  lots: OpenLot[];
  fullRefreshLatest: string | null;
  dailyRefreshLatest: string | null;
  fullGlueRunLatest: string | null;
  dailyGlueRunLatest: string | null;
}

function parseMs(value: string | null | undefined): number {
  if (!value) return NaN;
  return Date.parse(value);
}

/** The value (per `select`) with the maximum parsed timestamp; null if none parse. */
function maxByTime(rows: readonly RawLotRow[], select: (r: RawLotRow) => string | null): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const r of rows) {
    const v = select(r);
    const ms = parseMs(v);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = v;
    }
  }
  return best;
}

function stripToOpenLot(r: RawLotRow): OpenLot {
  return {
    accountId: r.accountId,
    symbol: r.symbol,
    quantity: r.quantity,
    costBasisUsd: r.costBasisUsd,
    term: r.term,
    acquisitionEventType: r.acquisitionEventType,
    isTransferExternal: r.isTransferExternal,
    missingBasis: r.missingBasis,
    washSaleAdjustmentUsd: r.washSaleAdjustmentUsd,
  };
}

/**
 * Merge the weekly full-refresh baseline with the daily-refresh deltas into the
 * current set of OPEN lots, and derive per-table freshness. Pure.
 *
 * Logic (matches the verified table semantics):
 *   1. Keep only `OPEN` lots from each side.
 *   2. Anchor on the latest full-refresh `process_date` (the baseline snapshot).
 *   3. Take baseline lots at that snapshot date + daily-delta lots dated AFTER
 *      it (the daily table only adds new `open_lot_id`s; the date filter avoids
 *      re-pulling lots already in the baseline).
 *   4. Dedup by `open_lot_id`, latest `process_date` wins (insurance).
 * Freshness dates are the raw MAX(process_date)/MAX(gluerundatetime) per source
 * table — independent of the OPEN/merge filtering, so a stale-but-present table
 * is still reported accurately.
 */
/**
 * Collapse open-lot rows gathered from ONE OR MORE warehouse sources into the
 * current set of OPEN lots. Pure.
 *
 * `open_lot_id` is unique per lot across sources — the databases are replicas of
 * the same Apex feed — so the same lot arriving from two databases is the same
 * lot, and the copy with the newest `process_date` wins. That makes this
 * idempotent when sources overlap: on 2026-08-27 both db 4 and db 101 carried
 * identical delta rows for 08-22 → 08-25, and only db 4 had 08-26.
 *
 * Caller is responsible for having fetched a sensible row set (one baseline
 * snapshot plus post-anchor deltas); this function only de-duplicates and drops
 * anything not OPEN.
 */
export function mergeOpenLotRows(rows: readonly RawLotRow[]): OpenLot[] {
  const byLotId = new Map<string, RawLotRow>();
  for (const r of rows) {
    if (r.openClosedIndicator.toUpperCase() !== 'OPEN') continue;
    const existing = byLotId.get(r.openLotId);
    if (!existing || parseMs(r.processDate) >= parseMs(existing.processDate)) {
      byLotId.set(r.openLotId, r);
    }
  }
  return Array.from(byLotId.values()).map(stripToOpenLot);
}

export function mergeOpenLots(fullRows: readonly RawLotRow[], dailyRows: readonly RawLotRow[]): MergedCostBasis {
  const fullRefreshLatest = maxByTime(fullRows, (r) => r.processDate);
  const dailyRefreshLatest = maxByTime(dailyRows, (r) => r.processDate);
  const fullGlueRunLatest = maxByTime(fullRows, (r) => r.gluerun);
  const dailyGlueRunLatest = maxByTime(dailyRows, (r) => r.gluerun);

  const fullOpen = fullRows.filter((r) => r.openClosedIndicator.toUpperCase() === 'OPEN');
  const anchorMs = parseMs(fullRefreshLatest);

  const baseline = Number.isNaN(anchorMs) ? fullOpen : fullOpen.filter((r) => parseMs(r.processDate) === anchorMs);

  const dailyAfter = dailyRows.filter(
    (r) =>
      r.openClosedIndicator.toUpperCase() === 'OPEN' && (Number.isNaN(anchorMs) || parseMs(r.processDate) > anchorMs),
  );

  // Dedup by open_lot_id, keeping the row with the latest process_date.
  const byLotId = new Map<string, RawLotRow>();
  for (const r of [...baseline, ...dailyAfter]) {
    const existing = byLotId.get(r.openLotId);
    if (!existing || parseMs(r.processDate) >= parseMs(existing.processDate)) {
      byLotId.set(r.openLotId, r);
    }
  }

  return {
    lots: Array.from(byLotId.values()).map(stripToOpenLot),
    fullRefreshLatest,
    dailyRefreshLatest,
    fullGlueRunLatest,
    dailyGlueRunLatest,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function groupLotsByAccountSymbol(lots: readonly OpenLot[]): Map<string, Map<string, OpenLot[]>> {
  const byAccount = new Map<string, Map<string, OpenLot[]>>();
  for (const lot of lots) {
    let bySymbol = byAccount.get(lot.accountId);
    if (!bySymbol) {
      bySymbol = new Map<string, OpenLot[]>();
      byAccount.set(lot.accountId, bySymbol);
    }
    const arr = bySymbol.get(lot.symbol) ?? [];
    arr.push(lot);
    bySymbol.set(lot.symbol, arr);
  }
  return byAccount;
}

/**
 * Enrich a single symbol's market value with its open lots.
 *
 * Anchors to `marketValueUsd` (live, from positions) and prorates per-lot
 * market value by lot `quantity` so the short/long-term split and transfer-in
 * share reflect the currently-held value, not the (possibly stale) lot total.
 * Returns `null` when there is no usable lot quantity to anchor against (the
 * symbol stays a coverage miss rather than producing bogus gain numbers).
 */
function enrichSymbol(symbol: string, marketValueUsd: number, lots: readonly OpenLot[]): SymbolTaxEnrichment | null {
  const totalShares = lots.reduce((sum, lot) => sum + lot.quantity, 0);
  if (totalShares <= 0) return null;

  const mvPerShare = marketValueUsd / totalShares;

  let costBasisUsd = 0;
  let stGain = 0;
  let ltGain = 0;
  let transferInValueUsd = 0;
  let hasMissingBasis = false;
  let hasWashSaleAdjustment = false;

  for (const lot of lots) {
    const lotMv = mvPerShare * lot.quantity;
    const lotGain = lotMv - lot.costBasisUsd;
    costBasisUsd += lot.costBasisUsd;
    if (lot.term === 'short') stGain += lotGain;
    else ltGain += lotGain;
    if (lot.isTransferExternal) transferInValueUsd += lotMv;
    if (lot.missingBasis) hasMissingBasis = true;
    if (lot.washSaleAdjustmentUsd !== 0) hasWashSaleAdjustment = true;
  }

  const unrealizedGainUsd = marketValueUsd - costBasisUsd;
  const transferInPct = marketValueUsd !== 0 ? (transferInValueUsd / marketValueUsd) * 100 : 0;

  return {
    symbol,
    marketValueUsd: round2(marketValueUsd),
    costBasisUsd: round2(costBasisUsd),
    unrealizedGainUsd: round2(unrealizedGainUsd),
    unrealizedShortTermGainUsd: round2(stGain),
    unrealizedLongTermGainUsd: round2(ltGain),
    transferInValueUsd: round2(transferInValueUsd),
    transferInPct: round4(transferInPct),
    lotCount: lots.length,
    hasMissingBasis,
    hasWashSaleAdjustment,
  };
}

/**
 * Value a cash equivalent (money-market fund) from its market value alone.
 *
 * A $1.00-NAV fund's cost basis EQUALS its market value, so unrealized gain is
 * exactly $0 — not approximately. Verified against `apex_daily_stock_record`:
 * every MMF held in the 90 days to 2026-08-17 priced at exactly 1.00 on every
 * day, and where a real MMF lot does exist it agrees (VMSXX: 52 shares / $52
 * basis = $1.00/share).
 *
 * WHY THIS BYPASSES LOTS ENTIRELY: the Apex cost-basis feed carries essentially
 * no MMF lots at the current snapshot anchor ($52 of lots against ~$1.56M of MMF
 * market value on 2026-08-17), so MMFs would otherwise be pure coverage misses.
 * Worse, a PARTIAL lot set would be actively wrong: `enrichSymbol` prorates
 * market value across lot quantity, so $10,000 of a fund backed by a stale
 * 52-share lot would invent ~$9,948 of phantom gain. Deriving from NAV is both
 * correct and immune to that.
 *
 * `term` is unknowable from the positions feed — which costs nothing here,
 * because a $0 gain splits 0/0 across short and long. `transferInValueUsd` is
 * deliberately $0: a sweep fund is not part of the transferred-in book.
 */
function enrichCashEquivalent(symbol: string, marketValueUsd: number): SymbolTaxEnrichment {
  const mv = round2(marketValueUsd);
  return {
    symbol,
    marketValueUsd: mv,
    costBasisUsd: mv,
    unrealizedGainUsd: 0,
    unrealizedShortTermGainUsd: 0,
    unrealizedLongTermGainUsd: 0,
    transferInValueUsd: 0,
    transferInPct: 0,
    lotCount: 0,
    hasMissingBasis: false,
    hasWashSaleAdjustment: false,
    isCashEquivalent: true,
  };
}

/**
 * Build per-account tax enrichment from live positions + merged open lots.
 *
 * Pure. Iterates only symbols present in the positions feed (the fresh,
 * authoritative "what is held today"), so closed positions never leak in from
 * a stale cost-basis snapshot. Settlement cash (`AccountPositions.cashEquity`)
 * is intentionally excluded — cash has no basis and no gain.
 */
export function enrichAccountsWithCostBasis(
  positions: ReadonlyMap<string, AccountPositions>,
  lots: readonly OpenLot[],
): Map<string, AccountTaxEnrichment> {
  const lotsByAccount = groupLotsByAccountSymbol(lots);
  const out = new Map<string, AccountTaxEnrichment>();

  for (const [accountId, account] of positions) {
    const bySymbol = lotsByAccount.get(accountId);
    const investableValueUsd = account.positionsTotal;

    const symbols: SymbolTaxEnrichment[] = [];
    let enrichedValueUsd = 0;
    let unrealizedGainUsd = 0;
    let stGain = 0;
    let ltGain = 0;
    let transferInValueUsd = 0;
    let hasMissingBasis = false;

    let cashEquivalentValueUsd = 0;

    for (const [symbol, marketValueUsd] of Object.entries(account.positionsBySymbol)) {
      // Cash equivalents are valued at NAV and short-circuit the lot path
      // entirely — see enrichCashEquivalent for why lots must NOT be prorated
      // here even when a few exist.
      if (account.cashEquivalentSymbols?.has(symbol)) {
        const enriched = enrichCashEquivalent(symbol, marketValueUsd);
        symbols.push(enriched);
        enrichedValueUsd += enriched.marketValueUsd;
        cashEquivalentValueUsd += enriched.marketValueUsd;
        continue;
      }

      const symbolLots = bySymbol?.get(symbol);
      if (!symbolLots || symbolLots.length === 0) continue;
      const enriched = enrichSymbol(symbol, marketValueUsd, symbolLots);
      if (!enriched) continue;
      symbols.push(enriched);
      enrichedValueUsd += enriched.marketValueUsd;
      unrealizedGainUsd += enriched.unrealizedGainUsd;
      stGain += enriched.unrealizedShortTermGainUsd;
      ltGain += enriched.unrealizedLongTermGainUsd;
      transferInValueUsd += enriched.transferInValueUsd;
      if (enriched.hasMissingBasis) hasMissingBasis = true;
    }

    // Emit an entry for every account in positions, even with zero enriched
    // symbols (all-cash / no-basis), so the drift renderer can distinguish
    // "no tax data" from "account absent".
    symbols.sort(
      (a, b) => Math.abs(b.unrealizedGainUsd) - Math.abs(a.unrealizedGainUsd) || a.symbol.localeCompare(b.symbol),
    );

    const basisCoveragePct = investableValueUsd > 0 ? (enrichedValueUsd / investableValueUsd) * 100 : 0;
    // Securities-only denominator — cash equivalents are not part of the
    // transferred-in book. Falls back to 0 for an all-MMF account (no
    // securities to transition, so the ratio is undefined rather than 100%).
    const transferInBaseUsd = investableValueUsd - cashEquivalentValueUsd;
    const transferInPct = transferInBaseUsd > 0 ? (transferInValueUsd / transferInBaseUsd) * 100 : 0;

    out.set(accountId, {
      accountId,
      investableValueUsd: round2(investableValueUsd),
      enrichedValueUsd: round2(enrichedValueUsd),
      basisCoveragePct: round4(basisCoveragePct),
      cashEquivalentValueUsd: round2(cashEquivalentValueUsd),
      unrealizedGainUsd: round2(unrealizedGainUsd),
      unrealizedShortTermGainUsd: round2(stGain),
      unrealizedLongTermGainUsd: round2(ltGain),
      transferInValueUsd: round2(transferInValueUsd),
      transferInPct: round4(transferInPct),
      hasMissingBasis,
      symbols,
    });
  }

  return out;
}
