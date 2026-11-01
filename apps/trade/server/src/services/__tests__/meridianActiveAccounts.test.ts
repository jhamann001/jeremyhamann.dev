import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn(),
}));

import {
  ActiveAccountsLoadError,
  loadMeridianActiveAccounts,
  loadMeridianActiveAccountsFromFile,
  toHouseholdConfig,
  _setStorageFactoryForTests,
} from '../meridianActiveAccounts.js';
import logger from '../../lib/logger.js';
import { HouseholdConfigError } from '../householdConfig.js';
import { STALE_SNAPSHOT_THRESHOLD_DAYS } from '../meridianSnapshot.js';

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(FIXTURE_DIR, 'fixtures', 'meridian-active-accounts-sample.json');

interface FakeFile {
  name: string;
  download: () => Promise<[Buffer]>;
  getMetadata?: () => Promise<[{ updated?: string }]>;
}

function fakeFile(name: string, payload: unknown, metadata?: { updated?: string }): FakeFile {
  const file: FakeFile = {
    name,
    download: vi.fn().mockResolvedValue([Buffer.from(JSON.stringify(payload), 'utf-8')]),
  };
  if (metadata !== undefined) {
    file.getMetadata = vi.fn().mockResolvedValue([metadata]);
  }
  return file;
}

function fakeStorageFactory(files: FakeFile[]) {
  return () => ({
    bucket: (_name: string) => ({
      getFiles: vi.fn().mockResolvedValue([files]),
    }),
  });
}

const minimalPayload = (overrides: Record<string, unknown> = {}) => ({
  generated_at: '2026-05-15T01:00:00.000Z',
  firm_id: 'test',
  account_count: 1,
  raw_row_count: 1,
  accounts: [
    {
      account_id: 1,
      trading_account_no: '01SYNTHJ7G094TRY2A6R126CB3',
      account_title: 'Elliot Marsh - Brokerage',
      account_type: 'NA',
      cash: 0.29,
      equity: 0,
      total: 0.29,
      household_id: 3027,
      household_name: 'Marsh + Navarro Family',
      sleeves: [],
      associations: [],
      ...overrides,
    },
  ],
});

beforeEach(() => {
  process.env.MERIDIAN_SNAPSHOT_SOURCE = 'gcs';
  process.env.MERIDIAN_SNAPSHOT_BUCKET = 'test-bucket';
  vi.clearAllMocks();
});

afterEach(() => {
  _setStorageFactoryForTests(null);
  delete process.env.MERIDIAN_SNAPSHOT_SOURCE;
  delete process.env.MERIDIAN_SNAPSHOT_BUCKET;
  delete process.env.MERIDIAN_SNAPSHOT_FILE;
});

// ─── loadMeridianActiveAccounts (GCS happy path) ───────────────────────────

describe('loadMeridianActiveAccounts — happy path (GCS)', () => {
  it('returns the newest active_accounts file when multiple are present', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const newer = fakeFile('meridian/active_accounts/2026-05-15.json', minimalPayload());
    const older = fakeFile(
      'meridian/active_accounts/2026-05-14.json',
      minimalPayload({ trading_account_no: '01SYNTHJ7G094TRY2A6R126CB3', household_name: 'OldName' }),
    );
    _setStorageFactoryForTests(fakeStorageFactory([older, newer]));

    const result = await loadMeridianActiveAccounts(now);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].householdName).toBe('Marsh + Navarro Family');
    expect(result.generatedAt).toBe('2026-05-15T00:00:00.000Z');
    expect(older.download).not.toHaveBeenCalled();
  });

  it('derives as_of from a YYYY-MM-DD filename without consulting GCS metadata', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const f = fakeFile('meridian/active_accounts/2026-05-10.json', minimalPayload());
    _setStorageFactoryForTests(fakeStorageFactory([f]));
    const result = await loadMeridianActiveAccounts(now);
    expect(result.generatedAt).toBe('2026-05-10T00:00:00.000Z');
  });

  it('falls back to GCS object metadata.updated when filename has no parseable date', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const f = fakeFile('meridian/active_accounts/active_latest.json', minimalPayload(), {
      updated: '2026-05-14T20:30:00.000Z',
    });
    _setStorageFactoryForTests(fakeStorageFactory([f]));
    const result = await loadMeridianActiveAccounts(now);
    expect(result.generatedAt).toBe('2026-05-14T20:30:00.000Z');
    expect(f.getMetadata).toHaveBeenCalledTimes(1);
  });
});

// ─── unlinked-household tolerance (new accounts not yet householded) ─────────

describe('loadMeridianActiveAccounts — unlinked households', () => {
  const SECOND_ULID = '01SYNTHYAXYA93AFMY5Q7D9SFF';

  it('drops accounts with null household and keeps the linked ones', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const payload = {
      ...minimalPayload(),
      account_count: 2,
      raw_row_count: 2,
      accounts: [
        ...minimalPayload().accounts,
        {
          ...minimalPayload().accounts[0],
          trading_account_no: SECOND_ULID,
          account_title: 'Lena Hartley - Apex C/F Roth IRA',
          account_type: 'NA non-taxable',
          total: 0,
          household_id: null,
          household_name: null,
        },
      ],
    };
    const f = fakeFile('meridian/active_accounts/2026-05-15.json', payload);
    _setStorageFactoryForTests(fakeStorageFactory([f]));

    const result = await loadMeridianActiveAccounts(now);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].tradingAccountNo).toBe('01SYNTHJ7G094TRY2A6R126CB3');
    expect(result.accounts.some((a) => a.tradingAccountNo === SECOND_ULID)).toBe(false);
  });

  it('logs a structured warning naming the skipped accounts', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const payload = {
      ...minimalPayload(),
      account_count: 2,
      raw_row_count: 2,
      accounts: [
        ...minimalPayload().accounts,
        {
          ...minimalPayload().accounts[0],
          trading_account_no: SECOND_ULID,
          account_title: 'Lena Hartley - Apex C/F Roth IRA',
          household_id: null,
          household_name: null,
        },
      ],
    };
    const f = fakeFile('meridian/active_accounts/2026-05-15.json', payload);
    _setStorageFactoryForTests(fakeStorageFactory([f]));

    await loadMeridianActiveAccounts(now);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'active_accounts_unlinked_household',
        count: 1,
        accounts: [{ tradingAccountNo: SECOND_ULID, accountTitle: 'Lena Hartley - Apex C/F Roth IRA' }],
      }),
      expect.stringContaining('no household assigned'),
    );
  });

  it('still rejects a blank (non-null) household_name', async () => {
    const malformed = fakeFile('meridian/active_accounts/2026-05-15.json', minimalPayload({ household_name: '   ' }));
    _setStorageFactoryForTests(fakeStorageFactory([malformed]));
    await expect(loadMeridianActiveAccounts(new Date('2026-05-15T03:00:00.000Z'))).rejects.toThrow(
      /schema validation/,
    );
  });
});

// ─── loadMeridianActiveAccounts (failure cases) ────────────────────────────

describe('loadMeridianActiveAccounts — failure cases', () => {
  it('throws ActiveAccountsLoadError when bucket env var is missing', async () => {
    delete process.env.MERIDIAN_SNAPSHOT_BUCKET;
    await expect(loadMeridianActiveAccounts(new Date())).rejects.toBeInstanceOf(ActiveAccountsLoadError);
  });

  it('throws when no active_accounts files exist', async () => {
    _setStorageFactoryForTests(fakeStorageFactory([]));
    await expect(loadMeridianActiveAccounts(new Date())).rejects.toThrow(/No active_accounts files/);
  });

  it('throws when the file is invalid JSON', async () => {
    const broken: FakeFile = {
      name: 'meridian/active_accounts/2026-05-15.json',
      download: vi.fn().mockResolvedValue([Buffer.from('{ this is not json', 'utf-8')]),
    };
    _setStorageFactoryForTests(fakeStorageFactory([broken]));
    await expect(loadMeridianActiveAccounts(new Date())).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a payload missing the top-level accounts array', async () => {
    const malformed = fakeFile('meridian/active_accounts/2026-05-15.json', { firm_id: 'test' });
    _setStorageFactoryForTests(fakeStorageFactory([malformed]));
    await expect(loadMeridianActiveAccounts(new Date())).rejects.toThrow(/schema validation/);
  });

  it('rejects rows missing required fields (no trading_account_no)', async () => {
    const malformed = fakeFile('meridian/active_accounts/2026-05-15.json', {
      ...minimalPayload(),
      accounts: [
        {
          account_title: 'X',
          household_id: 1,
          household_name: 'X',
        },
      ],
    });
    _setStorageFactoryForTests(fakeStorageFactory([malformed]));
    await expect(loadMeridianActiveAccounts(new Date())).rejects.toThrow(/schema validation/);
  });

  it('rejects trading_account_no that is not a 26-char ULID', async () => {
    const malformed = fakeFile(
      'meridian/active_accounts/2026-05-15.json',
      minimalPayload({ trading_account_no: 'not-a-ulid' }),
    );
    _setStorageFactoryForTests(fakeStorageFactory([malformed]));
    await expect(loadMeridianActiveAccounts(new Date())).rejects.toThrow(/schema validation/);
  });

  it('rejects rows with blank household_name', async () => {
    const malformed = fakeFile('meridian/active_accounts/2026-05-15.json', minimalPayload({ household_name: '   ' }));
    _setStorageFactoryForTests(fakeStorageFactory([malformed]));
    await expect(loadMeridianActiveAccounts(new Date())).rejects.toThrow(/schema validation/);
  });

  it('rejects an empty accounts array', async () => {
    const empty = fakeFile('meridian/active_accounts/2026-05-15.json', {
      ...minimalPayload(),
      accounts: [],
    });
    _setStorageFactoryForTests(fakeStorageFactory([empty]));
    await expect(loadMeridianActiveAccounts(new Date())).rejects.toThrow(/≥1 account/);
  });

  it('rejects duplicate trading_account_no within the same payload', async () => {
    // Pin `now` near the fixture date — the duplicate check runs *after* the
    // 35-day staleness gate, so passing the real current date would (once the
    // 2026-05-15 fixture ages past 35 days) trip the "older than" error first.
    const now = new Date('2026-05-15T13:00:00.000Z');
    const dup = fakeFile('meridian/active_accounts/2026-05-15.json', {
      ...minimalPayload(),
      accounts: [...minimalPayload().accounts, ...minimalPayload({ household_name: 'Other Family' }).accounts],
    });
    _setStorageFactoryForTests(fakeStorageFactory([dup]));
    await expect(loadMeridianActiveAccounts(now)).rejects.toThrow(/duplicate trading_account_no/);
  });

  it('throws when the active_accounts file is older than the 35-day threshold', async () => {
    const now = new Date('2026-05-15T13:00:00.000Z');
    const stale = fakeFile('meridian/active_accounts/2026-03-01.json', minimalPayload());
    _setStorageFactoryForTests(fakeStorageFactory([stale]));

    const ageDays = (now.getTime() - new Date('2026-03-01T00:00:00.000Z').getTime()) / (24 * 3_600_000);
    expect(ageDays).toBeGreaterThan(STALE_SNAPSHOT_THRESHOLD_DAYS);
    await expect(loadMeridianActiveAccounts(now)).rejects.toThrow(/older than 35 days/);
  });

  it('rejects MERIDIAN_SNAPSHOT_SOURCE values other than gcs/s3/file', async () => {
    process.env.MERIDIAN_SNAPSHOT_SOURCE = 'api';
    await expect(loadMeridianActiveAccounts(new Date())).rejects.toThrow(/Unsupported/);
  });

  it('loads from a local file when MERIDIAN_SNAPSHOT_SOURCE=file (dev/testing source)', async () => {
    process.env.MERIDIAN_SNAPSHOT_SOURCE = 'file';
    process.env.MERIDIAN_SNAPSHOT_FILE = SAMPLE_PATH;
    const result = await loadMeridianActiveAccounts(new Date());
    expect(result.accounts).toHaveLength(2);
  });

  it('throws when MERIDIAN_SNAPSHOT_SOURCE=file but MERIDIAN_SNAPSHOT_FILE is unset', async () => {
    process.env.MERIDIAN_SNAPSHOT_SOURCE = 'file';
    delete process.env.MERIDIAN_SNAPSHOT_FILE;
    await expect(loadMeridianActiveAccounts(new Date())).rejects.toThrow(/MERIDIAN_SNAPSHOT_FILE is not set/);
  });
});

// ─── loadMeridianActiveAccountsFromFile + toHouseholdConfig ────────────────

describe('loadMeridianActiveAccountsFromFile + toHouseholdConfig', () => {
  it('parses the bundled fixture and stamps the as_of override on the payload', async () => {
    const payload = await loadMeridianActiveAccountsFromFile(SAMPLE_PATH, '2026-05-15T00:00:00.000Z');
    expect(payload.generatedAt).toBe('2026-05-15T00:00:00.000Z');
    expect(payload.accounts).toHaveLength(2);
    const marsh = payload.accounts.find((a) => a.householdName === 'Marsh + Navarro Family')!;
    expect(marsh.tradingAccountNo).toBe('01SYNTHJ7G094TRY2A6R126CB3');
    expect(marsh.householdId).toBe(3027);
    expect(marsh.accountTitle).toBe('Elliot Marsh - Brokerage');
    expect(marsh.accountType).toBe('NA');
  });

  it('threads household_id through to toHouseholdConfig entries', async () => {
    const payload = await loadMeridianActiveAccountsFromFile(SAMPLE_PATH, '2026-05-15');
    const config = toHouseholdConfig(payload);
    expect(config.entries).toHaveLength(2);
    const marsh = config.byAccountNumber.get('01SYNTHJ7G094TRY2A6R126CB3');
    expect(marsh).toBeDefined();
    expect(marsh!.householdName).toBe('Marsh + Navarro Family');
    expect(marsh!.householdId).toBe(3027);
    expect(marsh!.accountTitle).toBe('Elliot Marsh - Brokerage');
    expect([...config.householdNames].sort()).toEqual(['Calloway Family', 'Marsh + Navarro Family']);
  });

  it('sorts toHouseholdConfig entries by accountNumber ASC for deterministic snapshots', async () => {
    const payload = await loadMeridianActiveAccountsFromFile(SAMPLE_PATH, '2026-05-15');
    const config = toHouseholdConfig(payload);
    const accountNumbers = config.entries.map((e) => e.accountNumber);
    expect(accountNumbers).toEqual([...accountNumbers].sort());
  });

  it('throws HouseholdConfigError when passed a payload with zero accounts', () => {
    expect(() =>
      toHouseholdConfig({
        generatedAt: '2026-05-15T00:00:00.000Z',
        firmId: 'test',
        accountCount: 0,
        rawRowCount: 0,
        accounts: [],
      }),
    ).toThrow(HouseholdConfigError);
  });

  it('throws ActiveAccountsLoadError on a missing file', async () => {
    await expect(loadMeridianActiveAccountsFromFile('/does/not/exist.json', '2026-05-15')).rejects.toBeInstanceOf(
      ActiveAccountsLoadError,
    );
  });
});
