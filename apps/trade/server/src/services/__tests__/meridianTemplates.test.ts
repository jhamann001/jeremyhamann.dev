import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(),
  ListObjectsV2Command: vi.fn(),
  GetObjectCommand: vi.fn(),
}));

import {
  loadMeridianTemplates,
  loadMeridianTemplatesFromFile,
  _setStorageFactoryForTests,
  _setS3ClientFactoryForTests,
  EQUITY_BASKET_SYMBOL,
} from '../meridianTemplates.js';
import { SnapshotLoadError, STALE_SNAPSHOT_THRESHOLD_DAYS } from '../meridianSnapshot.js';
import logger from '../../lib/logger.js';

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(FIXTURE_DIR, 'fixtures', 'meridian-templates-sample.json');

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

interface FakeS3Object {
  key: string;
  payload: unknown;
  lastModified?: string;
}

function fakeS3ClientFactory(objects: FakeS3Object[]) {
  const byKey = new Map(objects.map((o) => [o.key, o]));
  return () => ({
    listKeys: vi.fn().mockResolvedValue(objects.map((o) => o.key)),
    download: vi.fn(async (_bucket: string, key: string) => {
      const obj = byKey.get(key);
      if (!obj) throw new Error(`no such key ${key}`);
      return { body: JSON.stringify(obj.payload), lastModified: obj.lastModified };
    }),
  });
}

function templatesPayload(accountOverrides: Record<string, unknown> = {}) {
  return {
    generated_at: '2026-05-15T01:00:00.000Z',
    firm_id: 'test',
    account_count: 1,
    raw_row_count: 1,
    template_count: 1,
    accounts: [
      {
        account_id: 1,
        account_title: 'Test Acct',
        external_account_no: 'TEST_ULID_XYZ',
        master_id: 'CEDAR_RIDGE',
        templates: [
          {
            template_id: 1,
            template_name: 'Default',
            is_levered: 0,
            tolerance: 0.05,
            constituents: [{ security: 'SPY', securityType: 'IndividualSecurity', alloc_pct: 100 }],
          },
        ],
        ...accountOverrides,
      },
    ],
  };
}

beforeEach(() => {
  process.env.MERIDIAN_SNAPSHOT_SOURCE = 'gcs';
  process.env.MERIDIAN_SNAPSHOT_BUCKET = 'test-bucket';
  vi.clearAllMocks();
});

afterEach(() => {
  _setStorageFactoryForTests(null);
  _setS3ClientFactoryForTests(null);
  delete process.env.MERIDIAN_SNAPSHOT_SOURCE;
  delete process.env.MERIDIAN_SNAPSHOT_BUCKET;
  delete process.env.MERIDIAN_SNAPSHOT_S3_BUCKET;
  delete process.env.MERIDIAN_SNAPSHOT_S3_PREFIX;
});

// ─── loadMeridianTemplates (GCS happy path) ────────────────────────────────

describe('loadMeridianTemplates — happy path (GCS)', () => {
  it('returns the newest templates file when multiple are present', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const newer = fakeFile('meridian/templates/2026-05-15.json', templatesPayload());
    const older = fakeFile('meridian/templates/2026-05-14.json', templatesPayload());
    _setStorageFactoryForTests(fakeStorageFactory([older, newer]));

    const result = await loadMeridianTemplates(now);
    expect(result.entries).toHaveLength(1);
    expect(result.generatedAt).toBe('2026-05-15T00:00:00.000Z');
    expect(older.download).not.toHaveBeenCalled();
  });

  it('flattens a single-template-per-account nested payload into MeridianSnapshotEntry rows', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const f = fakeFile('meridian/templates/2026-05-15.json', templatesPayload());
    _setStorageFactoryForTests(fakeStorageFactory([f]));
    const result = await loadMeridianTemplates(now);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry.account).toBe('TEST_ULID_XYZ');
    expect(entry.accountTitle).toBe('Test Acct');
    expect(entry.templateName).toBe('Default');
    expect(entry.weights).toEqual({ SPY: 100 });
    expect(entry.asOf).toBe('2026-05-15T00:00:00.000Z');
  });

  it('aggregates `My Firm` + `Personal` constituents into a synthetic __EQUITY_BASKET__ weight (decision #7)', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const payload = templatesPayload({
      templates: [
        {
          template_id: 1,
          template_name: 'Mixed',
          is_levered: 0,
          tolerance: 0.05,
          constituents: [
            { security: 'AGG', securityType: 'IndividualSecurity', alloc_pct: 30 },
            { security: 'opaque-firm-id', securityType: 'My Firm', alloc_pct: 50 },
            { security: 'opaque-personal-id', securityType: 'Personal', alloc_pct: 20 },
          ],
        },
      ],
    });
    const f = fakeFile('meridian/templates/2026-05-15.json', payload);
    _setStorageFactoryForTests(fakeStorageFactory([f]));
    const result = await loadMeridianTemplates(now);
    expect(result.entries[0].weights).toEqual({ AGG: 30, [EQUITY_BASKET_SYMBOL]: 70 });
    // Opaque IDs MUST NOT leak through as keys — the comparator only ever
    // sees the synthetic basket symbol, not the raw Meridian sleeve ID.
    expect(result.entries[0].weights['opaque-firm-id']).toBeUndefined();
    expect(result.entries[0].weights['opaque-personal-id']).toBeUndefined();
  });

  it('routes `IndividualSecurity` constituents through `classifySymbol` (no synthetic basket)', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const payload = templatesPayload({
      templates: [
        {
          template_id: 1,
          template_name: 'AllIndividual',
          is_levered: 0,
          tolerance: 0.05,
          constituents: [
            { security: 'VOO', securityType: 'IndividualSecurity', alloc_pct: 60 },
            { security: 'BND', securityType: 'IndividualSecurity', alloc_pct: 40 },
          ],
        },
      ],
    });
    const f = fakeFile('meridian/templates/2026-05-15.json', payload);
    _setStorageFactoryForTests(fakeStorageFactory([f]));
    const result = await loadMeridianTemplates(now);
    expect(result.entries[0].weights).toEqual({ VOO: 60, BND: 40 });
    expect(result.entries[0].weights[EQUITY_BASKET_SYMBOL]).toBeUndefined();
  });

  it('warns on per-account weight-sum drift outside ±1pp (e.g. the known 56.2% template)', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const payload = templatesPayload({
      templates: [
        {
          template_id: 1,
          template_name: 'Anomaly',
          is_levered: 0,
          tolerance: 0.05,
          constituents: [{ security: 'SPY', securityType: 'IndividualSecurity', alloc_pct: 56.2 }],
        },
      ],
    });
    const f = fakeFile('meridian/templates/2026-05-15.json', payload);
    _setStorageFactoryForTests(fakeStorageFactory([f]));
    await loadMeridianTemplates(now);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'templates_weight_sum_anomaly',
        account: 'TEST_ULID_XYZ',
        observedSumPct: 56.2,
      }),
      expect.stringContaining('outside tolerance'),
    );
  });

  it('filters out non-CEDAR-RIDGE master_id rows', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const payload = {
      ...templatesPayload(),
      accounts: [
        templatesPayload().accounts[0],
        {
          ...templatesPayload({ external_account_no: 'DEMO_ULID' }).accounts[0],
          master_id: 'CedarRidge_DEMO',
        },
      ],
    };
    const f = fakeFile('meridian/templates/2026-05-15.json', payload);
    _setStorageFactoryForTests(fakeStorageFactory([f]));
    const result = await loadMeridianTemplates(now);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].account).toBe('TEST_ULID_XYZ');
  });

  it('excludes accounts in INACTIVE_APEX_ACCOUNTS', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const payload = {
      ...templatesPayload(),
      accounts: [
        templatesPayload().accounts[0],
        templatesPayload({ external_account_no: '01SYNTHD7WE9TKCBRPS3BQMGTG' }).accounts[0],
      ],
    };
    const f = fakeFile('meridian/templates/2026-05-15.json', payload);
    _setStorageFactoryForTests(fakeStorageFactory([f]));
    const result = await loadMeridianTemplates(now);
    expect(result.entries.map((e) => e.account)).toEqual(['TEST_ULID_XYZ']);
  });

  it('excludes accounts in CORPORATE_APEX_ACCOUNTS', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    const payload = {
      ...templatesPayload(),
      accounts: [
        templatesPayload().accounts[0],
        templatesPayload({ external_account_no: '01SYNTH6BDYNAGTJ07KC0SFYGY' }).accounts[0],
      ],
    };
    const f = fakeFile('meridian/templates/2026-05-15.json', payload);
    _setStorageFactoryForTests(fakeStorageFactory([f]));
    const result = await loadMeridianTemplates(now);
    expect(result.entries.map((e) => e.account)).toEqual(['TEST_ULID_XYZ']);
  });
});

// ─── loadMeridianTemplates (failure cases) ─────────────────────────────────

describe('loadMeridianTemplates — failure cases', () => {
  it('throws SnapshotLoadError when bucket env var is missing', async () => {
    delete process.env.MERIDIAN_SNAPSHOT_BUCKET;
    await expect(loadMeridianTemplates(new Date())).rejects.toBeInstanceOf(SnapshotLoadError);
  });

  it('throws when no templates files exist', async () => {
    _setStorageFactoryForTests(fakeStorageFactory([]));
    await expect(loadMeridianTemplates(new Date())).rejects.toThrow(/No templates files/);
  });

  it('throws on invalid JSON', async () => {
    const broken: FakeFile = {
      name: 'meridian/templates/2026-05-15.json',
      download: vi.fn().mockResolvedValue([Buffer.from('{ this is not json', 'utf-8')]),
    };
    _setStorageFactoryForTests(fakeStorageFactory([broken]));
    await expect(loadMeridianTemplates(new Date())).rejects.toThrow(/not valid JSON/);
  });

  it('rejects a payload missing the top-level accounts array', async () => {
    const malformed = fakeFile('meridian/templates/2026-05-15.json', { firm_id: 'test' });
    _setStorageFactoryForTests(fakeStorageFactory([malformed]));
    await expect(loadMeridianTemplates(new Date())).rejects.toThrow(/schema validation/);
  });

  it('rejects accounts with zero templates', async () => {
    const malformed = fakeFile('meridian/templates/2026-05-15.json', templatesPayload({ templates: [] }));
    _setStorageFactoryForTests(fakeStorageFactory([malformed]));
    await expect(loadMeridianTemplates(new Date())).rejects.toThrow(/schema validation/);
  });

  it('rejects templates with zero constituents', async () => {
    const malformed = fakeFile(
      'meridian/templates/2026-05-15.json',
      templatesPayload({
        templates: [
          {
            template_id: 1,
            template_name: 'Empty',
            is_levered: 0,
            tolerance: 0.05,
            constituents: [],
          },
        ],
      }),
    );
    _setStorageFactoryForTests(fakeStorageFactory([malformed]));
    await expect(loadMeridianTemplates(new Date())).rejects.toThrow(/schema validation/);
  });

  it('throws when the templates file is older than the 35-day threshold', async () => {
    const now = new Date('2026-05-15T13:00:00.000Z');
    const stale = fakeFile('meridian/templates/2026-03-01.json', templatesPayload());
    _setStorageFactoryForTests(fakeStorageFactory([stale]));

    const ageDays = (now.getTime() - new Date('2026-03-01T00:00:00.000Z').getTime()) / (24 * 3_600_000);
    expect(ageDays).toBeGreaterThan(STALE_SNAPSHOT_THRESHOLD_DAYS);
    await expect(loadMeridianTemplates(now)).rejects.toThrow(/older than 35 days/);
  });

  it('rejects MERIDIAN_SNAPSHOT_SOURCE values other than gcs', async () => {
    process.env.MERIDIAN_SNAPSHOT_SOURCE = 'api';
    await expect(loadMeridianTemplates(new Date())).rejects.toThrow(/Unsupported/);
  });
});

// ─── loadMeridianTemplates (S3 source) ─────────────────────────────────────

describe('loadMeridianTemplates — S3 source', () => {
  beforeEach(() => {
    process.env.MERIDIAN_SNAPSHOT_SOURCE = 's3';
    process.env.MERIDIAN_SNAPSHOT_S3_BUCKET = 'test-s3-bucket';
  });

  it('returns the newest templates_YYYYMMDD.json, ignoring sibling feeds in the prefix', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    _setS3ClientFactoryForTests(
      fakeS3ClientFactory([
        { key: 'Accounts-and-associations/templates_20260514.json', payload: templatesPayload() },
        { key: 'Accounts-and-associations/templates_20260515.json', payload: templatesPayload() },
        // Sibling feeds share the prefix and lexically outsort templates_ — must NOT be picked.
        { key: 'Accounts-and-associations/transitions_20260515.json', payload: templatesPayload() },
        { key: 'Accounts-and-associations/active_accounts_20260515.json', payload: templatesPayload() },
      ]),
    );
    const result = await loadMeridianTemplates(now);
    expect(result.entries).toHaveLength(1);
    expect(result.generatedAt).toBe('2026-05-15T00:00:00.000Z');
    expect(result.entries[0].account).toBe('TEST_ULID_XYZ');
  });

  it('ignores files that do not match templates_YYYYMMDD.json', async () => {
    _setS3ClientFactoryForTests(
      fakeS3ClientFactory([
        { key: 'Accounts-and-associations/templates_latest.json', payload: templatesPayload() },
        { key: 'Accounts-and-associations/transitions_20260515.json', payload: templatesPayload() },
      ]),
    );
    await expect(loadMeridianTemplates(new Date('2026-05-15T03:00:00.000Z'))).rejects.toThrow(
      /No templates_YYYYMMDD\.json/,
    );
  });

  it('honors a custom MERIDIAN_SNAPSHOT_S3_PREFIX', async () => {
    const now = new Date('2026-05-15T03:00:00.000Z');
    process.env.MERIDIAN_SNAPSHOT_S3_PREFIX = 'custom/path';
    const factory = fakeS3ClientFactory([{ key: 'custom/path/templates_20260515.json', payload: templatesPayload() }]);
    const client = factory();
    _setS3ClientFactoryForTests(() => client);
    await loadMeridianTemplates(now);
    // Trailing slash is normalized onto the prefix before listing.
    expect(client.listKeys).toHaveBeenCalledWith('test-s3-bucket', 'custom/path/');
  });

  it('throws SnapshotLoadError when the S3 bucket env var is missing', async () => {
    delete process.env.MERIDIAN_SNAPSHOT_S3_BUCKET;
    await expect(loadMeridianTemplates(new Date())).rejects.toThrow(
      /MERIDIAN_SNAPSHOT_S3_BUCKET is not configured/,
    );
  });

  it('throws when no templates files exist under the prefix', async () => {
    _setS3ClientFactoryForTests(fakeS3ClientFactory([]));
    await expect(loadMeridianTemplates(new Date('2026-05-15T03:00:00.000Z'))).rejects.toThrow(
      /No templates_YYYYMMDD\.json/,
    );
  });

  it('throws on invalid JSON', async () => {
    _setS3ClientFactoryForTests(() => ({
      listKeys: vi.fn().mockResolvedValue(['Accounts-and-associations/templates_20260515.json']),
      download: vi.fn().mockResolvedValue({ body: '{ not json' }),
    }));
    await expect(loadMeridianTemplates(new Date('2026-05-15T03:00:00.000Z'))).rejects.toThrow(/not valid JSON/);
  });

  it('throws when the templates file is older than the 35-day threshold', async () => {
    const now = new Date('2026-05-15T13:00:00.000Z');
    _setS3ClientFactoryForTests(
      fakeS3ClientFactory([{ key: 'Accounts-and-associations/templates_20260301.json', payload: templatesPayload() }]),
    );
    await expect(loadMeridianTemplates(now)).rejects.toThrow(/older than 35 days/);
  });
});

// ─── loadMeridianTemplatesFromFile + fixture round-trip ───────────────────

describe('loadMeridianTemplatesFromFile', () => {
  it('parses the bundled fixture into two accounts with summed weights at ~100 each', async () => {
    const snapshot = await loadMeridianTemplatesFromFile(SAMPLE_PATH, '2026-05-15');
    expect(snapshot.entries).toHaveLength(2);
    for (const entry of snapshot.entries) {
      const sum = Object.values(entry.weights).reduce((s, v) => s + v, 0);
      expect(Math.abs(sum - 100)).toBeLessThanOrEqual(1);
    }
    // ZZ10002 uses only IndividualSecurity — no equity-basket key.
    const bh = snapshot.entries.find((e) => e.account === 'ZZ10002')!;
    expect(bh.weights[EQUITY_BASKET_SYMBOL]).toBeUndefined();
    // WXYZ123 has My Firm (20) + Personal (10) → 30% equity basket.
    const wx = snapshot.entries.find((e) => e.account === 'WXYZ123')!;
    expect(wx.weights[EQUITY_BASKET_SYMBOL]).toBe(30);
    expect(wx.weights.VOO).toBe(40);
  });

  it('throws SnapshotLoadError on a missing file', async () => {
    await expect(loadMeridianTemplatesFromFile('/does/not/exist.json', '2026-05-15')).rejects.toBeInstanceOf(
      SnapshotLoadError,
    );
  });
});
