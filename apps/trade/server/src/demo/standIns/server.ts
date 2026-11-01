// The outside world, for the demo. The clearing firm's warehouse, the model provider's S3 bucket and
// Slack's Web API each answer here in their real wire format, on a loopback-only port inside the
// container. The app reaches them through its ordinary clients (fetch, the AWS SDK, @slack/web-api),
// pointed here by configuration, so every integration's own code runs unchanged. Nothing outside the
// container can connect, and each endpoint still checks the credential the app sends.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import logger from '../../lib/logger.js';
import { readSecret, sameSecret } from '../../lib/secrets.js';
import { recordOutbox } from '../outbox.js';
import * as feeds from './feeds.js';

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function s3Error(res: Response, status: number, code: string, message: string): void {
  res
    .status(status)
    .type('application/xml')
    .send(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`);
}

// ─── Warehouse ────────────────────────────────────────────────

function savedQuestion(id: string): Record<string, unknown>[] | null {
  const e = process.env;
  if (id === e.WAREHOUSE_CONTACTS_QUESTION_ID) return feeds.contactRows();
  if (id === e.WAREHOUSE_INVESTMENTS_QUESTION_ID) return feeds.investmentRows();
  if (id === e.WAREHOUSE_BALANCES_QUESTION_ID) return feeds.balanceRows();
  if (id === e.WAREHOUSE_STOCK_RECORD_QUESTION_ID) return feeds.stockRecordRows();
  return null;
}

/** The app's native SQL, recognized by what it selects. Anything else is refused, never guessed at. */
function nativeQuery(sql: string): Record<string, unknown>[] | null {
  if (sql.includes('closed_full_latest')) return [feeds.closedLotProbe()];
  if (sql.includes('realized_gain_ytd')) return feeds.realizedGainRows();
  if (sql.includes('full_refresh_latest')) return [feeds.openLotProbe()];
  if (sql.includes('open_lot_full_refresh')) {
    // The weekly snapshot at the requested process_date.
    const anchor = /process_date = '(\d{4}-\d{2}-\d{2})'/.exec(sql)?.[1];
    return feeds.openLotRows().filter((r) => r.process_date === anchor);
  }
  // Daily open-lot deltas: none. The stand-in rebuilds the weekly snapshot from each day's positions,
  // so the snapshot already reflects them.
  if (sql.includes('open_lot_refresh')) return [];
  if (sql.includes('ownership_type')) return feeds.ownershipRows();
  if (sql.includes('AS title')) return feeds.accountTitleRows();
  return null;
}

function warehouseRouter(): express.Router {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!sameSecret(req.header('x-api-key'), readSecret('WAREHOUSE_API_KEY'))) {
      res.status(401).json({ message: 'Unauthenticated' });
      return;
    }
    next();
  });
  router.post('/api/card/:id/query/json', (req: Request, res: Response) => {
    const rows = savedQuestion(String(req.params.id));
    if (!rows) {
      res.status(404).json({ message: 'Not found.' });
      return;
    }
    res.json(rows);
  });
  router.post('/api/dataset/json', express.urlencoded({ extended: false, limit: '64kb' }), (req: Request, res: Response) => {
    let sql = '';
    try {
      sql = String(JSON.parse(String(req.body?.query ?? '{}'))?.native?.query ?? '');
    } catch {
      res.status(400).json({ error: 'query is not valid JSON' });
      return;
    }
    const rows = nativeQuery(sql);
    if (!rows) {
      logger.warn({ event: 'stand_in_unknown_sql', sql: sql.slice(0, 120) }, 'warehouse stand-in: unrecognized query');
      res.status(400).json({ error: 'The warehouse stand-in does not answer this query.' });
      return;
    }
    res.json(rows);
  });
  return router;
}

// ─── Model provider's S3 bucket (path-style) ─────────────────────────────

function s3Router(): express.Router {
  const router = express.Router();
  const bucketOk = (bucket: string) => bucket === process.env.MERIDIAN_SNAPSHOT_S3_BUCKET;

  router.get('/:bucket', (req: Request, res: Response) => {
    const bucket = String(req.params.bucket);
    if (!bucketOk(bucket)) return s3Error(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
    const prefix = String(req.query.prefix ?? '');
    const lastModified = `${feeds.standInNow().toISOString().slice(0, 10)}T05:00:00.000Z`;
    const contents = feeds
      .feedFileNames()
      .map((name) => `${prefix}${name}`)
      .map((key) => `<Contents><Key>${escapeXml(key)}</Key><LastModified>${lastModified}</LastModified><ETag>"demo"</ETag><Size>1</Size><StorageClass>STANDARD</StorageClass></Contents>`)
      .join('');
    res
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${escapeXml(bucket)}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${feeds.feedFileNames().length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
  });

  router.get('/:bucket/*key', (req: Request, res: Response) => {
    const bucket = String(req.params.bucket);
    if (!bucketOk(bucket)) return s3Error(res, 404, 'NoSuchBucket', 'The specified bucket does not exist');
    const key = ([] as string[]).concat(req.params.key as string | string[]).join('/');
    const body = feeds.feedFile(key.split('/').pop() ?? '');
    if (body == null) return s3Error(res, 404, 'NoSuchKey', 'The specified key does not exist.');
    res.setHeader('Last-Modified', new Date(`${feeds.standInNow().toISOString().slice(0, 10)}T05:00:00.000Z`).toUTCString());
    res.type('application/json').send(body);
  });
  return router;
}

// ─── Slack Web API ───────────────────────────────────────────────

function slackRouter(): express.Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '256kb' }), express.json({ limit: '256kb' }));
  router.post('/api/:method', async (req: Request, res: Response) => {
    const token = req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? req.body?.token;
    if (!sameSecret(token, readSecret('SLACK_BOT_TOKEN'))) {
      res.json({ ok: false, error: 'invalid_auth' });
      return;
    }
    if (req.params.method !== 'chat.postMessage') {
      res.json({ ok: false, error: 'unknown_method' });
      return;
    }
    const channel = String(req.body?.channel ?? '');
    const text = String(req.body?.text ?? '');
    if (!channel || !text) {
      res.json({ ok: false, error: channel ? 'no_text' : 'channel_not_found' });
      return;
    }
    const at = feeds.standInNow();
    try {
      await recordOutbox({ transport: 'slack', destination: channel, body: text, at });
    } catch (err) {
      logger.error({ err }, 'slack stand-in: outbox write failed');
      res.status(500).json({ ok: false, error: 'internal_error' });
      return;
    }
    res.json({ ok: true, channel, ts: `${Math.floor(at.getTime() / 1000)}.000100`, message: { type: 'message', text } });
  });
  return router;
}

/** Start the stand-ins on 127.0.0.1. Resolves once they are listening. */
export function startStandIns(port = Number(process.env.STAND_INS_PORT ?? 8090)): Promise<Server> {
  const app = express();
  app.disable('x-powered-by');
  app.use('/warehouse', warehouseRouter());
  app.use('/s3', s3Router());
  app.use('/slack', slackRouter());
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      logger.info({ port }, 'demo stand-ins listening on loopback');
      resolve(server);
    });
    server.on('error', reject);
  });
}
