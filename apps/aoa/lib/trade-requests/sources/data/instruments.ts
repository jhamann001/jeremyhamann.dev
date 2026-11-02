/**
 * Master list of fixed income and money market instruments.
 * Source: "Fixed Income and MMK Instrument List" (7.2.2025)
 */

export interface Instrument {
  symbol: string;
  name: string;
  type: string;
}

export const INSTRUMENTS: Record<string, Instrument> = {
  // ─── Taxable National ────────────────────────────────────────────────────
  SWVXX: { symbol: 'SWVXX', name: 'Schwab Value Advantage Money Fund', type: 'Money Market Mutual Fund (Taxable)' },
  VGSH: { symbol: 'VGSH', name: 'Vanguard Short-Term Treasury ETF', type: 'Treasury Bond ETF (Taxable)' },
  SCHO: { symbol: 'SCHO', name: 'Schwab Short-Term U.S. Treasury ETF', type: 'Treasury Bond ETF (Taxable)' },
  VCSH: { symbol: 'VCSH', name: 'Vanguard Short-Term Corporate Bond ETF', type: 'Corporate Bond ETF (Taxable)' },
  AGG: { symbol: 'AGG', name: 'iShares Core U.S. Aggregate Bond ETF', type: 'Core U.S. Bond ETF (Taxable)' },
  SCHR: { symbol: 'SCHR', name: 'Schwab Intermediate-Term U.S. Treasury ETF', type: 'Treasury Bond ETF (Taxable)' },
  SHYG: {
    symbol: 'SHYG',
    name: 'iShares 0-5 Year High Yield Corporate Bond ETF',
    type: 'Short-Term High Yield Bond ETF (Taxable)',
  },

  // ─── National Tax Efficient ──────────────────────────────────────────────
  VMSXX: {
    symbol: 'VMSXX',
    name: 'Vanguard Municipal Money Market Fund',
    type: 'Money Market Mutual Fund (Tax-Exempt National)',
  },
  VTEB: { symbol: 'VTEB', name: 'Vanguard Tax-Exempt Bond ETF', type: 'Municipal Bond ETF (National)' },
  SUB: { symbol: 'SUB', name: 'iShares Short-Term National Muni Bond ETF', type: 'Municipal Bond ETF (National)' },
  MUB: { symbol: 'MUB', name: 'iShares National Muni Bond ETF', type: 'Municipal Bond ETF (National)' },

  // ─── New York ────────────────────────────────────────────────────────────
  VYFXX: {
    symbol: 'VYFXX',
    name: 'Vanguard New York Municipal Money Market Fund',
    type: 'Money Market Mutual Fund (Tax-Exempt NY)',
  },
  VNYTX: {
    symbol: 'VNYTX',
    name: 'Vanguard New York Long-Term Tax-Exempt Fund',
    type: 'Municipal Bond Mutual Fund (New York)',
  },

  // ─── California ──────────────────────────────────────────────────────────
  VCTXX: {
    symbol: 'VCTXX',
    name: 'Vanguard California Tax-Exempt Money Market Fund',
    type: 'Money Market Mutual Fund (Tax-Exempt CA)',
  },
  VCAIX: {
    symbol: 'VCAIX',
    name: 'Vanguard California Intermediate-Term Tax-Exempt Fund',
    type: 'Municipal Bond Mutual Fund (California)',
  },

  // ─── Treasury Money Market (reference only) ──────────────────────────────
  VUSXX: { symbol: 'VUSXX', name: 'Vanguard Treasury Money Market Fund', type: 'Treasury Money Market Mutual Fund' },

  // ─── Drift Detection Additions (no allocation template) ───────────────────
  // Bond / cash tickers that appear in production stock-record data
  // and Meridian's templates but are not part of any in-app
  // allocation profile. Listed here purely so classifySymbol() routes
  // them to the correct cash / fixed bucket — they do not belong to
  // any state-specific or template-specific group.
  BND: { symbol: 'BND', name: 'Vanguard Total Bond Market ETF', type: 'Core U.S. Bond ETF (Taxable)' },
  SGOV: { symbol: 'SGOV', name: 'iShares 0-3 Month Treasury Bond ETF', type: 'Treasury Bond ETF (Taxable)' },
  SCMB: { symbol: 'SCMB', name: 'Schwab Municipal Bond ETF', type: 'Municipal Bond ETF (National)' },
  PZA: { symbol: 'PZA', name: 'Invesco National AMT-Free Municipal Bond ETF', type: 'Municipal Bond ETF (National)' },
  ITM: { symbol: 'ITM', name: 'VanEck Intermediate Muni ETF', type: 'Municipal Bond ETF (National)' },
  SWKXX: {
    symbol: 'SWKXX',
    name: 'Schwab Municipal Money Fund',
    type: 'Money Market Mutual Fund (Taxable)',
  },

  // ─── Money-Market Funds (Drift v2 R1 resolution — see docs/plans/2026-q3-drift-v2-accounts.md §4.6) ───
  VMFXX: {
    symbol: 'VMFXX',
    name: 'Vanguard Federal Money Market Fund',
    type: 'Money Market Mutual Fund (Taxable)',
  },
  VMRXX: {
    symbol: 'VMRXX',
    name: 'Vanguard Cash Reserves Federal Money Market Fund',
    type: 'Money Market Mutual Fund (Taxable)',
  },
  FZFXX: {
    symbol: 'FZFXX',
    name: 'Fidelity Treasury Money Market Fund',
    type: 'Money Market Mutual Fund (Taxable)',
  },
  SPAXX: {
    symbol: 'SPAXX',
    name: 'Fidelity Government Money Market Fund',
    type: 'Money Market Mutual Fund (Taxable)',
  },
  SPRXX: {
    symbol: 'SPRXX',
    name: 'Fidelity Money Market Fund',
    type: 'Money Market Mutual Fund (Taxable)',
  },
  FDRXX: {
    symbol: 'FDRXX',
    name: 'Fidelity Government Cash Reserves',
    type: 'Money Market Mutual Fund (Taxable)',
  },

  // ─── Money-Market Funds (Drift v2 R2 — production safety-net hits) ───
  // Added after the v2 cutover surfaced these tickers via the
  // `drift_suspected_cash_equiv_misclassified` warn log. All three are
  // verified $1.00-NAV money-market funds; classified to cash here so the
  // safety net no longer fires on them.
  PCOXX: {
    symbol: 'PCOXX',
    name: 'Federated Hermes Prime Cash Obligations Fund (Wealth)',
    type: 'Money Market Mutual Fund (Taxable)',
  },
  BUPXX: {
    symbol: 'BUPXX',
    name: 'BlackRock Liquidity FedFund Premier',
    type: 'Money Market Mutual Fund (Taxable)',
  },
  GMMXX: {
    symbol: 'GMMXX',
    name: 'Goldman Sachs Financial Square Government Fund',
    type: 'Money Market Mutual Fund (Taxable)',
  },
};

// ─── Classification helpers ─────────────────────────────────────────────────

const MONEY_MARKET_PATTERN = /money\s*market/i;

export const CASH_SYMBOLS = new Set(
  Object.values(INSTRUMENTS)
    .filter((i) => MONEY_MARKET_PATTERN.test(i.type))
    .map((i) => i.symbol),
);

export const FIXED_INCOME_SYMBOLS = new Set(
  Object.values(INSTRUMENTS)
    .filter((i) => !MONEY_MARKET_PATTERN.test(i.type))
    .map((i) => i.symbol),
);

export type AssetCategory = 'cash' | 'fixed' | 'equity';

/**
 * Classify a position symbol into cash, fixed income, or equity.
 * - Known money-market instruments → cash
 * - Known bond/fixed-income instruments → fixed
 * - Cash-like symbols (sweep balances, USD, empty) → cash
 * - Everything else → equity
 */
export function classifySymbol(symbol: string): AssetCategory {
  const normalized = symbol.trim().toUpperCase();

  if (!normalized || normalized === 'CASH' || normalized === 'USD') return 'cash';
  if (CASH_SYMBOLS.has(normalized)) return 'cash';
  if (FIXED_INCOME_SYMBOLS.has(normalized)) return 'fixed';
  return 'equity';
}

/**
 * Apex `symbol_description` patterns that name a money-market fund.
 *
 * Paired with the $1.00-NAV price test in `isDerivedMoneyMarketFund` as a
 * second, INDEPENDENT signal. Verified against `apex_daily_stock_record` over
 * the 90 days to 2026-08-17: the price test and this pattern agree on all 8
 * MMFs held in that window (SWVXX, VMSXX, VYFXX, VCTXX, VMFXX, BUPXX, PCOXX,
 * GMMXX), and no non-MMF mutual fund matches either test.
 */
const MMF_DESCRIPTION_PATTERN = /MONEY\s*(MKT|MARKET)|LIQUIDITY|CASH\s*OBLIGATIONS|FEDFUND/i;

/**
 * Identify a money-market fund from the raw `apex_daily_stock_record` columns
 * instead of the curated `CASH_SYMBOLS` list.
 *
 * WHY: `CASH_SYMBOLS` is hand-maintained and has been patched reactively twice
 * (the R1/R2 blocks above), each time AFTER a new MMF ticker classified as
 * `equity` and tripped `drift_suspected_cash_equiv_misclassified` in prod. This
 * rule is self-maintaining: a new MMF classifies correctly on first sight.
 *
 * Deliberately requires `MUTUAL_FUND` so an ordinary stock trading at exactly
 * $1.00, or an operating company with "LIQUIDITY" in its name, can't match.
 * Price and description are OR'd so a fund that breaks the buck (NAV ≠ 1.00) is
 * still caught by name, and a $1.00-NAV fund with an unusual name is still
 * caught by price.
 *
 * Used promote-only — it can reclassify an `equity` default to cash, never
 * demote a curated cash/fixed classification. Mirrors the `effectiveBucket`
 * pattern used for the security-sector overrides.
 */
export function isDerivedMoneyMarketFund(input: {
  assetType?: string | null;
  closingPrice?: number | null;
  symbolDescription?: string | null;
}): boolean {
  if ((input.assetType ?? '').trim().toUpperCase() !== 'MUTUAL_FUND') return false;
  if (input.closingPrice === 1) return true;
  return MMF_DESCRIPTION_PATTERN.test(input.symbolDescription ?? '');
}

/**
 * True when a held symbol is a cash equivalent — curated list OR derived rule.
 *
 * The cash-equivalent distinction matters beyond bucketing: a $1.00-NAV fund's
 * cost basis EQUALS its market value, so its unrealized gain is exactly $0 and
 * it needs no tax lots to be fully accounted for. See
 * `costBasisEnrichment.ts`.
 */
export function isCashEquivalentSymbol(
  symbol: string,
  meta?: { assetType?: string | null; closingPrice?: number | null; symbolDescription?: string | null },
): boolean {
  if (classifySymbol(symbol) === 'cash') return true;
  return meta ? isDerivedMoneyMarketFund(meta) : false;
}

/**
 * Classify an Meridian template constituent into cash/fixed/equity using
 * its `securityType` discriminator.
 *
 * Rules (locked by 2026-Q3 cutover plan §2 decision #7):
 *   - `IndividualSecurity` (or `undefined` for defensive forward-compat): use
 *     the `security` field as a ticker and route through `classifySymbol`.
 *     These are the cash/fixed bucket targets we honor at per-symbol granularity.
 *   - `My Firm` or `Personal`: equity bucket, full stop. The `security` field
 *     is an opaque Meridian-side ID (e.g. `DDnHo3QE52MbAd3RTDrU2G`); we do
 *     not attempt to map it to a ticker. Aggregating allocation into the equity
 *     bucket is the entire signal we extract from these constituents.
 *   - Anything else (a 4th unseen value): defaults to `equity` AND emits a
 *     structured warn log (`drift_template_unknown_security_type`) so ops sees
 *     it before a drift run misroutes.
 *
 * NB: the warn log is emitted via a lazy import of `logger` so this helper
 * stays a pure synchronous function for the comparator's hot path. Tests can
 * stub the logger via the standard `vi.mock('@/lib/trade-requests/log', ...)` pattern.
 */
export function classifyTemplateConstituent(
  c: { security: string; securityType?: string },
  // Caller-supplied logger lets tests assert on the warn-log call without
  // pulling the heavy logger dependency through this module's compile graph.
  warnLogger?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): AssetCategory {
  const t = c.securityType;
  if (t === 'IndividualSecurity' || t === undefined) return classifySymbol(c.security);
  if (t === 'My Firm' || t === 'Personal') return 'equity';
  warnLogger?.warn(
    { event: 'drift_template_unknown_security_type', security: c.security, securityType: t },
    'meridian template constituent: unknown securityType, defaulting to equity bucket',
  );
  return 'equity';
}
