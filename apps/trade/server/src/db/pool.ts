import pg from 'pg';
import dotenv from 'dotenv';
import logger from '../lib/logger.js';
import { readSecret } from '../lib/secrets.js';

dotenv.config();

// A full connection string (hosted Postgres such as Neon) takes precedence over the discrete DB_* settings.
const DATABASE_URL = readSecret('DATABASE_URL');
const DB_PASSWORD = readSecret('DB_PASSWORD') ?? '';
if (process.env.NODE_ENV === 'production' && !DATABASE_URL && !DB_PASSWORD) {
  throw new Error('DATABASE_URL or DB_PASSWORD is required in production');
}

// Cloud Run concurrency=80 with max 3 instances = 240 concurrent requests.
// Pool should be sized so total connections (max_instances × pool_max) stays
// under Cloud SQL max_connections (default 100). 25 × 3 = 75 leaves headroom.
const poolConfig: pg.PoolConfig = {
  max: Number(process.env.DB_POOL_MAX ?? 25),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
};

if (DATABASE_URL) {
  // TLS is on and the server certificate verified (hosted Postgres uses a publicly trusted certificate),
  // unless the URL says sslmode=disable, as a local Postgres does. sslmode/channel_binding are read here
  // and removed from the string so pg doesn't apply its own, differently-defined interpretation of them.
  const url = new URL(DATABASE_URL);
  const channelBinding = url.searchParams.get('channel_binding');
  const sslDisabled = url.searchParams.get('sslmode') === 'disable';
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  poolConfig.connectionString = url.toString();
  poolConfig.ssl = sslDisabled ? false : { rejectUnauthorized: true };
  // pg 8.23 supports SCRAM channel binding; @types/pg doesn't declare the option yet.
  if (channelBinding === 'require') (poolConfig as pg.PoolConfig & { enableChannelBinding?: boolean }).enableChannelBinding = true;
} else if (process.env.DB_SOCKET_PATH) {
  poolConfig.host = `${process.env.DB_SOCKET_PATH}`;
  poolConfig.database = process.env.DB_NAME ?? 'trade_request';
  poolConfig.user = process.env.DB_USER ?? 'postgres';
  poolConfig.password = DB_PASSWORD;
} else {
  poolConfig.host = process.env.DB_HOST ?? '127.0.0.1';
  poolConfig.port = Number(process.env.DB_PORT ?? 5432);
  poolConfig.database = process.env.DB_NAME ?? 'trade_request';
  poolConfig.user = process.env.DB_USER ?? 'postgres';
  poolConfig.password = DB_PASSWORD;

  if (process.env.DB_SSL === 'true') {
    if (process.env.DB_SSL_CA) {
      poolConfig.ssl = { ca: process.env.DB_SSL_CA, rejectUnauthorized: true };
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error('DB_SSL_CA is required in production when DB_SSL=true');
    } else {
      poolConfig.ssl = { rejectUnauthorized: false };
    }
  }
}

const pool = new pg.Pool(poolConfig);

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected pool error');
});

export default pool;
