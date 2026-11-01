/**
 * Minimal Yahoo Finance client for the sector backfill — classifies the ADRs /
 * foreign issuers that Massive's SIC scheme can't (SIC is a US-only taxonomy).
 * Isolated like massiveClient: only the one-time backfill calls this; the
 * nightly drift run reads the cached `security_sector` table.
 *
 * Uses the unofficial `yahoo-finance2` library (handles Yahoo's cookie/crumb
 * handshake). Yahoo has no official API — accept the reliability/ToS risk for
 * internal use. Rate-limited, so the backfill throttles + is resumable.
 *
 * Two classification axes come back here:
 *   - individual equities (incl. ADRs) → a GICS `sector` from `assetProfile`;
 *   - ETFs / mutual funds → a `category` (Morningstar) from `fundProfile`, which
 *     we roll up to an asset class elsewhere. `quoteType` says which axis applies.
 */
import YahooFinance from 'yahoo-finance2';
import { mapYahooSector, type Sector } from '../data/sicToSector.js';

// yahoo-finance2 v3 is class-based: instantiate once. `suppressNotices` quiets
// the survey banner; `validation.logErrors:false` silences the noisy
// schema-mismatch logging (we still recover partial data from err.result).
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'], validation: { logErrors: false } });

/** Loosely-typed slice of the quoteSummary modules we read. */
interface QuoteSummarySlice {
  price?: { quoteType?: string | null; longName?: string | null; shortName?: string | null };
  assetProfile?: { sector?: string | null };
  fundProfile?: { categoryName?: string | null; family?: string | null };
}

/**
 * yahoo-finance2 v3 throws a validation error when Yahoo returns fields its
 * schema doesn't expect — but it attaches the (usable) parsed payload to
 * `err.result`. Recover it so a strict-schema hiccup doesn't lose real data.
 */
function resultFromError(err: unknown): QuoteSummarySlice | null {
  const r = (err as { result?: unknown })?.result;
  if (Array.isArray(r)) return (r[0] ?? null) as QuoteSummarySlice | null;
  if (r && typeof r === 'object') return r as QuoteSummarySlice;
  return null;
}

export class YahooRateLimitError extends Error {
  constructor(message = 'Yahoo rate limit') {
    super(message);
    this.name = 'YahooRateLimitError';
  }
}

export type YahooQuoteType = 'EQUITY' | 'ETF' | 'MUTUALFUND' | 'OTHER';

export interface YahooProfile {
  ticker: string;
  /** Coarse instrument kind from Yahoo. EQUITY includes ADRs. */
  quoteType: YahooQuoteType;
  /** Raw Yahoo sector string (null for funds / unknown). */
  rawSector: string | null;
  /** Mapped to our enum (null when unmappable or a fund). */
  sector: Sector | null;
  /** Raw Morningstar fund category (funds only; null for single stocks). */
  category: string | null;
  name: string | null;
}

function coerceQuoteType(qt: string | undefined): YahooQuoteType {
  const t = (qt ?? '').toUpperCase();
  if (t === 'EQUITY' || t === 'ETF' || t === 'MUTUALFUND') return t;
  return 'OTHER';
}

function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|too many requests|rate limit|edge: not found/i.test(msg);
}

/**
 * Fetch a ticker's Yahoo profile. Returns:
 *   - the profile on success (sector populated only for classifiable equities),
 *   - `null` when Yahoo has no record of the symbol,
 *   - throws `YahooRateLimitError` on a 429 (caller backs off + retries),
 *   - throws on other unexpected errors.
 */
export async function fetchYahooProfile(ticker: string): Promise<YahooProfile | null> {
  let res: QuoteSummarySlice;
  try {
    res = (await yahooFinance.quoteSummary(ticker, {
      modules: ['assetProfile', 'fundProfile', 'price'],
    })) as unknown as QuoteSummarySlice;
  } catch (err) {
    if (isRateLimit(err)) throw new YahooRateLimitError();
    // A schema-validation throw still carries the parsed payload — recover it.
    const recovered = resultFromError(err);
    if (recovered) {
      res = recovered;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|no data|quote not found|404|failed to find/i.test(msg)) return null;
      throw err;
    }
  }

  const quoteType = coerceQuoteType(res.price?.quoteType ?? undefined);
  const rawSector = res.assetProfile?.sector ?? null;
  // Sector applies only to genuine equities (incl. ADRs); funds use category.
  const sector = quoteType === 'EQUITY' ? mapYahooSector(rawSector) : null;
  const category = quoteType === 'ETF' || quoteType === 'MUTUALFUND' ? (res.fundProfile?.categoryName ?? null) : null;
  return {
    ticker,
    quoteType,
    rawSector,
    sector,
    category,
    name: res.price?.longName ?? res.price?.shortName ?? null,
  };
}
