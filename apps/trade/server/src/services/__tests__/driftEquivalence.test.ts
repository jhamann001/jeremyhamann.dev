import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import type { AccountPositions } from '../warehouse.js';
import type { MeridianSnapshot } from '../meridianSnapshot.js';
import type { HouseholdConfig } from '../householdConfig.js';

// I/O is mocked; the comparators (positionDrift, positionDriftAccounts) and the runner are real.
const io = vi.hoisted(() => ({
  positions: new Map<string, unknown>(),
  snapshot: { generatedAt: '2026-05-13T00:00:00.000Z', entries: [] as unknown[] },
  householdConfig: null as unknown,
  persistArgs: [] as unknown[],
  alertArgs: [] as unknown[],
}));

vi.mock('../warehouse.js', () => ({
  fetchAccountPositions: vi.fn(async () => io.positions),
  fetchAccountTitles: vi.fn(async () => new Map()),
  isWarehouseQueryConfigured: () => false,
  fetchCostBasisData: vi.fn(),
  fetchRealizedGainsYtd: vi.fn(),
  fetchOwnershipTypes: vi.fn(),
}));
vi.mock('../meridianTemplates.js', () => ({ loadMeridianTemplates: vi.fn(async () => io.snapshot) }));
vi.mock('../meridianActiveAccounts.js', async (orig) => ({
  ...(await orig<typeof import('../meridianActiveAccounts.js')>()),
  loadMeridianActiveAccounts: vi.fn(async () => ({
    generatedAt: '2026-05-13T00:00:00.000Z',
    firmId: 't',
    accountCount: 0,
    rawRowCount: 0,
    accounts: [],
  })),
  toHouseholdConfig: vi.fn(() => io.householdConfig),
}));
vi.mock('../meridianTransitions.js', () => ({
  loadMeridianTransitions: vi.fn(async () => {
    throw new Error('transitions not configured in test');
  }),
}));
vi.mock('../securitySector.js', () => ({ getClassificationMap: vi.fn(async () => new Map()) }));
vi.mock('../positionDriftAccountsPersistence.js', () => ({
  ACCOUNT_DRIFT_SCHEMA_VERSION: 1,
  persistAccountDriftRows: vi.fn(async (args: unknown) => {
    io.persistArgs.push(args);
    return new Set<string>();
  }),
}));
vi.mock('../positionDriftAccountsAlert.js', () => ({
  postAccountDriftAlert: vi.fn(async (args: { accounts: unknown }) => {
    io.alertArgs.push(args.accounts);
    return { sent: false, alertingAccountIds: [], suppressedAllowListed: [] };
  }),
}));
vi.mock('../driftStatusOverrides.js', () => ({ sweepOverrideRechecks: vi.fn(async () => 0) }));
vi.mock('../../lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { runDriftCheck } from '../registryDriftRunner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, 'fixtures', 'drift-equivalence-baseline.json');
const NOW = new Date('2026-05-13T13:15:00.000Z');

function hh(entries: Array<[string, string]>): HouseholdConfig {
  return {
    byAccountNumber: new Map(
      entries.map(([accountNumber, householdName]) => [accountNumber, { accountNumber, householdName }]),
    ),
    householdNames: new Set(entries.map(([, h]) => h)),
    entries: entries.map(([accountNumber, householdName]) => ({ accountNumber, householdName })),
  };
}
function pos(
  accountId: string,
  totalEquity: number,
  cashEquity: number,
  positionsBySymbol: Record<string, number>,
): AccountPositions {
  const positionsTotal = Object.values(positionsBySymbol).reduce((s, v) => s + v, 0);
  return { accountId, positionsTotal, totalEquity, cashEquity, positionsBySymbol, businessDate: '2026-05-13' };
}
const snap = (entries: MeridianSnapshot['entries']): MeridianSnapshot => ({
  generatedAt: '2026-05-13T00:00:00.000Z',
  entries,
});

// Synthetic only. "justOver" sits 5.5 points off target so a changed tolerance constant changes the result.
const SETS: Record<
  string,
  { positions: Map<string, AccountPositions>; snapshot: MeridianSnapshot; householdConfig: HouseholdConfig }
> = {
  inTolerance: {
    positions: new Map([['A1', pos('A1', 100_000, 1_000, { VOO: 59_000, BND: 40_000 })]]),
    snapshot: snap([{ account: 'A1', weights: { VOO: 60, BND: 40 } }]),
    householdConfig: hh([['A1', 'Household One']]),
  },
  justOver: {
    positions: new Map([['B1', pos('B1', 100_000, 500, { VOO: 65_000, BND: 34_500 })]]),
    snapshot: snap([{ account: 'B1', weights: { VOO: 59.5, BND: 40 } }]),
    householdConfig: hh([['B1', 'Household Two']]),
  },
  uninvestedAndUnmapped: {
    positions: new Map([
      ['C1', pos('C1', 80_000, 79_500, { VOO: 500 })],
      ['C9', pos('C9', 10_000, 0, { VOO: 10_000 })],
    ]),
    snapshot: snap([{ account: 'C1', weights: { VOO: 95, BND: 5 } }]),
    householdConfig: hh([['C1', 'Household Three']]),
  },
};

function fakePool(): { pool: Pool; inserts: unknown[] } {
  const inserts: unknown[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO registry_drift_runs/.test(sql)) inserts.push(params);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return {
    pool: {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
      end: vi.fn(),
    } as unknown as Pool,
    inserts,
  };
}

async function runSet(name: string) {
  const set = SETS[name];
  io.positions = set.positions;
  io.snapshot = set.snapshot as typeof io.snapshot;
  io.householdConfig = set.householdConfig;
  io.persistArgs = [];
  io.alertArgs = [];
  const { pool, inserts } = fakePool();
  const summary = await runDriftCheck({ pool, now: NOW });
  return JSON.parse(
    JSON.stringify({ summary, householdInserts: inserts, accountPersist: io.persistArgs, alertAccounts: io.alertArgs }),
  );
}

const current: Record<string, unknown> = {};
beforeAll(async () => {
  for (const name of Object.keys(SETS)) current[name] = await runSet(name);
  if (process.env.RECORD_DRIFT_BASELINE === '1') {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  }
});

describe('drift runner equivalence against the d41b6c9 baseline', () => {
  const baseline = () => JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

  it('persists the same household rows for every recorded input set', () => {
    for (const name of Object.keys(SETS))
      expect((current[name] as any).householdInserts).toEqual(baseline()[name].householdInserts);
  });
  it('persists the same account rows, tolerance and schema version for every recorded input set', () => {
    for (const name of Object.keys(SETS)) {
      expect((current[name] as any).accountPersist).toEqual(baseline()[name].accountPersist);
      expect((current[name] as any).summary).toEqual(baseline()[name].summary);
    }
  });
  it('passes the same accounts to the alert decision for every recorded input set', () => {
    for (const name of Object.keys(SETS))
      expect((current[name] as any).alertAccounts).toEqual(baseline()[name].alertAccounts);
  });
});
