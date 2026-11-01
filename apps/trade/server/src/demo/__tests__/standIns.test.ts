import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Server, AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebClient } from '@slack/web-api';

vi.mock('../outbox.js', () => ({ recordOutbox: vi.fn(async () => undefined) }));
// No database here: holdings classify by the curated instrument lists alone.
vi.mock('../../services/securitySector.js', () => ({ getClassificationMap: vi.fn(async () => new Map()) }));

import { recordOutbox } from '../outbox.js';
import { startStandIns } from '../standIns/server.js';
import * as feeds from '../standIns/feeds.js';
import { accountUlid, clientIds } from '../universe.js';
import { fetchClients } from '../../services/warehouse.js';
import { getS3Client } from '../../services/meridianS3.js';
import { loadMeridianTemplates, loadMeridianTemplatesFromFile } from '../../services/meridianTemplates.js';
import { loadMeridianActiveAccountsFromFile } from '../../services/meridianActiveAccounts.js';

const WAREHOUSE_KEY = 'test-warehouse-key';
const SLACK_TOKEN = 'test-slack-token';
let server: Server;
let base: string;

beforeAll(async () => {
  Object.assign(process.env, {
    WAREHOUSE_API_KEY: WAREHOUSE_KEY,
    WAREHOUSE_CONTACTS_QUESTION_ID: 'contacts',
    WAREHOUSE_INVESTMENTS_QUESTION_ID: 'investments',
    WAREHOUSE_BALANCES_QUESTION_ID: 'balances',
    WAREHOUSE_STOCK_RECORD_QUESTION_ID: 'stock-record',
    MERIDIAN_SNAPSHOT_SOURCE: 's3',
    MERIDIAN_SNAPSHOT_S3_BUCKET: 'meridian-feeds',
    MERIDIAN_SNAPSHOT_S3_PREFIX: 'Accounts-and-associations/',
    MERIDIAN_SNAPSHOT_S3_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'stand-in',
    AWS_SECRET_ACCESS_KEY: 'stand-in',
    SLACK_BOT_TOKEN: SLACK_TOKEN,
  });
  server = await startStandIns(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.WAREHOUSE_URL = `${base}/warehouse`;
  process.env.MERIDIAN_SNAPSHOT_S3_ENDPOINT = `${base}/s3`;
});

afterAll(() => {
  server.close();
});

const sql = (query: string) =>
  fetch(`${base}/warehouse/api/dataset/json`, {
    method: 'POST',
    headers: { 'x-api-key': WAREHOUSE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query: JSON.stringify({ database: 4, type: 'native', native: { query } }) }),
  });

describe('feeds', () => {
  const u = feeds.standInUniverse();

  it('uses the same client and account ids as the demo seed', () => {
    const ids = new Set(clientIds(u).values());
    const investments = feeds.investmentRows();
    expect(investments).toHaveLength(u.accounts.length);
    for (const row of investments) expect(ids.has(String(row.user_id))).toBe(true);
    expect(new Set(investments.map((r) => r.custodian_account_number))).toEqual(new Set(u.accounts.map((a) => a.number)));
    expect(accountUlid('acct-001')).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('reconciles: settlement cash plus positions equals total equity, per account', () => {
    const positions = new Map<string, number>();
    for (const r of feeds.stockRecordRows()) {
      positions.set(String(r.account_id), (positions.get(String(r.account_id)) ?? 0) + Number(r.trade_position_value));
    }
    for (const b of feeds.balanceRows()) {
      const sum = Number(b.cash_equity) + (positions.get(String(b.account_id)) ?? 0);
      expect(sum).toBeCloseTo(Number(b.total_equity), 0);
    }
  });

  it("passes the app's own parsers for the templates and active-accounts files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'feeds-'));
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const templatesFile = path.join(dir, `templates_${day}.json`);
    const activeFile = path.join(dir, `active_accounts_${day}.json`);
    writeFileSync(templatesFile, JSON.stringify(feeds.templatesFeed()));
    writeFileSync(activeFile, JSON.stringify(feeds.activeAccountsFeed()));

    const snapshot = await loadMeridianTemplatesFromFile(templatesFile);
    // Every account but the one the model provider hasn't picked up yet.
    expect(snapshot.entries).toHaveLength(u.accounts.length - 1);
    const active = await loadMeridianActiveAccountsFromFile(activeFile);
    expect(active.accounts).toHaveLength(u.accounts.length - 1);
  });

  it('builds drift history: the overweights arrive over time, and Okafor sits in cash today', () => {
    const okafor = u.accounts.find((a) => a.household === 'okafor' && a.type === 'joint-taxable')!;
    const today = feeds.accountStates(new Date()).find((a) => a.account.id === okafor.id)!;
    expect(today.positions).toHaveLength(0);
    expect(today.settlementCash).toBe(okafor.value);
    const weekAgo = feeds.accountStates(new Date(Date.now() - 7 * 86_400_000)).find((a) => a.account.id === okafor.id)!;
    expect(weekAgo.positions.map((p) => p.symbol)).toEqual(['BBGLX']);
  });
});

describe('warehouse stand-in', () => {
  it('refuses a request without the API key', async () => {
    const res = await fetch(`${base}/warehouse/api/card/contacts/query/json`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it("answers the app's warehouse client: clients only, with their accounts", async () => {
    const clients = await fetchClients();
    expect(clients).toHaveLength(feeds.standInUniverse().households.length);
    expect(clients.some((c) => c.name === 'Hollis Family')).toBe(false); // a prospect
    expect(clients.reduce((t, c) => t + c.accounts.length, 0)).toBe(feeds.standInUniverse().accounts.length);
    const alvarez = clients.find((c) => c.name === 'Alvarez Family')!;
    expect(alvarez.accounts[0].holdings.equity).toBeGreaterThan(0);
  });

  it('answers the native queries it knows and refuses the rest', async () => {
    const owners = (await (await sql('SELECT account_id, MAX(ownership_type) AS ownership_type FROM x')).json()) as unknown[];
    expect(owners).toHaveLength(feeds.standInUniverse().accounts.length);
    expect((await sql('SELECT * FROM somewhere_else')).status).toBe(400);
  });

  it('serves open lots only at the weekly snapshot date', async () => {
    const probe = (await (await sql('SELECT 1 AS full_refresh_latest')).json()) as Array<{ full_refresh_latest: string }>;
    const anchor = probe[0].full_refresh_latest;
    // The probe reports the real weekly snapshot (a Friday), not just whatever the lots happen to carry.
    expect(anchor).toBe(feeds.weeklySnapshot(feeds.standInNow()).toISOString().slice(0, 10));
    expect(new Date(`${anchor}T12:00:00Z`).getUTCDay()).toBe(5);
    const lots = (await (
      await sql(`SELECT x FROM apex.apex_cost_basis_open_lot_full_refresh WHERE process_date = '${anchor}'`)
    ).json()) as unknown[];
    expect(lots.length).toBeGreaterThan(0);
    const none = (await (
      await sql(`SELECT x FROM apex.apex_cost_basis_open_lot_full_refresh WHERE process_date = '2001-01-01'`)
    ).json()) as unknown[];
    expect(none).toHaveLength(0);
  });
});

describe('S3 stand-in', () => {
  it('lists and serves the feed files through the AWS SDK', async () => {
    const client = getS3Client();
    const keys = await client.listKeys('meridian-feeds', 'Accounts-and-associations/');
    const day = feeds.standInNow().toISOString().slice(0, 10).replace(/-/g, '');
    expect(keys).toContain(`Accounts-and-associations/templates_${day}.json`);
    const { body } = await client.download('meridian-feeds', `Accounts-and-associations/active_accounts_${day}.json`);
    expect(JSON.parse(body).accounts.length).toBeGreaterThan(0);
    await expect(client.download('meridian-feeds', 'Accounts-and-associations/nope.json')).rejects.toThrow();
  });

  it("loads today's templates through the app's S3 loader", async () => {
    const snapshot = await loadMeridianTemplates(new Date());
    expect(snapshot.entries.length).toBe(feeds.standInUniverse().accounts.length - 1);
  });
});

describe('Slack stand-in', () => {
  it('stores chat.postMessage in the outbox', async () => {
    const slack = new WebClient(SLACK_TOKEN, { slackApiUrl: `${base}/slack/api/` });
    const res = await slack.chat.postMessage({ channel: 'C0DEMOTRADES', text: '*New Trade Request*' });
    expect(res.ok).toBe(true);
    expect(recordOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ transport: 'slack', destination: 'C0DEMOTRADES', body: '*New Trade Request*' }),
    );
  });

  it('rejects a wrong token the way Slack does', async () => {
    const slack = new WebClient('wrong', { slackApiUrl: `${base}/slack/api/`, retryConfig: { retries: 0 } });
    await expect(slack.chat.postMessage({ channel: 'C0DEMOTRADES', text: 'x' })).rejects.toThrow(/invalid_auth/);
  });
});
