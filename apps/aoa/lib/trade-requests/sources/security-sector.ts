import type { Pool } from '@/lib/trade-requests/pg-compat';
import type { Sector } from '@/lib/trade-requests/sources/data/sic-to-sector';
import { bucketForAssetClass, type AssetClass, type DriftBucket } from '@/lib/trade-requests/sources/data/fund-category';

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
  const sql = `SELECT ticker, sector, asset_class, category FROM trade_request.security_sector
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

