/**
 * One-time (resumable) backfill of the `security_sector` cache: classify every
 * held equity ticker into a sector via Massive's SIC, throttled to respect the
 * API rate limit. The nightly drift run only READS the cache; this script is the
 * only thing that calls Massive.
 *
 * Run from server/:
 *   npx tsx scripts/backfillSecuritySectors.ts --dry-run   # preview count + ETA, no writes/calls
 *   npx tsx scripts/backfillSecuritySectors.ts             # do the backfill
 *
 * Env required: MASSIVE_API_KEY, WAREHOUSE_URL + WAREHOUSE_API_KEY (to list held
 * symbols), and DB_* (to write the cache). Tunables: MASSIVE_RATE_PER_MIN
 * (default 5 — the free-tier limit; raise on a paid tier for a faster run),
 * MASSIVE_MAX_ATTEMPTS (default 3).
 *
 * Resumable: re-running skips tickers already resolved or attempted MAX_ATTEMPTS
 * times, so a 429 wall or a dropped session just means "run it again to finish."
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pool from '../src/db/pool.js';
import logger from '../src/lib/logger.js';
import { fetchCostBasisData } from '../src/services/warehouse.js';
import { classifySymbol } from '../src/data/instruments.js';
import { normalizeTicker, classifySector } from '../src/data/sicToSector.js';
import { fetchTickerReference, MassiveRateLimitError, isMassiveConfigured } from '../src/services/massiveClient.js';
import { upsertSecuritySector, getProcessedTickers, getBackfillStats } from '../src/services/securitySector.js';

const RATE_PER_MIN = Math.max(1, Number(process.env.MASSIVE_RATE_PER_MIN ?? '5'));
const SLEEP_MS = Math.ceil(60_000 / RATE_PER_MIN);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.MASSIVE_MAX_ATTEMPTS ?? '3'));
const DRY_RUN = process.argv.includes('--dry-run');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch with 429 back-off: on rate limit, wait 60s and retry up to `retries`. */
async function fetchWithBackoff(ticker: string, retries = 3): ReturnType<typeof fetchTickerReference> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchTickerReference(ticker);
    } catch (err) {
      if (err instanceof MassiveRateLimitError && attempt < retries) {
        logger.warn({ ticker, attempt }, 'rate limited — backing off 60s');
        await sleep(60_000);
        continue;
      }
      throw err;
    }
  }
}

async function main(): Promise<void> {
  if (!isMassiveConfigured()) {
    logger.error('MASSIVE_API_KEY is not set — cannot run the sector backfill.');
    process.exit(1);
  }

  logger.info(
    { ratePerMin: RATE_PER_MIN, sleepMs: SLEEP_MS, maxAttempts: MAX_ATTEMPTS, dryRun: DRY_RUN },
    '[sector-backfill] start',
  );

  // 1. Source symbols. A newline-delimited file (SECTOR_BACKFILL_SYMBOLS_FILE)
  //    if set — handy when Warehouse isn't reachable from this env — else the
  //    held open lots via Warehouse. Either way: equity-only, normalized, deduped.
  const symbolsFile = process.env.SECTOR_BACKFILL_SYMBOLS_FILE;
  let rawSymbols: string[];
  if (symbolsFile) {
    const text = await readFile(symbolsFile, 'utf-8');
    rawSymbols = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    logger.info({ symbolsFile, count: rawSymbols.length }, '[sector-backfill] sourcing symbols from file');
  } else {
    const { lots } = await fetchCostBasisData();
    rawSymbols = lots.map((l) => l.symbol);
  }

  const targets = new Map<string, string>(); // normalizedTicker -> first source symbol
  for (const sym of rawSymbols) {
    if (classifySymbol(sym) !== 'equity') continue;
    const norm = normalizeTicker(sym);
    if (!norm) continue;
    if (!targets.has(norm)) targets.set(norm, sym);
  }

  // 2. Skip already-processed (resolved or hit the attempt cap).
  const processed = await getProcessedTickers(pool, MAX_ATTEMPTS);
  const todo = [...targets.entries()].filter(([ticker]) => !processed.has(ticker));

  const etaMin = Math.ceil((todo.length * SLEEP_MS) / 60_000);
  logger.info(
    { equityTickers: targets.size, alreadyProcessed: processed.size, remaining: todo.length, etaMinutes: etaMin },
    `[sector-backfill] ${todo.length} tickers to fetch (~${etaMin} min at ${RATE_PER_MIN}/min)`,
  );

  if (DRY_RUN) {
    logger.info(
      { sample: todo.slice(0, 20).map(([t]) => t) },
      '[sector-backfill] DRY RUN — no writes, no API calls. Sample of remaining:',
    );
    const stats = await getBackfillStats(pool);
    logger.info(stats, '[sector-backfill] current cache stats');
    await pool.end();
    process.exit(0);
  }

  // 3. Throttled, resumable fetch loop.
  let ok = 0;
  let unclassified = 0;
  let notFound = 0;
  let errors = 0;
  let i = 0;

  for (const [ticker, sourceSymbol] of todo) {
    i += 1;
    try {
      const ref = await fetchWithBackoff(ticker);
      if (ref === null) {
        notFound += 1;
        await upsertSecuritySector(pool, {
          ticker,
          sourceSymbol,
          name: null,
          sicCode: null,
          sicDescription: null,
          sector: null,
          source: 'massive',
          resolved: false,
        });
      } else {
        const sector = classifySector(ticker, ref.sicCode);
        if (sector === 'Unclassified') unclassified += 1;
        else ok += 1;
        // 'Unclassified' is still resolved=true (Massive has no better answer; a
        // future crosswalk improvement can recompute from stored sic_code without
        // re-hitting the API).
        await upsertSecuritySector(pool, {
          ticker,
          sourceSymbol,
          name: ref.name,
          sicCode: ref.sicCode,
          sicDescription: ref.sicDescription,
          sector,
          source: 'massive',
          resolved: true,
        });
      }
    } catch (err) {
      if (err instanceof MassiveRateLimitError) {
        logger.error(
          { ticker, done: i - 1, remaining: todo.length - (i - 1) },
          '[sector-backfill] still rate-limited after retries — stopping; re-run to resume',
        );
        break;
      }
      errors += 1;
      logger.warn(
        { ticker, message: err instanceof Error ? err.message : String(err) },
        '[sector-backfill] fetch error (recorded as unresolved)',
      );
      await upsertSecuritySector(pool, {
        ticker,
        sourceSymbol,
        name: null,
        sicCode: null,
        sicDescription: null,
        sector: null,
        source: 'massive',
        resolved: false,
      });
    }

    if (i % 25 === 0) {
      logger.info({ i, total: todo.length, ok, unclassified, notFound, errors }, '[sector-backfill] progress');
    }
    await sleep(SLEEP_MS);
  }

  const stats = await getBackfillStats(pool);
  logger.info({ processedThisRun: i, ok, unclassified, notFound, errors, cache: stats }, '[sector-backfill] done');
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, '[sector-backfill] fatal');
  process.exit(1);
});
