import pg from 'pg';
import logger from '../lib/logger.js';
import { readSecret } from '../lib/secrets.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Read-only connection to OPS_PORTAL's `trade_request` schema (ticket), used only by MCP.
 * Configured by OPS_PORTAL_RECORDS_DB_HOST (the Private Service Connect endpoint address); unset means MCP reads the
 * local database. The login is OPS_PORTAL's `trade_request_mcp_ro` (SELECT only, ticket). OPS_PORTAL's Cloud SQL connection
 * budget is tight, so the pool is capped at 3 per instance and idle connections close after 10 seconds.
 */

export const OPS_PORTAL_RECORDS_UNAVAILABLE =
  'Trade Request records are temporarily unavailable from Ops Portal. Try again in a few minutes.';

export class OpsPortalRecordsUnavailableError extends AppError {
  constructor() {
    super(503, OPS_PORTAL_RECORDS_UNAVAILABLE);
  }
}

/** The query surface shared by the local pool and the Ops Portal connection. */
export interface RecordDb {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export function opsPortalRecordsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPS_PORTAL_RECORDS_DB_HOST?.trim());
}

function poolMax(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(3, Math.max(1, n));
}

/** Throws a plain Error naming the missing setting (never its value) when the configuration is unusable. */
export function buildOpsPortalRecordsPoolConfig(env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  const host = env.OPS_PORTAL_RECORDS_DB_HOST?.trim();
  if (!host) throw new Error('OPS_PORTAL_RECORDS_DB_HOST is not set');
  const password = readSecret('OPS_PORTAL_RECORDS_DB_PASSWORD') ?? '';
  const production = env.NODE_ENV === 'production';
  if (production && !password) throw new Error('OPS_PORTAL_RECORDS_DB_PASSWORD is required in production');
  const sslMode = env.OPS_PORTAL_RECORDS_DB_SSL ?? 'verify-ca';
  if (sslMode !== 'verify-ca' && sslMode !== 'off') throw new Error('OPS_PORTAL_RECORDS_DB_SSL must be verify-ca or off');
  if (production && sslMode === 'off') throw new Error('OPS_PORTAL_RECORDS_DB_SSL=off is not allowed in production');
  const ca = sslMode === 'verify-ca' ? readSecret('OPS_PORTAL_RECORDS_DB_SSL_CA') : undefined;
  if (sslMode === 'verify-ca' && !ca)
    throw new Error('OPS_PORTAL_RECORDS_DB_SSL_CA is required when OPS_PORTAL_RECORDS_DB_SSL=verify-ca');
  return {
    host,
    port: Number(env.OPS_PORTAL_RECORDS_DB_PORT ?? 5432),
    database: env.OPS_PORTAL_RECORDS_DB_NAME ?? 'opsPortal',
    user: env.OPS_PORTAL_RECORDS_DB_USER ?? 'trade_request_mcp_ro',
    password,
    // The chain is verified against OPS_PORTAL's Cloud SQL server CA. The host name is not: the client dials the Private
    // Service Connect address, which is not a name in the server certificate.
    ssl: ca ? { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined } : false,
    max: poolMax(env.OPS_PORTAL_RECORDS_DB_POOL_MAX),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    application_name: 'trade-request-mcp',
    options: '-c search_path=trade_request -c default_transaction_read_only=on',
  };
}

let opsPortalPool: pg.Pool | null = null;

function opsPortalPoolOrThrow(): pg.Pool {
  if (!opsPortalPool) {
    opsPortalPool = new pg.Pool(buildOpsPortalRecordsPoolConfig());
    opsPortalPool.on('error', (err: Error & { code?: string }) => {
      logger.warn({ event: 'mcp_ops_portal_records_pool_error', code: err.code ?? 'unknown' }, 'OPS_PORTAL records pool error');
    });
  }
  return opsPortalPool;
}

/** OPS_PORTAL's records. Every failure (configuration, connection, permission, timeout) becomes OpsPortalRecordsUnavailableError. */
export const opsPortalRecordsDb: RecordDb = {
  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) {
    try {
      return await opsPortalPoolOrThrow().query<R>(text, values);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      logger.warn(
        { event: 'mcp_ops_portal_records_unavailable', code: typeof code === 'string' ? code : 'unknown' },
        'OPS_PORTAL records read failed',
      );
      throw new OpsPortalRecordsUnavailableError();
    }
  },
};

/** Closes the Ops Portal pool; the next read builds a new one from the current settings. */
export async function closeOpsPortalRecordsDb(): Promise<void> {
  const p = opsPortalPool;
  opsPortalPool = null;
  if (p) await p.end();
}
