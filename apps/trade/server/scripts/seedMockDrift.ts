/**
 * DEV-ONLY: seed `position_drift_accounts` with a handful of illustrative mock
 * accounts so the DriftTabV2 UI (incl. the new sector / asset-class panel) can
 * be reviewed without the full nightly pipeline (which needs the GCS snapshot).
 *
 * Uses the REAL classification cache (so sector/asset-class labels are authentic)
 * and the REAL persistence path (so the row shape is exact). Mock rows are tagged
 * household "ZZ — Mock Review" and account ids prefixed "MOCK" for easy cleanup.
 *
 *   npx tsx scripts/seedMockDrift.ts          # insert/refresh mock rows
 *   npx tsx scripts/seedMockDrift.ts --clear  # remove mock rows only
 */
import 'dotenv/config';
import pool from '../src/db/pool.js';
import { normalizeTicker } from '../src/data/sicToSector.js';
import { getClassificationMap } from '../src/services/securitySector.js';
import { computeSectorAllocation } from '../src/services/sectorAllocation.js';
import {
  persistAccountDriftRows,
  ACCOUNT_DRIFT_SCHEMA_VERSION,
} from '../src/services/positionDriftAccountsPersistence.js';
import type { AccountDriftResult, AccountDriftDetails } from '../src/services/positionDriftAccounts.js';
import type { AssetCategory } from '../src/data/instruments.js';
import type { AccountTaxSummary, CostBasisFreshnessSummary } from '@trade-request/shared';

const MOCK_HOUSEHOLD = 'ZZ — Mock Review';

const FRESHNESS: CostBasisFreshnessSummary = {
  level: 'ok',
  fullProcessDate: '2026-06-01',
  fullAgeDays: 4,
  dailyProcessDate: '2026-06-04',
  dailyAgeDays: 1,
  pipelineLatest: '2026-06-05',
  pipelineAgeDays: 0,
  message: 'Cost-basis data is current (full 4d, daily 1d).',
};

interface MockSpec {
  id: string;
  title: string;
  status: AccountDriftResult['status'];
  totalValue: number;
  buckets: { cash: [number, number]; fixed: [number, number]; equity: [number, number] }; // [positionPct, templatePct]
  /** equity-sleeve holdings: ticker -> % of total account */
  equity: Record<string, number>;
  tax?: Partial<AccountTaxSummary> & { transitionCandidate?: boolean };
}

const SPECS: MockSpec[] = [
  {
    id: 'MOCK_STOCKS_DIVERSE',
    title: 'Mock — Diversified individual stocks',
    status: 'in',
    totalValue: 1_250_000,
    buckets: { cash: [2, 2], fixed: [8, 10], equity: [90, 88] },
    equity: { AAPL: 14, MSFT: 11, NVDA: 9, JPM: 8, JNJ: 7, XOM: 6, PG: 6, HD: 6, GOOGL: 7, V: 6, UNH: 5, CAT: 5 },
    tax: {
      unrealizedGainUsd: 184_500,
      unrealizedShortTermGainUsd: 22_000,
      unrealizedLongTermGainUsd: 162_500,
      realizedGainYtdUsd: 41_300,
      realizedShortTermYtdUsd: 6_300,
      realizedLongTermYtdUsd: 35_000,
      basisCoveragePct: 98,
      transferInValueUsd: 0,
      transferInPct: 0,
    },
  },
  {
    id: 'MOCK_FUND_HEAVY',
    title: 'Mock — Fund-heavy (asset classes)',
    status: 'out',
    totalValue: 680_000,
    buckets: { cash: [3, 2], fixed: [22, 30], equity: [75, 68] },
    equity: { VTI: 28, VXUS: 16, VWO: 8, SPY: 12, VEU: 6, VNQ: 5 },
  },
  {
    id: 'MOCK_MIXED',
    title: 'Mock — Mixed stocks + funds + ADRs',
    status: 'in',
    totalValue: 940_000,
    buckets: { cash: [4, 5], fixed: [11, 10], equity: [85, 85] },
    equity: { AAPL: 12, GOOGL: 9, SPY: 15, VEU: 8, ASML: 6, NSRGY: 5, HSBC: 5, BHP: 4, SHEL: 4, VTI: 17 },
    tax: {
      unrealizedGainUsd: 96_200,
      unrealizedShortTermGainUsd: 12_000,
      unrealizedLongTermGainUsd: 84_200,
      realizedGainYtdUsd: -8_400,
      realizedShortTermYtdUsd: -8_400,
      realizedLongTermYtdUsd: 0,
      basisCoveragePct: 91,
      transferInValueUsd: 120_000,
      transferInPct: 13,
    },
  },
  {
    id: 'MOCK_BOND_ETF_LEAK',
    title: 'Mock — Bond ETFs leaked into equity (audit demo)',
    status: 'out',
    totalValue: 510_000,
    buckets: { cash: [5, 5], fixed: [10, 40], equity: [85, 55] },
    equity: { LQD: 22, JNK: 14, VCIT: 14, VCLT: 10, SPY: 25 },
  },
  {
    id: 'MOCK_TRANSITION',
    title: 'Mock — Transferred-in, no template (transition candidate)',
    status: 'no_template',
    totalValue: 2_100_000,
    buckets: { cash: [6, 0], fixed: [4, 0], equity: [90, 0] },
    equity: { AAPL: 18, MSFT: 14, AMZN: 10, BRKB: 9, JPM: 8, XOM: 7, KO: 6, ABBV: 6, CVX: 6, WMT: 6 },
    tax: {
      unrealizedGainUsd: 612_000,
      unrealizedShortTermGainUsd: 40_000,
      unrealizedLongTermGainUsd: 572_000,
      basisCoveragePct: 88,
      transferInValueUsd: 1_932_000,
      transferInPct: 92,
      transitionCandidate: true,
    },
  },
  {
    id: 'MOCK_UNINVESTED',
    title: 'Mock — Mostly uninvested cash',
    status: 'uninvested',
    totalValue: 300_000,
    buckets: { cash: [96, 2], fixed: [0, 18], equity: [4, 80] },
    equity: { VOO: 4 },
  },
];

const cmp = (positionPct: number, templatePct: number) => ({
  positionPct,
  templatePct,
  deltaPct: Math.round(Math.abs(positionPct - templatePct) * 100) / 100,
});

async function clearMock(): Promise<void> {
  const res = await pool.query(`DELETE FROM position_drift_accounts WHERE household_name = $1`, [MOCK_HOUSEHOLD]);
  console.log(`cleared ${res.rowCount ?? 0} mock rows`);
}

function buildTax(spec: MockSpec): AccountTaxSummary | undefined {
  if (!spec.tax) return undefined;
  const t = spec.tax;
  return {
    investableValueUsd: spec.totalValue * (spec.buckets.equity[0] + spec.buckets.fixed[0]) * 0.01,
    basisCoveragePct: t.basisCoveragePct ?? 95,
    unrealizedGainUsd: t.unrealizedGainUsd ?? 0,
    unrealizedShortTermGainUsd: t.unrealizedShortTermGainUsd ?? 0,
    unrealizedLongTermGainUsd: t.unrealizedLongTermGainUsd ?? 0,
    transferInValueUsd: t.transferInValueUsd ?? 0,
    transferInPct: t.transferInPct ?? 0,
    hasMissingBasis: (t.basisCoveragePct ?? 100) < 100,
    transitionCandidate: t.transitionCandidate ?? false,
    realizedGainYtdUsd: t.realizedGainYtdUsd,
    realizedShortTermYtdUsd: t.realizedShortTermYtdUsd,
    realizedLongTermYtdUsd: t.realizedLongTermYtdUsd,
    symbols: [],
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--clear')) {
    await clearMock();
    await pool.end();
    process.exit(0);
  }

  // Real classification for the tickers we reference.
  const allTickers = new Set<string>();
  for (const s of SPECS)
    for (const sym of Object.keys(s.equity)) {
      const n = normalizeTicker(sym);
      if (n) allTickers.add(n);
    }
  const classification = await getClassificationMap(pool, [...allTickers]);
  console.log(`classification hits: ${classification.size} / ${allTickers.size}`);

  const accounts: AccountDriftResult[] = SPECS.map((spec) => {
    const equityHoldings = Object.entries(spec.equity).map(([symbol, positionPct]) => ({ symbol, positionPct }));
    const sectorAllocation = computeSectorAllocation(equityHoldings, classification, normalizeTicker);
    const buckets = {
      cash: cmp(spec.buckets.cash[0], spec.buckets.cash[1]),
      fixed: cmp(spec.buckets.fixed[0], spec.buckets.fixed[1]),
      equity: cmp(spec.buckets.equity[0], spec.buckets.equity[1]),
    };
    const deltas: Array<[AssetCategory, number]> = [
      ['cash', buckets.cash.deltaPct],
      ['fixed', buckets.fixed.deltaPct],
      ['equity', buckets.equity.deltaPct],
    ];
    deltas.sort((a, b) => b[1] - a[1]);
    const noTemplate = spec.status === 'no_template';

    const details: AccountDriftDetails = {
      buckets,
      symbolsWithTargets: [],
      equityHoldings,
      positionOnlySymbols: [],
      suspectedCashEquivMisclassified: [],
      tax: buildTax(spec),
      costBasisFreshness: FRESHNESS,
      sectorAllocation,
    };

    return {
      accountId: spec.id,
      accountTitle: spec.title,
      household: MOCK_HOUSEHOLD,
      unmapped: false,
      templateMissing: noTemplate,
      totalValue: spec.totalValue,
      maxBucketDeltaPct: noTemplate ? null : deltas[0][1],
      worstBucket: noTemplate ? null : deltas[0][0],
      symbolBreachCount: 0,
      status: spec.status,
      details,
    };
  });

  await clearMock();
  await persistAccountDriftRows({
    pool,
    runDateLocal: new Date().toISOString().slice(0, 10),
    runStartedAt: new Date(),
    snapshotSource: 'mock',
    snapshotAsOf: new Date().toISOString(),
    tolerancePct: 5,
    uninvestedCashThresholdPct: 99,
    schemaVersion: ACCOUNT_DRIFT_SCHEMA_VERSION,
    accounts,
  });

  console.log(`\nseeded ${accounts.length} mock accounts under household "${MOCK_HOUSEHOLD}"`);
  for (const a of accounts) {
    const top = a.details.sectorAllocation?.slices
      .slice(0, 4)
      .map((s) => `${s.label} ${s.pct.toFixed(0)}%`)
      .join(', ');
    console.log(`  ${a.status.padEnd(11)} ${a.accountTitle}`);
    console.log(`      ${top}`);
  }
  console.log('\nReview in the dev UI (Drift tab). Clean up later with: npx tsx scripts/seedMockDrift.ts --clear');

  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error('seedMockDrift failed:', err);
  process.exit(1);
});
