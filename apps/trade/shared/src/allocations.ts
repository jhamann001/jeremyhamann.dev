import type { AccountType, BaseAllocation, Residence } from './types.js';

/**
 * Exact stock / bond / cash percentages for each of the 25 risk levels.
 * These are identical across all 4 allocation models — only the underlying
 * fund selection differs.  Sourced from "Asset Allocation Profiles Final 7.4.2025".
 */
const RISK_TABLE: readonly BaseAllocation[] = [
  /*  1 */ { equity: 0, fixed: 0, cash: 100 },
  /*  2 */ { equity: 4, fixed: 72, cash: 24 },
  /*  3 */ { equity: 8, fixed: 69, cash: 23 },
  /*  4 */ { equity: 13, fixed: 66, cash: 21 },
  /*  5 */ { equity: 17, fixed: 63, cash: 20 },
  /*  6 */ { equity: 21, fixed: 60, cash: 19 },
  /*  7 */ { equity: 25, fixed: 57, cash: 18 },
  /*  8 */ { equity: 29, fixed: 55, cash: 16 },
  /*  9 */ { equity: 33, fixed: 52, cash: 15 },
  /* 10 */ { equity: 38, fixed: 48, cash: 14 },
  /* 11 */ { equity: 42, fixed: 45, cash: 13 },
  /* 12 */ { equity: 46, fixed: 43, cash: 11 },
  /* 13 */ { equity: 50, fixed: 40, cash: 10 },
  /* 14 */ { equity: 54, fixed: 37, cash: 9 },
  /* 15 */ { equity: 58, fixed: 35, cash: 7 },
  /* 16 */ { equity: 63, fixed: 31, cash: 6 },
  /* 17 */ { equity: 67, fixed: 28, cash: 5 },
  /* 18 */ { equity: 71, fixed: 25, cash: 4 },
  /* 19 */ { equity: 75, fixed: 23, cash: 2 },
  /* 20 */ { equity: 79, fixed: 20, cash: 1 },
  /* 21 */ { equity: 83, fixed: 17, cash: 0 },
  /* 22 */ { equity: 88, fixed: 12, cash: 0 },
  /* 23 */ { equity: 92, fixed: 8, cash: 0 },
  /* 24 */ { equity: 96, fixed: 4, cash: 0 },
  /* 25 */ { equity: 100, fixed: 0, cash: 0 },
];

export function getRiskAllocation(score: number): BaseAllocation {
  if (!Number.isFinite(score)) {
    throw new Error(`Invalid risk score: ${score}`);
  }
  const idx = Math.max(0, Math.min(24, Math.round(score) - 1));
  return { ...RISK_TABLE[idx] };
}

// ─── Money-market template tickers ──────────────────────────────────────────
// Each (accountType, residence) combination maps to exactly one template MMK
// ticker. Mirrors `selectModel()` in server/src/data/allocationProfiles.ts —
// keep these in sync.

export type TemplateMmkTicker = 'SWVXX' | 'VMSXX' | 'VYFXX' | 'VCTXX';

export const TEMPLATE_MMK_TICKERS: readonly TemplateMmkTicker[] = ['SWVXX', 'VMSXX', 'VYFXX', 'VCTXX'];

const TEMPLATE_MMK_SET = new Set<string>(TEMPLATE_MMK_TICKERS);

/**
 * Returns the template money-market ticker that matches an account's
 * (accountType, residence). IRAs always use the taxable national MMK
 * regardless of residence; taxable / joint accounts use the residence-aware
 * muni MMK.
 */
export function allowedCashTicker(accountType: AccountType, residence: Residence): TemplateMmkTicker {
  if (accountType === 'Traditional IRA' || accountType === 'Roth IRA') return 'SWVXX';
  if (residence === 'NY') return 'VYFXX';
  if (residence === 'CA') return 'VCTXX';
  return 'VMSXX';
}

/**
 * True if `symbol` is one of the four template MMK tickers tied to a specific
 * (accountType, residence) combination. Case-insensitive, trims whitespace.
 * Other money-market funds (VUSXX, SPAXX, VMFXX, etc.) return false here —
 * use `isKnownMmkTicker` to recognize them as MMKs for validation purposes.
 */
export function isTemplateMmkTicker(symbol: string): symbol is TemplateMmkTicker {
  return TEMPLATE_MMK_SET.has(symbol.trim().toUpperCase());
}

// ─── Known (non-template) MMK universe ──────────────────────────────────────
// Mirrors the money-market entries in server/src/data/instruments.ts. These
// are real funds that show up in production stock-record data and Meridian
// templates, but none of them is the firm's policy template for a given
// (accountType, residence) combination — so using one in the equity strategy
// section is treated as a policy deviation and requires a rationale override.

export type KnownMmkTicker =
  | TemplateMmkTicker
  | 'VUSXX' // Vanguard Treasury Money Market
  | 'SWKXX' // Schwab Municipal Money Fund
  | 'VMFXX' // Vanguard Federal MMF
  | 'VMRXX' // Vanguard Cash Reserves Federal MMF
  | 'FZFXX' // Fidelity Treasury MMF
  | 'SPAXX' // Fidelity Government MMF
  | 'SPRXX' // Fidelity Money Market Fund
  | 'FDRXX' // Fidelity Government Cash Reserves
  | 'PCOXX' // Federated Hermes Prime Cash Obligations
  | 'BUPXX' // BlackRock Liquidity FedFund Premier
  | 'GMMXX'; // Goldman Sachs Financial Square Government

export const KNOWN_MMK_TICKERS: readonly KnownMmkTicker[] = [
  ...TEMPLATE_MMK_TICKERS,
  'VUSXX',
  'SWKXX',
  'VMFXX',
  'VMRXX',
  'FZFXX',
  'SPAXX',
  'SPRXX',
  'FDRXX',
  'PCOXX',
  'BUPXX',
  'GMMXX',
];

const KNOWN_MMK_SET = new Set<string>(KNOWN_MMK_TICKERS);

/**
 * True if `symbol` is any recognized money-market fund ticker (template or
 * otherwise). Case-insensitive, trims whitespace. Non-MMK symbols pass
 * through without validation.
 */
export function isKnownMmkTicker(symbol: string): symbol is KnownMmkTicker {
  return KNOWN_MMK_SET.has(symbol.trim().toUpperCase());
}
