// Direct-service contract tests for writes through the advisor platform delegated surface
// (/api/ops-portal), against a real Postgres with migrations applied (TRW-02: epic
// AC-7, AC-12, AC-21, AC-44, AC-59, AC-128, AC-129, plus standing-exclusion
// creator attribution and the duplicate-suppression log line).
//
// Tokens are signed in local mode (HS256, OPS_PORTAL_DELEGATED_LOCAL_KEY), the same
// middleware path as production except for the key source. One case drives the
// session-mounted routes to prove standalone writes stay marked 'standalone'.
//
// Suite skips cleanly when DATABASE_URL is unset. Synthetic data only; rows use
// a TRW02- / trw02. prefix and are removed afterwards.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';
import { CHECKLIST_ITEM_KEYS } from '@trade-request/shared';

const { loggedCalls } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY = 'trw02-contract-local-key';
  process.env.OPS_PORTAL_DELEGATED_AUDIENCE = 'http://trade-request.test/api/ops-portal';
  process.env.OPS_PORTAL_DELEGATED_CALLER_SA = 'ops-portal-local@delegated.invalid';
  return { loggedCalls: [] as unknown[][] };
});

vi.mock('../../lib/logger.js', () => {
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      loggedCalls.push([level, ...args]);
    };
  const logger: Record<string, unknown> = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    fatal: record('fatal'),
    trace: record('trace'),
  };
  logger.child = () => logger;
  return { default: logger };
});

// Side effects only: no Slack posts and no notification fan-out from tests.
vi.mock('../../services/slack.js', () => ({
  notifyNewRequest: vi.fn(),
  notifyStatusChange: vi.fn(),
  notifyExclusionChange: vi.fn(),
  notifyExclusionBatchChange: vi.fn(),
}));
vi.mock('../../services/notificationInserts.js', () => ({
  fetchActiveTraderUserIds: vi.fn().mockResolvedValue([]),
  insertNotificationsForUsers: vi.fn().mockResolvedValue(undefined),
  notifyUsersSafe: vi.fn(),
}));
vi.mock('../../services/warehouse.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/warehouse.js')>()),
  isConfigured: () => false,
}));

const DATABASE_URL = process.env.DATABASE_URL;
const KEY = new TextEncoder().encode(process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY);
const AUDIENCE = process.env.OPS_PORTAL_DELEGATED_AUDIENCE!;
const CALLER = 'ops-portal-local@delegated.invalid';
const STALE = 'Request was modified by another user. Please refresh and try again.';

const ADVISOR = 'trw02.advisor@example.com';
const OPS = 'trw02.operations@example.com';
const SESSION_TRADER = 'trw02.session.trader@example.com';
const ROSTER_NAMES: Record<string, string> = {
  [ADVISOR]: 'Avery Roster',
  [OPS]: 'Orin Roster',
  [SESSION_TRADER]: 'Sasha Session',
};
const ASSERTION_NAMES: Record<string, string> = {
  [ADVISOR]: 'Avery Assertion',
  [OPS]: 'Orin Assertion',
};
const CLIENT = 'TRW02-CLIENT-1';
const ACCOUNT = 'TRW02-ACCT-1';
const ACCOUNT_ULID = 'TRW02-ACCT-ULID-1';
const REQ_STATUS = 'TRW02-REQ-STATUS';
const REQ_RESUB_A = 'TRW02-REQ-RESUB-A';
const REQ_RESUB_B = 'TRW02-REQ-RESUB-B';
const REQ_RESUB_C = 'TRW02-REQ-RESUB-C';
const REQ_RESUB_D = 'TRW02-REQ-RESUB-D';
const REQ_SESSION = 'TRW02-REQ-SESSION';

async function callerToken() {
  return new SignJWT({ email: CALLER })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(CALLER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(KEY);
}

async function actorAssertion(email: string, role: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ops_portal_role: role, name: ASSERTION_NAMES[email] ?? 'Synthetic Person' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(CALLER)
    .setSubject(email)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(randomUUID())
    .sign(KEY);
}

async function headers(email: string, role: string) {
  return {
    Authorization: `Bearer ${await callerToken()}`,
    'X-OPS-PORTAL-Actor-Assertion': await actorAssertion(email, role),
  };
}

function createBody(tradeAmount: string, idempotencyKey: string = randomUUID()) {
  return {
    clientId: CLIENT,
    clientName: 'Synthetic Client',
    tradeType: 'Raise Cash',
    tradeAmount,
    raiseCashReason: 'synthetic',
    selectedAccounts: [ACCOUNT],
    accountsData: [{ accountNumber: ACCOUNT, accountType: 'Taxable', balance: 100000 }],
    priority: 'Standard',
    idempotencyKey,
  };
}

function resubmitBody(expectedUpdatedAt?: string) {
  return {
    clientId: CLIENT,
    clientName: 'Synthetic Client',
    tradeType: 'Liquidate',
    liquidateOption: 'Entire Account',
    selectedAccounts: [ACCOUNT],
    accountsData: [{ accountNumber: ACCOUNT, accountType: 'Taxable', balance: 100000 }],
    priority: 'Standard',
    advisorNotes: 'resubmitted',
    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
  };
}

describe.skipIf(!DATABASE_URL)('OPS_PORTAL delegated writes — attribution, channel and safeguards (Postgres)', () => {
  let pool: pg.Pool;
  let app: express.Express;
  let sessionApp: express.Express;
  const ids: Record<string, string> = {};

  async function requestRow(id: string) {
    const { rows } = await pool.query(
      `SELECT status, updated_at, advisor_notes,
              (SELECT count(*)::int FROM audit_logs a WHERE a.request_id = tr.id) AS audit_count
         FROM trade_requests tr WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function updatedAt(id: string) {
    return new Date((await requestRow(id)).updated_at).toISOString();
  }

  async function newestAudit(id: string) {
    const { rows } = await pool.query(
      `SELECT action, user_id, user_name, channel FROM audit_logs
        WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    return rows[0];
  }

  async function cleanup() {
    await pool.query(`DELETE FROM client_exclusions WHERE client_id LIKE 'TRW02-%'`);
    await pool.query(`DELETE FROM account_exclusions WHERE account_id LIKE 'TRW02-%'`);
    await pool.query(
      `DELETE FROM trade_requests
        WHERE id LIKE 'TRW02-%' OR advisor_id IN (SELECT id FROM users WHERE lower(email) LIKE 'trw02.%')`,
    );
    await pool.query(`DELETE FROM clients WHERE id LIKE 'TRW02-%'`);
    await pool.query(`DELETE FROM users WHERE lower(email) LIKE 'trw02.%'`);
  }

  async function seedRequest(id: string, status: string) {
    await pool.query(
      `INSERT INTO trade_requests
         (id, client_id, client_name, client_ids, client_names, advisor_id, trade_type, status,
          selected_accounts, priority, advisor_notes, updated_at)
       VALUES ($1, $2::varchar, 'Synthetic Client', jsonb_build_array($2::varchar), '["Synthetic Client"]',
               $3, 'Liquidate', $4, ARRAY[$5::varchar], 'Standard', 'original notes',
               date_trunc('milliseconds', NOW()))`,
      [id, CLIENT, ids[ADVISOR], status, ACCOUNT],
    );
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await cleanup();
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, role, is_active) VALUES
         ($1, $4, 'advisor', true), ($2, $5, 'advisor', true), ($3, $6, 'trader', true)
       RETURNING id, email`,
      [ADVISOR, OPS, SESSION_TRADER, ROSTER_NAMES[ADVISOR], ROSTER_NAMES[OPS], ROSTER_NAMES[SESSION_TRADER]],
    );
    for (const row of rows) ids[row.email] = row.id;
    await pool.query(`INSERT INTO clients (id, name) VALUES ($1, 'Synthetic Client')`, [CLIENT]);
    await seedRequest(REQ_STATUS, 'Pending Review');
    for (const id of [REQ_RESUB_A, REQ_RESUB_B, REQ_RESUB_C, REQ_RESUB_D]) await seedRequest(id, 'Needs Info');
    await seedRequest(REQ_SESSION, 'Pending Review');

    const { requireDelegatedCaller } = await import('../../middleware/delegatedAuth.js');
    const { default: delegatedRoutes, requireDelegatedOperation } = await import('../delegated.js');
    const { default: requestRoutes } = await import('../requests.js');
    const { mapRow } = await import('../../middleware/auth.js');
    const { errorHandler } = await import('../../middleware/errorHandler.js');

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.requestId = 'contract-test';
      next();
    });
    app.use('/api/ops-portal', requireDelegatedOperation, requireDelegatedCaller, delegatedRoutes);
    app.use(errorHandler);

    const sessionUser = mapRow(
      (await pool.query('SELECT * FROM users WHERE email = $1', [SESSION_TRADER])).rows[0] as Record<string, unknown>,
    );
    sessionApp = express();
    sessionApp.use(express.json());
    sessionApp.use((req, _res, next) => {
      req.requestId = 'contract-test-session';
      req.user = sessionUser;
      req.isAuthenticated = (() => true) as typeof req.isAuthenticated;
      req.isDemo = false;
      next();
    });
    sessionApp.use('/api/requests', requestRoutes);
    sessionApp.use(errorHandler);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  describe('AC-7 retried submission', () => {
    it('returns the same single request when a submission is retried with the same idempotencyKey', async () => {
      const key = randomUUID();
      const first = await request(app)
        .post('/api/ops-portal/requests')
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send(createBody('10001', key));
      expect(first.status).toBe(201);

      const retry = await request(app)
        .post('/api/ops-portal/requests')
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send(createBody('10001', key));
      expect(retry.status).toBe(200);
      expect(retry.body.data.id).toBe(first.body.data.id);

      const { rows } = await pool.query('SELECT count(*)::int AS n FROM trade_requests WHERE idempotency_key = $1', [
        key,
      ]);
      expect(rows[0].n).toBe(1);
    });
  });

  describe('AC-128 AC-129 duplicate suppression', () => {
    let survivorId: string;

    it('returns the existing request for an identical submission within 5 minutes', async () => {
      const first = await request(app)
        .post('/api/ops-portal/requests')
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send(createBody('10002'));
      expect(first.status).toBe(201);
      survivorId = first.body.data.id;

      const again = await request(app)
        .post('/api/ops-portal/requests')
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send(createBody('10002'));
      expect(again.status).toBe(200);
      expect(again.body.data.id).toBe(survivorId);

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM trade_requests WHERE advisor_id = $1 AND trade_amount = '10002'`,
        [ids[ADVISOR]],
      );
      expect(rows[0].n).toBe(1);
    });

    it('adds "Duplicate Submission Suppressed" by the person, marked as made through OPS_PORTAL', async () => {
      const { rows } = await pool.query(
        `SELECT user_id, user_name, channel FROM audit_logs
          WHERE request_id = $1 AND action = 'Duplicate Submission Suppressed'`,
        [survivorId],
      );
      expect(rows).toEqual([{ user_id: ids[ADVISOR], user_name: ROSTER_NAMES[ADVISOR], channel: 'opsPortal' }]);
    });

    it('does not suppress once the earlier request is Rejected', async () => {
      await pool.query(`UPDATE trade_requests SET status = 'Rejected' WHERE id = $1`, [survivorId]);
      const res = await request(app)
        .post('/api/ops-portal/requests')
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send(createBody('10002'));
      expect(res.status).toBe(201);
      expect(res.body.data.id).not.toBe(survivorId);
    });

    it('logs counts, not client or account identifiers, for a suppressed submission', () => {
      const call = loggedCalls.find((c) => c[0] === 'warn' && c[2] === 'Suppressed duplicate trade request submission');
      expect(call).toBeDefined();
      expect(call![1]).toEqual({
        existingId: survivorId,
        advisorId: ids[ADVISOR],
        tradeType: 'Raise Cash',
        clientCount: 1,
        accountCount: 1,
      });
      const logged = JSON.stringify(call);
      expect(logged).not.toContain(CLIENT);
      expect(logged).not.toContain(ACCOUNT);
    });
  });

  describe('AC-12 stale status change', () => {
    it('rejects a status change on a request that changed after it was opened', async () => {
      const before = await requestRow(REQ_STATUS);
      const opened = new Date(new Date(before.updated_at).getTime() - 1000).toISOString();
      const res = await request(app)
        .put(`/api/ops-portal/requests/${REQ_STATUS}/status`)
        .set(await headers(OPS, 'OPERATIONS'))
        .send({ status: 'Approved', expectedUpdatedAt: opened });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(STALE);
      expect(await requestRow(REQ_STATUS)).toEqual(before);
    });
  });

  describe('AC-44 stale resubmission', () => {
    it('rejects a resubmission when the request was updated after it was opened', async () => {
      const opened = await updatedAt(REQ_RESUB_A);
      await pool.query(`UPDATE trade_requests SET updated_at = updated_at + interval '1 second' WHERE id = $1`, [
        REQ_RESUB_A,
      ]);
      const before = await requestRow(REQ_RESUB_A);
      const res = await request(app)
        .put(`/api/ops-portal/requests/${REQ_RESUB_A}`)
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send(resubmitBody(opened));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(STALE);
      expect(await requestRow(REQ_RESUB_A)).toEqual(before);
    });

    it('rejects with the same message when the request left Needs Info after it was opened', async () => {
      const opened = await updatedAt(REQ_RESUB_B);
      const moved = await request(app)
        .put(`/api/ops-portal/requests/${REQ_RESUB_B}/status`)
        .set(await headers(OPS, 'OPERATIONS'))
        .send({ status: 'Pending Review', expectedUpdatedAt: opened });
      expect(moved.status).toBe(200);

      const res = await request(app)
        .put(`/api/ops-portal/requests/${REQ_RESUB_B}`)
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send(resubmitBody(opened));
      expect(res.status).toBe(409);
      expect(res.body.error).toBe(STALE);
    });

    it('accepts a resubmission with the current updatedAt and records the person through OPS_PORTAL', async () => {
      const res = await request(app)
        .put(`/api/ops-portal/requests/${REQ_RESUB_C}`)
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send(resubmitBody(await updatedAt(REQ_RESUB_C)));
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('Pending Review');
      expect(await newestAudit(REQ_RESUB_C)).toEqual({
        action: 'Request Resubmitted',
        user_id: ids[ADVISOR],
        user_name: ROSTER_NAMES[ADVISOR],
        channel: 'opsPortal',
      });
    });

    it('refuses a delegated resubmission without expectedUpdatedAt and writes nothing', async () => {
      const before = await requestRow(REQ_RESUB_D);
      const res = await request(app)
        .put(`/api/ops-portal/requests/${REQ_RESUB_D}`)
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send(resubmitBody());
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['expectedUpdatedAt'] })]),
      );
      expect(await requestRow(REQ_RESUB_D)).toEqual(before);
      expect(before.status).toBe('Needs Info');
      expect(before.audit_count).toBe(0);
    });
  });

  describe('AC-21 AC-59 attribution and channel', () => {
    it('records the person, not a service identity, on a delegated create, marked as OPS_PORTAL', async () => {
      const res = await request(app)
        .post('/api/ops-portal/requests')
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send(createBody('10003'));
      expect(res.status).toBe(201);
      const id = res.body.data.id as string;
      const { rows } = await pool.query('SELECT advisor_id FROM trade_requests WHERE id = $1', [id]);
      expect(rows[0].advisor_id).toBe(ids[ADVISOR]);
      const audit = await pool.query(
        'SELECT action, user_id, user_name, channel FROM audit_logs WHERE request_id = $1',
        [id],
      );
      expect(audit.rows).toEqual([
        { action: 'Created Request', user_id: ids[ADVISOR], user_name: ROSTER_NAMES[ADVISOR], channel: 'opsPortal' },
      ]);
      expect(res.body.data.auditLog[0].channel).toBe('opsPortal');
    });

    it('records the person on a delegated status change, marked as OPS_PORTAL', async () => {
      const res = await request(app)
        .put(`/api/ops-portal/requests/${REQ_STATUS}/status`)
        .set(await headers(OPS, 'OPERATIONS'))
        .send({ status: 'Needs Info', note: 'contract test', expectedUpdatedAt: await updatedAt(REQ_STATUS) });
      expect(res.status).toBe(200);
      const { user_id, user_name, channel } = await newestAudit(REQ_STATUS);
      expect({ user_id, user_name, channel }).toEqual({
        user_id: ids[OPS],
        user_name: ROSTER_NAMES[OPS],
        channel: 'opsPortal',
      });
    });

    it('stamps the checklist with the resolved person', async () => {
      const key = CHECKLIST_ITEM_KEYS[0];
      const res = await request(app)
        .put(`/api/ops-portal/requests/${REQ_STATUS}/checklist`)
        .set(await headers(OPS, 'OPERATIONS'))
        .send({ key, checked: true });
      expect(res.status).toBe(200);
      expect(res.body.checklist[key].by).toBe(ROSTER_NAMES[OPS]);
    });

    it('never records the application identity as an actor', async () => {
      const audit = await pool.query('SELECT count(*)::int AS n FROM audit_logs WHERE user_name = $1', [CALLER]);
      const users = await pool.query('SELECT count(*)::int AS n FROM users WHERE lower(email) = $1', [CALLER]);
      expect([audit.rows[0].n, users.rows[0].n]).toEqual([0, 0]);
    });

    it('exposes the channel on every audit entry in the request detail', async () => {
      const res = await request(app)
        .get(`/api/ops-portal/requests/${REQ_STATUS}`)
        .set(await headers(ADVISOR, 'ADVISOR'));
      expect(res.status).toBe(200);
      const channels = (res.body.data.auditLog as Array<{ channel: string }>).map((e) => e.channel);
      expect(channels.length).toBeGreaterThan(0);
      for (const c of channels) expect(['opsPortal', 'standalone']).toContain(c);
      expect(channels).toContain('opsPortal');
    });

    it('keeps session writes marked standalone beside delegated ones', async () => {
      const session = await request(sessionApp)
        .put(`/api/requests/${REQ_SESSION}/status`)
        .send({ status: 'Needs Info', expectedUpdatedAt: await updatedAt(REQ_SESSION) });
      expect(session.status).toBe(200);
      const { channel, user_name } = await newestAudit(REQ_SESSION);
      expect({ channel, user_name }).toEqual({ channel: 'standalone', user_name: ROSTER_NAMES[SESSION_TRADER] });

      const delegated = await request(app)
        .put(`/api/ops-portal/requests/${REQ_SESSION}/status`)
        .set(await headers(OPS, 'OPERATIONS'))
        .send({ status: 'Pending Review', expectedUpdatedAt: await updatedAt(REQ_SESSION) });
      expect(delegated.status).toBe(200);

      const detail = await request(app)
        .get(`/api/ops-portal/requests/${REQ_SESSION}`)
        .set(await headers(ADVISOR, 'ADVISOR'));
      expect((detail.body.data.auditLog as Array<{ channel: string }>).map((e) => e.channel)).toEqual([
        'opsPortal',
        'standalone',
      ]);
    });
  });

  // exclusions.integration and account-exclusions.integration TRUNCATE these
  // tables while other files run, so attribution is read from the INSERT the
  // route issued and from the in-transaction response, never re-read later.
  describe('exclusion creator attribution', () => {
    let querySpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
      querySpy = vi.spyOn(pg.Client.prototype, 'query');
    });

    afterAll(() => {
      querySpy.mockRestore();
    });

    function insertedCreator(table: 'client_exclusions' | 'account_exclusions', ticker: string) {
      const call = (querySpy.mock.calls as unknown as Array<[unknown, unknown[] | undefined]>).find(
        ([text, values]) => typeof text === 'string' && text.includes(`INSERT INTO ${table}`) && values?.[1] === ticker,
      );
      return call?.[1]?.slice(6, 8);
    }

    it('records the person as creator of a client exclusion', async () => {
      const res = await request(app)
        .post(`/api/ops-portal/clients/${CLIENT}/exclusions`)
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send({ ticker: 'TRWA', kind: 'advisor' });
      expect(res.status).toBe(201);
      expect(res.body.data.createdByName).toBe(ROSTER_NAMES[ADVISOR]);
      expect(insertedCreator('client_exclusions', 'TRWA')).toEqual([ids[ADVISOR], ROSTER_NAMES[ADVISOR]]);
    });

    it('records the person as creator of a client exclusion added in a batch', async () => {
      const res = await request(app)
        .post(`/api/ops-portal/clients/${CLIENT}/exclusions/batch`)
        .set(await headers(ADVISOR, 'ADVISOR'))
        .send({ add: [{ ticker: 'TRWB', kind: 'client' }] });
      expect(res.status).toBe(200);
      const added = (res.body.data.exclusions as Array<{ ticker: string; createdByName: string }>).find(
        (e) => e.ticker === 'TRWB',
      );
      expect(added?.createdByName).toBe(ROSTER_NAMES[ADVISOR]);
      expect(insertedCreator('client_exclusions', 'TRWB')).toEqual([ids[ADVISOR], ROSTER_NAMES[ADVISOR]]);
    });

    it('records the person as creator of an account exclusion added in a batch', async () => {
      const res = await request(app)
        .post(`/api/ops-portal/clients/account-exclusions/${ACCOUNT_ULID}/batch`)
        .set(await headers(OPS, 'OPERATIONS'))
        .send({ add: [{ ticker: 'TRWC', kind: 'advisor' }] });
      expect(res.status).toBe(200);
      const added = (res.body.data.exclusions as Array<{ ticker: string; createdByName: string }>).find(
        (e) => e.ticker === 'TRWC',
      );
      expect(added?.createdByName).toBe(ROSTER_NAMES[OPS]);
      expect(insertedCreator('account_exclusions', 'TRWC')).toEqual([ids[OPS], ROSTER_NAMES[OPS]]);
    });
  });
});
