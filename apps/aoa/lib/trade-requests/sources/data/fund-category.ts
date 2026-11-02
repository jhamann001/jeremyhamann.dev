/**
 * Fund classification axis (ETFs / mutual funds) — the asset-class taxonomy used
 * INSTEAD of GICS, since a basket isn't one company. We roll Yahoo's ~130
 * granular Morningstar categories (`fundProfile.categoryName`) up to a small set
 * of asset classes, and map each to the drift cash/fixed/equity bucket.
 *
 * Pattern-based (not an exhaustive lookup) so it degrades gracefully on
 * categories we haven't seen. Order matters: fixed-income + money-market checks
 * run BEFORE equity ones so e.g. "Emerging Markets Bond" → Global Bond, not EM
 * Equity. The raw category is stored alongside, so this rollup can be retuned
 * without re-fetching from Yahoo.
 */

export type AssetClass =
  | 'US Equity'
  | 'Intl Equity'
  | 'EM Equity'
  | 'Sector Equity'
  | 'Real Estate'
  | 'US Bond'
  | 'Muni Bond'
  | 'High Yield Bond'
  | 'Global Bond'
  | 'Short-Term Bond'
  | 'Money Market'
  | 'Commodity'
  | 'Allocation'
  | 'Alternative';

export type DriftBucket = 'cash' | 'fixed' | 'equity';

/** Which cash/fixed/equity bucket each asset class rolls into for drift math. */
const BUCKET_BY_ASSET_CLASS: Record<AssetClass, DriftBucket> = {
  'Money Market': 'cash',
  'US Bond': 'fixed',
  'Muni Bond': 'fixed',
  'High Yield Bond': 'fixed',
  'Global Bond': 'fixed',
  'Short-Term Bond': 'fixed',
  'US Equity': 'equity',
  'Intl Equity': 'equity',
  'EM Equity': 'equity',
  'Sector Equity': 'equity',
  'Real Estate': 'equity', // GICS Real Estate is an equity sector
  Commodity: 'equity', // not cash/fixed; 3-bucket model has no 'alt', so non-fixed/non-cash → equity
  Allocation: 'equity', // mixed; treat the sleeve as equity until per-fund look-through exists
  Alternative: 'equity',
};

export function bucketForAssetClass(ac: AssetClass | string): DriftBucket {
  // Default unknown/legacy strings to equity (the non-cash/non-fixed bucket).
  return BUCKET_BY_ASSET_CLASS[ac as AssetClass] ?? 'equity';
}

/**
 * Roll a raw Yahoo/Morningstar fund category up to an asset class.
 * Returns null for empty/unrecognized input (caller leaves it unclassified).
 */
export function classifyFundCategory(raw: string | null | undefined): AssetClass | null {
  if (!raw) return null;
  const c = raw.trim().toLowerCase();
  if (!c) return null;

  // ── Money market (before bonds — "money market" contains neither) ──
  if (/money market/.test(c)) return 'Money Market';

  // ── Fixed income (before any equity check) ──
  const looksBond =
    /\bbond\b|government|treasury|\btips\b|inflation-protected|mortgage|\bmuni|municipal|fixed income|bank loan|stable value|securitized|corporate|\bcredit\b|emerging.markets local/.test(
      c,
    );
  if (looksBond) {
    if (/muni|municipal/.test(c)) return 'Muni Bond';
    if (/high.yield/.test(c)) return 'High Yield Bond';
    if (/global|world|international|emerging/.test(c)) return 'Global Bond';
    if (/ultrashort|ultra.short|short.term bond|short government/.test(c)) return 'Short-Term Bond';
    return 'US Bond';
  }
  // Ultrashort/short funds sometimes omit "bond" (e.g. "Ultrashort").
  if (/ultrashort|ultra.short/.test(c)) return 'Short-Term Bond';

  // ── Commodity / real estate / allocation ──
  if (/commodit|precious metals(?! equity)/.test(c) && !/equity precious/.test(c)) return 'Commodity';
  if (/real estate|reit/.test(c)) return 'Real Estate';
  if (
    /target.date|target.risk|allocation|balanced|tactical|moderate|conservative allocation|aggressive allocation/.test(
      c,
    )
  )
    return 'Allocation';

  // ── Equity ── (EM before Intl before sector before US-style)
  if (/emerging|china region|india equity|latin america|frontier|pacific\/asia ex-japan/.test(c)) return 'EM Equity';
  if (
    /foreign|world (large|small|stock)|global (large|small|equity|stock)|europe|japan|china|diversified international|international|pacific/.test(
      c,
    )
  )
    return 'Intl Equity';
  if (
    /technology|health|financial|\benergy\b|natural resources|utilities|communications?|consumer|industrials|equity precious metals|equity energy|miscellaneous sector|infrastructure|materials/.test(
      c,
    )
  )
    return 'Sector Equity';
  if (
    /(large|mid|small).?cap|(large|mid|small)[ -](value|blend|growth)|\bvalue\b|\bblend\b|\bgrowth\b|dividend|equity/.test(
      c,
    )
  )
    return 'US Equity';

  return null;
}
