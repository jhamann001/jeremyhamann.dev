// Resets the demo: fills the database with the demo data, then runs the jobs that produce drift history
// and the digest against the stand-ins. Run with: npm run seed:demo -w @trade-request/server
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import pool from './pool.js';
import logger from '../lib/logger.js';
import { startStandIns } from '../demo/standIns/server.js';

if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_SEED) {
  logger.error('[seed] Refusing to seed in production. Set ALLOW_SEED=1 to override.');
  process.exit(1);
}

// This process's own stand-ins, on a free port. A dev server may already have its stand-ins on the usual
// port, and some systems let both listen: requests could then reach the server's, whose clock is not the
// reset's. The app's clients are pointed here before the jobs load (the Slack client reads its URL once).
// The keys the app's clients and the stand-ins share live only in this process; make them up if unset.
process.env.WAREHOUSE_API_KEY ||= randomBytes(24).toString('hex');
process.env.SLACK_BOT_TOKEN ||= randomBytes(24).toString('hex');
const standIns = await startStandIns(0);
const base = `http://127.0.0.1:${(standIns.address() as AddressInfo).port}`;
process.env.WAREHOUSE_URL = `${base}/warehouse`;
process.env.MERIDIAN_SNAPSHOT_S3_ENDPOINT = `${base}/s3`;
process.env.SLACK_API_URL = `${base}/slack/api/`;
const { resetDemo } = await import('../demo/reset.js');

try {
  const summary = await resetDemo();
  logger.info(summary, '[seed] Demo reset');
} catch (err) {
  logger.error({ err }, '[seed] Failed');
  process.exitCode = 1;
} finally {
  standIns.close();
  await pool.end();
}
