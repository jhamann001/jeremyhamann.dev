/**
 * Yahoo enrichment pass. Classifies what Massive's SIC scheme can't, on two axes:
 *   - individual equities / ADRs  → a GICS `sector` (assetProfile);
 *   - ETFs / mutual funds         → an asset-class `category` (fundProfile),
 *     rolled up via classifyFundCategory. Funds get NO GICS sector — a basket
 *     isn't one company.
 * Throttled + resumable; writes the shared `security_sector` cache. The nightly
 * drift run only READS the cache.
 *
 * Run from server/:
 *   npx tsx scripts/backfillYahooSectors.ts --dry-run   # show candidates, no calls/writes
 *   npx tsx scripts/backfillYahooSectors.ts             # run it
 *   npx tsx scripts/backfillYahooSectors.ts --limit 5   # smoke-test N tickers
 *
 * Tunables: YAHOO_RATE_PER_MIN (default 20).
 *
 * Resumable: every processed ticker gets a terminal `source` (yahoo / yahoo:fund
 * / yahoo:notfound / yahoo:nosector / yahoo:fund-nocat), and the candidate query
 * excludes those, so a re-run only picks up tickers Yahoo never got to (e.g.
 * after a rate-limit wall).
 */
import 'dotenv/config';
import pool from '../src/db/pool.js';
import logger from '../src/lib/logger.js';
import { fetchYahooProfile, YahooRateLimitError } from '../src/services/yahooClient.js';
import { upsertSecuritySector, seedMissingTickers } from '../src/services/securitySector.js';
import { classifyFundCategory } from '../src/data/fundCategory.js';
import { fetchAccountPositions } from '../src/services/warehouse.js';
import { classifySymbol } from '../src/data/instruments.js';
import { normalizeTicker } from '../src/data/sicToSector.js';

const RATE_PER_MIN = Math.max(1, Number(process.env.YAHOO_RATE_PER_MIN ?? '20'));
const SLEEP_MS = Math.ceil(60_000 / RATE_PER_MIN);
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithBackoff(ticker: string, retries = 3): ReturnType<typeof fetchYahooProfile> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchYahooProfile(ticker);
    } catch (err) {
      if (err instanceof YahooRateLimitError && attempt < retries) {
        logger.warn({ ticker, attempt }, '[yahoo-backfill] rate limited — backing off 60s');
        await sleep(60_000);
        continue;
      }
      throw err;
    }
  }
}

const SEED = process.argv.includes('--seed');

async function main(): Promise<void> {
  logger.info(
    { ratePerMin: RATE_PER_MIN, sleepMs: SLEEP_MS, dryRun: DRY_RUN, limit: LIMIT, seed: SEED },
    '[yahoo-backfill] start',
  );

  // Optional: ensure every currently-held equity symbol is in the cache so
  // holdings the cost-basis backfill never saw (e.g. mutual funds) get a chance
  // to be classified. Reconciles the cache universe to live positions.
  if (SEED) {
    const positions = await fetchAccountPositions();
    const held = new Map<string, string>(); // normalized -> raw source symbol
    for (const acct of positions.values()) {
      for (const sym of Object.keys(acct.positionsBySymbol)) {
        if (classifySymbol(sym) !== 'equity') continue;
        const n = normalizeTicker(sym);
        if (n && !held.has(n)) held.set(n, sym);
      }
    }
    const seeded = await seedMissingTickers(
      pool,
      [...held].map(([ticker, sourceSymbol]) => ({ ticker, sourceSymbol })),
    );
    logger.info({ heldEquity: held.size, seeded }, '[yahoo-backfill] seeded missing held tickers');
  }

  // Candidates: cached tickers still lacking BOTH a sector and an asset class,
  // that a prior Yahoo pass hasn't already resolved or marked tried. This
  // re-includes funds an earlier pass merely parked (so they get a category now).
  const { rows: todoAll } = await pool.query<{ ticker: string; source_symbol: string | null; name: string | null }>(
    `SELECT ticker, source_symbol, name FROM security_sector
       WHERE asset_class IS NULL
         AND (sector IS NULL OR sector = 'Unclassified')
         AND COALESCE(source,'') NOT IN ('yahoo', 'yahoo:notfound', 'yahoo:nosector', 'yahoo:fund-nocat')
       ORDER BY ticker`,
  );
  const todo = todoAll.slice(0, LIMIT);
  const etaMin = Math.ceil((todo.length * SLEEP_MS) / 60_000);
  logger.info(
    { candidates: todoAll.length, toQuery: todo.length, etaMinutes: etaMin },
    `[yahoo-backfill] ${todo.length} tickers to query via Yahoo (~${etaMin} min at ${RATE_PER_MIN}/min)`,
  );

  if (DRY_RUN) {
    logger.info(
      { sampleQuery: todo.slice(0, 25).map((r) => r.ticker) },
      '[yahoo-backfill] DRY RUN — no calls, no writes',
    );
    await pool.end();
    process.exit(0);
  }

  let ok = 0; // equities sectored
  let funds = 0; // funds categorized
  let fundNoCat = 0; // funds with no category from Yahoo
  let noSector = 0; // equities with no mappable sector
  let notFound = 0;
  let errors = 0;
  let i = 0;

  for (const r of todo) {
    i += 1;
    try {
      const prof = await fetchWithBackoff(r.ticker);
      if (prof === null) {
        notFound += 1;
        await upsertSecuritySector(pool, {
          ticker: r.ticker,
          sourceSymbol: r.source_symbol,
          name: r.name,
          sicCode: null,
          sicDescription: null,
          sector: null,
          source: 'yahoo:notfound',
          resolved: false,
        });
      } else if (prof.quoteType === 'ETF' || prof.quoteType === 'MUTUALFUND') {
        // Fund → classify on the asset-class axis (not GICS).
        const assetClass = classifyFundCategory(prof.category);
        if (prof.category) {
          funds += 1;
          await upsertSecuritySector(pool, {
            ticker: r.ticker,
            sourceSymbol: r.source_symbol,
            name: prof.name ?? r.name,
            sicCode: null,
            sicDescription: null,
            sector: null,
            source: 'yahoo:fund',
            resolved: true,
            category: prof.category,
            assetClass,
            instrumentKind: prof.quoteType.toLowerCase(),
          });
        } else {
          // Fund but Yahoo gave no category — mark tried so we don't re-query.
          fundNoCat += 1;
          await upsertSecuritySector(pool, {
            ticker: r.ticker,
            sourceSymbol: r.source_symbol,
            name: prof.name ?? r.name,
            sicCode: null,
            sicDescription: null,
            sector: null,
            source: 'yahoo:fund-nocat',
            resolved: false,
            instrumentKind: prof.quoteType.toLowerCase(),
          });
        }
      } else if (prof.sector) {
        ok += 1;
        await upsertSecuritySector(pool, {
          ticker: r.ticker,
          sourceSymbol: r.source_symbol,
          name: prof.name ?? r.name,
          sicCode: null,
          sicDescription: null,
          sector: prof.sector,
          source: 'yahoo',
          resolved: true,
          instrumentKind: 'equity',
        });
      } else {
        // Equity but Yahoo had no (mappable) sector — record the attempt so we
        // don't re-query, but leave it unresolved/Unclassified.
        noSector += 1;
        await upsertSecuritySector(pool, {
          ticker: r.ticker,
          sourceSymbol: r.source_symbol,
          name: prof.name ?? r.name,
          sicCode: null,
          sicDescription: null,
          sector: null,
          source: 'yahoo:nosector',
          resolved: false,
          instrumentKind: 'equity',
        });
      }
    } catch (err) {
      if (err instanceof YahooRateLimitError) {
        logger.error(
          { ticker: r.ticker, done: i - 1, remaining: todo.length - (i - 1) },
          '[yahoo-backfill] still rate-limited after retries — stopping; re-run to resume',
        );
        break;
      }
      errors += 1;
      logger.warn(
        { ticker: r.ticker, message: err instanceof Error ? err.message : String(err) },
        '[yahoo-backfill] query error (left for a later re-run)',
      );
    }

    if (i % 25 === 0) {
      logger.info(
        { i, total: todo.length, ok, funds, fundNoCat, noSector, notFound, errors },
        '[yahoo-backfill] progress',
      );
    }
    await sleep(SLEEP_MS);
  }

  logger.info({ processedThisRun: i, ok, funds, fundNoCat, noSector, notFound, errors }, '[yahoo-backfill] done');
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, '[yahoo-backfill] fatal');
  process.exit(1);
});
