import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pool from './pool.js';
import logger from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_SEED) {
  logger.error('[seed] Refusing to seed in production. Set ALLOW_SEED=1 to override.');
  process.exit(1);
}

async function seed(): Promise<void> {
  const sql = readFileSync(join(__dirname, 'seed.sql'), 'utf-8');
  const client = await pool.connect();
  try {
    await client.query(sql);
    logger.info('[seed] Seed data applied successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  logger.error({ err }, '[seed] Failed');
  process.exit(1);
});
