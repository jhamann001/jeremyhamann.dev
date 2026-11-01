import type { Pool } from 'pg';
import type { Sector } from '../data/sicToSector.js';
import { bucketForAssetClass, type AssetClass, type DriftBucket } from '../data/fundCategory.js';

/**
 * Read/write layer for the `security_sector` cache. The backfill script writes
 * it; the drift run reads it via `getSectorMap`. No external API calls here.
 */

export interface UpsertSecuritySectorInput {
  ticker: string; // normalized
  sourceSymbol: string | null;
  name: string | null;
  sicCode: string | null;
  sicDescription: string | null;
  sector: Sector | null;
  source: string; // 'massive' | 'yahoo' | 'yahoo:fund' | 'meridian' | 'manual' | ...
  resolved: boolean;
  // Fund axis (ETFs / mutual funds) — null for single stocks.
  category?: string | null; // raw Yahoo/Morningstar category
  assetClass?: string | null; // rolled-up asset class
  instrumentKind?: string | null; // 'equity' | 'etf' | 'mutualfund' | 'other'
}

/**
 * Upsert one cache row. On conflict, increments `attempts` and refreshes the
 * classification. A row is `resolved` once we have a usable answer (even
 * 'Unclassified' from Massive counts — we won't get more), so the backfill
 * won't re-fetch it. Unresolved rows (e.g. 404 / format miss) keep
 * `resolved=false` and accumulate attempts for the resume cap.
 */
export async function upsertSecuritySector(pool: Pool, row: UpsertSecuritySectorInput): Promise<void> {
  await pool.query(
    `INSERT INTO security_sector
       (ticker, source_symbol, name, sic_code, sic_description, sector, source, resolved,
        category, asset_class, instrument_kind, attempts, last_attempt_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, now(), now())
     ON CONFLICT (ticker) DO UPDATE SET
       source_symbol   = EXCLUDED.source_symbol,
       name            = COALESCE(EXCLUDED.name, security_sector.name),
       sic_code        = COALESCE(EXCLUDED.sic_code, security_sector.sic_code),
       sic_description = COALESCE(EXCLUDED.sic_description, security_sector.sic_description),
       sector          = EXCLUDED.sector,
       source          = EXCLUDED.source,
       resolved        = EXCLUDED.resolved,
       category        = EXCLUDED.category,
       asset_class     = EXCLUDED.asset_class,
       instrument_kind = EXCLUDED.instrument_kind,
       attempts        = security_sector.attempts + 1,
       last_attempt_at = now(),
       updated_at      = now()`,
    [
      row.ticker,
      row.sourceSymbol,
      row.name,
      row.sicCode,
      row.sicDescription,
      row.sector,
      row.source,
      row.resolved,
      row.category ?? null,
      row.assetClass ?? null,
      row.instrumentKind ?? null,
    ],
  );
}

/**
 * Seed the cache with any currently-held tickers it doesn't yet have, as
 * unresolved rows, so holdings the cost-basis backfill never saw (e.g. mutual
 * funds) still become classification candidates. Idempotent: ON CONFLICT DO
 * NOTHING leaves existing (already-classified) rows untouched. Returns the count
 * of newly-seeded tickers.
 */
export async function seedMissingTickers(
  pool: Pool,
  rows: ReadonlyArray<{ ticker: string; sourceSymbol: string | null }>,
): Promise<number> {
  let seeded = 0;
  for (const r of rows) {
    const res = await pool.query(
      `INSERT INTO security_sector (ticker, source_symbol, source, resolved, attempts, updated_at)
       VALUES ($1, $2, 'seed', false, 0, now())
       ON CONFLICT (ticker) DO NOTHING`,
      [r.ticker, r.sourceSymbol],
    );
    seeded += res.rowCount ?? 0;
  }
  return seeded;
}

/**
 * Tickers the backfill should SKIP on resume: already resolved, or attempted
 * `maxAttempts` times without success (avoids re-hammering perma-misses).
 */
export async function getProcessedTickers(pool: Pool, maxAttempts = 3): Promise<Set<string>> {
  const { rows } = await pool.query<{ ticker: string }>(
    `SELECT ticker FROM security_sector WHERE resolved = true OR attempts >= $1`,
    [maxAttempts],
  );
  return new Set(rows.map((r) => r.ticker));
}

/**
 * Read the resolved ticker → sector map (for the drift enrichment to consume).
 * Optionally restrict to a set of tickers.
 */
export async function getSectorMap(pool: Pool, tickers?: readonly string[]): Promise<Map<string, Sector>> {
  const out = new Map<string, Sector>();
  const sql =
    tickers && tickers.length > 0
      ? `SELECT ticker, sector FROM security_sector WHERE resolved = true AND sector IS NOT NULL AND ticker = ANY($1)`
      : `SELECT ticker, sector FROM security_sector WHERE resolved = true AND sector IS NOT NULL`;
  const { rows } = await pool.query<{ ticker: string; sector: Sector }>(
    sql,
    tickers && tickers.length > 0 ? [tickers] : [],
  );
  for (const r of rows) out.set(r.ticker, r.sector);
  return out;
}

/**
 * Unified classification for the drift comparator. Each held ticker resolves to
 * EITHER a GICS `sector` (individual equities / ADRs) or an asset-class
 * `assetClass` (ETFs / mutual funds) — never both — plus the cash/fixed/equity
 * `bucket` it rolls into. Only returns tickers the cache can actually classify.
 */
export interface SecurityClassification {
  ticker: string;
  kind: 'equity' | 'fund';
  sector: Sector | null;
  assetClass: AssetClass | null;
  category: string | null;
  bucket: DriftBucket;
}

export async function getClassificationMap(
  pool: Pool,
  tickers?: readonly string[],
): Promise<Map<string, SecurityClassification>> {
  const out = new Map<string, SecurityClassification>();
  const where = `(sector IS NOT NULL AND sector <> 'Unclassified') OR asset_class IS NOT NULL`;
  const filtered = tickers && tickers.length > 0;
  const sql = `SELECT ticker, sector, asset_class, category FROM security_sector
               WHERE (${where})${filtered ? ' AND ticker = ANY($1)' : ''}`;
  const { rows } = await pool.query<{
    ticker: string;
    sector: Sector | null;
    asset_class: string | null;
    category: string | null;
  }>(sql, filtered ? [tickers] : []);

  for (const r of rows) {
    if (r.asset_class) {
      out.set(r.ticker, {
        ticker: r.ticker,
        kind: 'fund',
        sector: null,
        assetClass: r.asset_class as AssetClass,
        category: r.category,
        bucket: bucketForAssetClass(r.asset_class),
      });
    } else if (r.sector) {
      out.set(r.ticker, {
        ticker: r.ticker,
        kind: 'equity',
        sector: r.sector,
        assetClass: null,
        category: null,
        bucket: 'equity',
      });
    }
  }
  return out;
}

export interface BackfillStats {
  total: number;
  resolved: number;
  unresolved: number;
  bySector: Record<string, number>;
}

/** Summary of the cache state — for the backfill's end-of-run report. */
export async function getBackfillStats(pool: Pool): Promise<BackfillStats> {
  const { rows } = await pool.query<{ resolved: boolean; sector: string | null; n: string }>(
    `SELECT resolved, sector, COUNT(*)::text AS n FROM security_sector GROUP BY resolved, sector`,
  );
  const stats: BackfillStats = { total: 0, resolved: 0, unresolved: 0, bySector: {} };
  for (const r of rows) {
    const n = parseInt(r.n, 10);
    stats.total += n;
    if (r.resolved) {
      stats.resolved += n;
      const key = r.sector ?? 'Unclassified';
      stats.bySector[key] = (stats.bySector[key] ?? 0) + n;
    } else {
      stats.unresolved += n;
    }
  }
  return stats;
}
