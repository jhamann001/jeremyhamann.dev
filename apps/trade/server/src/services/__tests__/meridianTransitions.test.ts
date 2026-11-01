import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: vi.fn(), ListObjectsV2Command: vi.fn(), GetObjectCommand: vi.fn() }));

import { loadMeridianTransitions } from '../meridianTransitions.js';
import { _setS3ClientFactoryForTests } from '../meridianS3.js';

const PREFIX = 'Accounts-and-associations/';

function fakeS3(payload: unknown, keys: string[]) {
  return () => ({
    listKeys: vi.fn().mockResolvedValue(keys),
    download: vi.fn().mockResolvedValue({ body: JSON.stringify(payload) }),
  });
}

beforeEach(() => {
  process.env.MERIDIAN_SNAPSHOT_SOURCE = 's3';
  process.env.MERIDIAN_SNAPSHOT_S3_BUCKET = 'cedar-ridge-meridian';
  process.env.MERIDIAN_SNAPSHOT_S3_PREFIX = PREFIX;
});
afterEach(() => {
  _setS3ClientFactoryForTests(null);
  delete process.env.MERIDIAN_SNAPSHOT_SOURCE;
  delete process.env.MERIDIAN_SNAPSHOT_S3_BUCKET;
  delete process.env.MERIDIAN_SNAPSHOT_S3_PREFIX;
});

describe('loadMeridianTransitions', () => {
  it('dedups to the latest transition per account and parses target + source_pnl', async () => {
    const payload = {
      transitions: [
        {
          external_account_no: '**317E',
          title: 'old draft',
          updated_timestamp: '2026-04-23T19:00:32.135',
          req_body: { target_portfolio_name: 'Old', source_pnl: { net_pnl: 1000, st_gains: 1, lt_gains: 2 } },
        },
        {
          external_account_no: '**317E',
          title: 'Vic Lang Borkerage - 5/22',
          updated_timestamp: '2026-05-22T14:23:55.252',
          req_body: {
            target_portfolio_name: 'Risk 18 URTH Russell',
            source_pnl: { net_pnl: 55622, st_gains: 18849, lt_gains: 40958 },
          },
        },
        { external_account_no: '**9TWB', title: 'other', updated_timestamp: '2026-05-01T00:00:00', req_body: {} },
      ],
    };
    _setS3ClientFactoryForTests(fakeS3(payload, [`${PREFIX}transitions_20260601.json`]));
    const m = await loadMeridianTransitions();
    expect(m.size).toBe(2);
    const vic = m.get('**317E')!;
    expect(vic.title).toBe('Vic Lang Borkerage - 5/22'); // latest, not the 4/23 draft
    expect(vic.targetName).toBe('Risk 18 URTH Russell');
    expect(vic.estNetRealizedGainUsd).toBe(55622);
  });

  it('returns empty when the source is not s3 (GCS feed has no transitions)', async () => {
    process.env.MERIDIAN_SNAPSHOT_SOURCE = 'gcs';
    const m = await loadMeridianTransitions();
    expect(m.size).toBe(0);
  });

  it('returns empty (no throw) when no transitions file is present', async () => {
    _setS3ClientFactoryForTests(fakeS3({ transitions: [] }, [`${PREFIX}templates_20260601.json`]));
    const m = await loadMeridianTransitions();
    expect(m.size).toBe(0);
  });
});
