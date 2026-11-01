/**
 * SIC → GICS-style sector crosswalk + Apex→provider ticker normalization.
 * Pure, no I/O. Used by the security-sector backfill to turn a raw SIC code
 * (from Massive's ticker reference) into one of the 11 standard sectors.
 *
 * IMPORTANT: this is an APPROXIMATION. SIC (a US government industry scheme) does
 * not map 1:1 to GICS (proprietary, MSCI/S&P). The range table below captures
 * the common cases; `TICKER_SECTOR_OVERRIDES` fixes the well-known GICS-vs-SIC
 * disagreements (Alphabet/Meta = Communication Services, Visa/Mastercard = IT,
 * etc.). For accounts in an Meridian transition we prefer the feed's own
 * sector (true GICS) over this crosswalk.
 */

export type Sector =
  | 'Information Technology'
  | 'Health Care'
  | 'Financials'
  | 'Consumer Discretionary'
  | 'Consumer Staples'
  | 'Communication Services'
  | 'Industrials'
  | 'Energy'
  | 'Materials'
  | 'Utilities'
  | 'Real Estate'
  | 'Unclassified';

/**
 * Yahoo Finance uses its own sector taxonomy (`assetProfile.sector`). It maps
 * 1:1 to our GICS-style enum. Used by the Yahoo enrichment pass to classify
 * ADRs / foreign issuers that Massive's SIC scheme can't (SIC is US-only).
 */
const YAHOO_SECTOR_MAP: Record<string, Sector> = {
  Technology: 'Information Technology',
  'Financial Services': 'Financials',
  Financial: 'Financials',
  Healthcare: 'Health Care',
  'Consumer Cyclical': 'Consumer Discretionary',
  'Consumer Defensive': 'Consumer Staples',
  'Communication Services': 'Communication Services',
  Industrials: 'Industrials',
  Energy: 'Energy',
  'Basic Materials': 'Materials',
  Utilities: 'Utilities',
  'Real Estate': 'Real Estate',
};

/** Map a Yahoo sector string to our enum; null if unknown/empty. */
export function mapYahooSector(yahooSector: string | null | undefined): Sector | null {
  if (!yahooSector) return null;
  return YAHOO_SECTOR_MAP[yahooSector.trim()] ?? null;
}

/** Runtime list of every sector (for validation / CSV templates / UI menus). */
export const SECTORS: readonly Sector[] = [
  'Information Technology',
  'Health Care',
  'Financials',
  'Consumer Discretionary',
  'Consumer Staples',
  'Communication Services',
  'Industrials',
  'Energy',
  'Materials',
  'Utilities',
  'Real Estate',
  'Unclassified',
];

/**
 * Apex carries class shares without a dot (BRKB); Massive/Polygon-style refs use
 * a dot (BRK.B). Only well-known cases are listed — passthrough otherwise.
 */
const TICKER_NORMALIZE: Record<string, string> = {
  BRKB: 'BRK.B',
  BRKA: 'BRK.A',
  BFB: 'BF.B',
  BFA: 'BF.A',
  HEIA: 'HEI.A',
  LENB: 'LEN.B',
  MOGA: 'MOG.A',
  UHALB: 'UHAL.B',
};

/**
 * Normalize an Apex symbol to the provider ticker, or return `null` when it's
 * not a fetchable equity ticker (internal placeholders, warrants, blanks).
 */
export function normalizeTicker(symbol: string): string | null {
  const s = (symbol ?? '').trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith('#')) return null; // internal/placeholder (e.g. #ZZ10003)
  if (/\s/.test(s)) return null;
  if (s.endsWith('WS')) return null; // warrants (BBBYWS, GMEWS, DSXWS)
  return TICKER_NORMALIZE[s] ?? s;
}

/**
 * GICS-canonical overrides where the SIC range would land in the "wrong" sector.
 * Keyed by NORMALIZED ticker. Extend as misclassifications surface.
 */
const TICKER_SECTOR_OVERRIDES: Record<string, Sector> = {
  GOOGL: 'Communication Services',
  GOOG: 'Communication Services',
  META: 'Communication Services',
  NFLX: 'Communication Services',
  DIS: 'Communication Services',
  V: 'Information Technology', // GICS: Visa is IT, not Financials
  MA: 'Information Technology', // GICS: Mastercard is IT
  PYPL: 'Financials',
  FI: 'Financials',
  ABNB: 'Consumer Discretionary',
};

/**
 * Map a 4-digit SIC code to a sector via range. Returns 'Unclassified' for codes
 * that don't fit (public admin, unknown). Order matters — narrower carve-outs
 * (pharma, software, semis, REITs) are checked inside their broader ranges.
 */
export function sicToSector(sicCode: string | null | undefined): Sector {
  const sic = parseInt((sicCode ?? '').trim(), 10);
  if (!Number.isFinite(sic) || sic <= 0) return 'Unclassified';

  // Pharma / biological / medical devices (carve-outs inside chemicals/instruments)
  if (sic >= 2833 && sic <= 2836) return 'Health Care';
  if (sic >= 3840 && sic <= 3851) return 'Health Care';

  // Computer hardware / software / semis (carve-outs inside machinery/electronics/services)
  if (sic >= 3570 && sic <= 3579) return 'Information Technology';
  if (sic >= 3670 && sic <= 3679) return 'Information Technology';
  if (sic >= 7370 && sic <= 7379) return 'Information Technology';

  // Motor vehicles (carve-out inside transportation equipment)
  if (sic >= 3710 && sic <= 3716) return 'Consumer Discretionary';

  // REITs (carve-out inside holding/investment offices)
  if (sic === 6798) return 'Real Estate';

  // Pipelines (carve-out inside transportation)
  if (sic >= 4610 && sic <= 4619) return 'Energy';

  // Broad ranges
  if (sic <= 999) return 'Consumer Staples'; // agriculture/food/forestry
  if (sic >= 1000 && sic <= 1299) return 'Materials'; // metal/coal mining
  if (sic >= 1300 && sic <= 1399) return 'Energy'; // oil & gas extraction
  if (sic >= 1400 && sic <= 1499) return 'Materials';
  if (sic >= 1500 && sic <= 1799) return 'Industrials'; // construction
  if (sic >= 2000 && sic <= 2199) return 'Consumer Staples'; // food, tobacco
  if (sic >= 2200 && sic <= 2399) return 'Consumer Discretionary'; // textiles/apparel
  if (sic >= 2400 && sic <= 2499) return 'Materials'; // lumber
  if (sic >= 2500 && sic <= 2599) return 'Consumer Discretionary'; // furniture
  if (sic >= 2600 && sic <= 2699) return 'Materials'; // paper
  if (sic >= 2700 && sic <= 2799) return 'Communication Services'; // publishing
  if (sic >= 2800 && sic <= 2899) return 'Materials'; // chemicals (pharma carved out above)
  if (sic >= 2900 && sic <= 2999) return 'Energy'; // petroleum refining
  if (sic >= 3000 && sic <= 3399) return 'Materials'; // rubber/plastics/metal
  if (sic >= 3400 && sic <= 3499) return 'Industrials'; // fabricated metal
  if (sic >= 3500 && sic <= 3599) return 'Industrials'; // industrial machinery (computers carved out)
  if (sic >= 3600 && sic <= 3699) return 'Information Technology'; // electronics
  if (sic >= 3700 && sic <= 3799) return 'Industrials'; // transport equip (autos carved out)
  if (sic >= 3800 && sic <= 3899) return 'Information Technology'; // instruments (medical carved out)
  if (sic >= 3900 && sic <= 3999) return 'Consumer Discretionary'; // misc mfg (toys, jewelry)
  if (sic >= 4000 && sic <= 4799) return 'Industrials'; // transportation
  if (sic >= 4800 && sic <= 4899) return 'Communication Services'; // communications
  if (sic >= 4900 && sic <= 4999) return 'Utilities';
  if (sic >= 5000 && sic <= 5199) return 'Consumer Discretionary'; // wholesale
  if (sic >= 5200 && sic <= 5399) return 'Consumer Discretionary'; // retail (general)
  if (sic >= 5400 && sic <= 5499) return 'Consumer Staples'; // food stores
  if (sic >= 5500 && sic <= 5599) return 'Consumer Discretionary'; // auto dealers
  if (sic >= 5600 && sic <= 5799) return 'Consumer Discretionary';
  if (sic === 5912) return 'Consumer Staples'; // drug stores
  if (sic >= 5800 && sic <= 5999) return 'Consumer Discretionary'; // restaurants/misc retail
  if (sic >= 6000 && sic <= 6499) return 'Financials'; // banks/brokers/insurance
  if (sic >= 6500 && sic <= 6599) return 'Real Estate';
  if (sic >= 6700 && sic <= 6799) return 'Financials'; // holding/investment (REIT carved out)
  if (sic >= 7000 && sic <= 7099) return 'Consumer Discretionary'; // hotels
  if (sic >= 7200 && sic <= 7299) return 'Consumer Discretionary'; // personal services
  if (sic >= 7300 && sic <= 7399) return 'Industrials'; // business services (software carved out)
  if (sic >= 7800 && sic <= 7999) return 'Communication Services'; // motion pictures/recreation
  if (sic >= 8000 && sic <= 8099) return 'Health Care'; // health services
  if (sic >= 8200 && sic <= 8299) return 'Consumer Discretionary'; // education
  if (sic >= 8700 && sic <= 8799) return 'Industrials'; // engineering/research/mgmt

  return 'Unclassified';
}

/** Resolve a sector for a (ticker, sic) pair — ticker override wins over SIC. */
export function classifySector(ticker: string, sicCode: string | null | undefined): Sector {
  const override = TICKER_SECTOR_OVERRIDES[ticker.trim().toUpperCase()];
  if (override) return override;
  return sicToSector(sicCode);
}
