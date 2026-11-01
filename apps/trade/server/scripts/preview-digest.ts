/**
 * One-shot local preview of the new daily digest format against a live DB
 * connection (typically the Cloud SQL Auth Proxy on 127.0.0.1). Not committed
 * as a durable artifact — this is a throwaway reviewer tool.
 *
 * Usage (with proxy running on :5433 and PGPASSWORD set):
 *   CLIENT_ORIGIN=https://trade-request.example.run.app \
 *   PGHOST=127.0.0.1 PGPORT=5433 PGUSER=postgres PGDATABASE=trade_request \
 *   npx tsx server/scripts/preview-digest.ts
 */
import { Pool } from 'pg';
import { buildDailyDigest } from '../src/services/digest.js';

async function main() {
  const pool = new Pool({
    host: process.env.PGHOST,
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    max: 2,
  });

  const { text, summary } = await buildDailyDigest(pool);
  console.log('────────── rendered message ──────────');
  console.log(text);
  console.log('────────── summary ──────────');
  console.log(JSON.stringify(summary, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
