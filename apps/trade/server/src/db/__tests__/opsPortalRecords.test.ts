import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { poolConfigs, poolQuery, warn } = vi.hoisted(() => ({
  poolConfigs: [] as unknown[],
  poolQuery: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(function (this: Record<string, unknown>, config: unknown) {
      poolConfigs.push(config);
      this.query = poolQuery;
      this.on = vi.fn();
      this.end = vi.fn().mockResolvedValue(undefined);
    }),
  },
}));
vi.mock('../../lib/logger.js', () => ({ default: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  OPS_PORTAL_RECORDS_UNAVAILABLE,
  OpsPortalRecordsUnavailableError,
  opsPortalRecordsConfigured,
  opsPortalRecordsDb,
  buildOpsPortalRecordsPoolConfig,
  closeOpsPortalRecordsDb,
} from '../opsPortalRecords.js';

const KEYS = [
  'OPS_PORTAL_RECORDS_DB_HOST',
  'OPS_PORTAL_RECORDS_DB_PASSWORD',
  'OPS_PORTAL_RECORDS_DB_SSL',
  'OPS_PORTAL_RECORDS_DB_SSL_CA',
  'OPS_PORTAL_RECORDS_DB_POOL_MAX',
  'NODE_ENV',
];
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  poolConfigs.length = 0;
  poolQuery.mockReset();
  warn.mockReset();
  await closeOpsPortalRecordsDb();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const CA = '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----';

describe('opsPortalRecords', () => {
  it('is configured only when OPS_PORTAL_RECORDS_DB_HOST is set', () => {
    expect(opsPortalRecordsConfigured({})).toBe(false);
    expect(opsPortalRecordsConfigured({ OPS_PORTAL_RECORDS_DB_HOST: '  ' })).toBe(false);
    expect(opsPortalRecordsConfigured({ OPS_PORTAL_RECORDS_DB_HOST: '10.91.0.2' })).toBe(true);
  });

  it('builds a small, read-only, schema-scoped pool with a verified chain by default', () => {
    process.env.OPS_PORTAL_RECORDS_DB_PASSWORD = 'unit-only';
    process.env.OPS_PORTAL_RECORDS_DB_SSL_CA = CA;
    const config = buildOpsPortalRecordsPoolConfig({ OPS_PORTAL_RECORDS_DB_HOST: '10.91.0.2' });
    expect(config).toMatchObject({
      host: '10.91.0.2',
      port: 5432,
      database: 'opsPortal',
      user: 'trade_request_mcp_ro',
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      options: '-c search_path=trade_request -c default_transaction_read_only=on',
    });
    expect(config.ssl).toMatchObject({ ca: CA, rejectUnauthorized: true });
  });

  it('clamps the pool size to 1..3', () => {
    process.env.OPS_PORTAL_RECORDS_DB_SSL_CA = CA;
    const max = (v: string) =>
      buildOpsPortalRecordsPoolConfig({ OPS_PORTAL_RECORDS_DB_HOST: '10.91.0.2', OPS_PORTAL_RECORDS_DB_POOL_MAX: v }).max;
    expect([max('25'), max('0'), max('abc'), max('3')]).toEqual([3, 1, 2, 3]);
  });

  it('refuses unusable configurations without echoing values', () => {
    expect(() => buildOpsPortalRecordsPoolConfig({ OPS_PORTAL_RECORDS_DB_HOST: '10.91.0.2' })).toThrow(
      'OPS_PORTAL_RECORDS_DB_SSL_CA is required',
    );
    expect(() =>
      buildOpsPortalRecordsPoolConfig({
        OPS_PORTAL_RECORDS_DB_HOST: '10.91.0.2',
        OPS_PORTAL_RECORDS_DB_SSL: 'off',
        NODE_ENV: 'production',
      }),
    ).toThrow('OPS_PORTAL_RECORDS_DB_PASSWORD is required in production');
    process.env.OPS_PORTAL_RECORDS_DB_PASSWORD = 'unit-only';
    expect(() =>
      buildOpsPortalRecordsPoolConfig({
        OPS_PORTAL_RECORDS_DB_HOST: '10.91.0.2',
        OPS_PORTAL_RECORDS_DB_SSL: 'off',
        NODE_ENV: 'production',
      }),
    ).toThrow('OPS_PORTAL_RECORDS_DB_SSL=off is not allowed in production');
    expect(buildOpsPortalRecordsPoolConfig({ OPS_PORTAL_RECORDS_DB_HOST: '10.91.0.2', OPS_PORTAL_RECORDS_DB_SSL: 'off' }).ssl).toBe(false);
  });

  it('turns any read failure into the unavailable error and logs only the error code', async () => {
    process.env.OPS_PORTAL_RECORDS_DB_HOST = '10.91.0.2';
    process.env.OPS_PORTAL_RECORDS_DB_SSL = 'off';
    poolQuery.mockRejectedValueOnce(Object.assign(new Error('permission denied for table x'), { code: '42501' }));
    const err = await opsPortalRecordsDb.query('SELECT 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpsPortalRecordsUnavailableError);
    expect((err as OpsPortalRecordsUnavailableError).statusCode).toBe(503);
    expect((err as Error).message).toBe(OPS_PORTAL_RECORDS_UNAVAILABLE);
    expect(warn).toHaveBeenCalledWith(
      { event: 'mcp_ops_portal_records_unavailable', code: '42501' },
      'OPS_PORTAL records read failed',
    );
    expect(poolConfigs).toHaveLength(1);
  });

  it('reports a missing configuration as unavailable instead of throwing a setup error', async () => {
    process.env.OPS_PORTAL_RECORDS_DB_HOST = '10.91.0.2';
    const err = await opsPortalRecordsDb.query('SELECT 1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpsPortalRecordsUnavailableError);
    expect(poolConfigs).toHaveLength(0);
  });
});
