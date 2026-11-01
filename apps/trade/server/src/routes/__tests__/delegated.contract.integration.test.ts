// Direct-service contract tests for the Ops Portal delegated surface (/api/ops-portal),
// called the way Ops Portal calls it, once per Ops Portal role, against a real Postgres with
// migrations applied (TRW-01: epic AC-14, AC-26, AC-27, AC-67, AC-68).
//
// Tokens are signed in local mode (HS256, OPS_PORTAL_DELEGATED_LOCAL_KEY), which runs
// the same middleware path as production except for the key source; the
// production RS256 path is covered in middleware/__tests__/delegatedAuth.test.ts.
//
// Suite skips cleanly when DATABASE_URL is unset. Synthetic data only; rows use
// a TRW01- / trw01. prefix and are removed afterwards.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { Pool } from 'pg';
import { CHECKLIST_ITEM_KEYS } from '@trade-request/shared';

const { loggedCalls } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY = 'trw01-contract-local-key';
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
vi.mock('../../services/slack.js', () => ({ notifyNewRequest: vi.fn(), notifyStatusChange: vi.fn() }));
vi.mock('../../services/notificationInserts.js', () => ({
  fetchActiveTraderUserIds: vi.fn().mockResolvedValue([]),
  insertNotificationsForUsers: vi.fn().mockResolvedValue(undefined),
  notifyUsersSafe: vi.fn(),
}));

const DATABASE_URL = process.env.DATABASE_URL;
const KEY = new TextEncoder().encode(process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY);
const AUDIENCE = process.env.OPS_PORTAL_DELEGATED_AUDIENCE!;
const CALLER = 'ops-portal-local@delegated.invalid';

const ADVISOR_A = 'trw01.advisor.a@example.com';
const ADVISOR_B = 'trw01.advisor.b@example.com';
const OPS = 'trw01.operations@example.com';
const ADMIN = 'trw01.admin@example.com';
const NEWCOMER = 'trw01.newcomer@example.com';
const CLIENT = 'TRW01-CLIENT-1';
const PENDING = 'TRW01-REQ-PENDING';
const NEEDS_INFO = 'TRW01-REQ-NEEDSINFO';
const NAMES: Record<string, string> = {
  [ADVISOR_A]: 'Avery Synthetic',
  [ADVISOR_B]: 'Blake Synthetic',
  [OPS]: 'Orin Synthetic',
  [ADMIN]: 'Ada Synthetic',
  [NEWCOMER]: 'Nova Synthetic',
};

async function callerToken() {
  return new SignJWT({ email: CALLER })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(CALLER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(KEY);
}

interface AssertionOverrides {
  audience?: string;
  issuer?: string;
  iat?: number;
  exp?: number;
  key?: Uint8Array;
}

async function actorAssertion(email: string, role: string, o: AssertionOverrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ops_portal_role: role, name: NAMES[email] ?? 'Synthetic Person' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(o.issuer ?? CALLER)
    .setSubject(email)
    .setAudience(o.audience ?? AUDIENCE)
    .setIssuedAt(o.iat ?? now)
    .setExpirationTime(o.exp ?? now + 120)
    .setJti(`jti-${Math.random()}`)
    .sign(o.key ?? KEY);
}

async function headers(email: string, role: string, o?: AssertionOverrides) {
  return {
    Authorization: `Bearer ${await callerToken()}`,
    'X-OPS-PORTAL-Actor-Assertion': await actorAssertion(email, role, o),
  };
}

describe.skipIf(!DATABASE_URL)('OPS_PORTAL delegated surface — direct-service contract (Postgres)', () => {
  let pool: Pool;
  let app: express.Express;
  const issuedTokens: string[] = [];

  async function requestRow(id: string) {
    const { rows } = await pool.query(
      `SELECT status, updated_at, preapproval_checklist, advisor_notes,
              (SELECT count(*)::int FROM audit_logs a WHERE a.request_id = tr.id) AS audit_count
         FROM trade_requests tr WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function userId(email: string) {
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    return rows[0]?.id as string | undefined;
  }

  async function cleanup() {
    await pool.query(`DELETE FROM trade_requests WHERE id LIKE 'TRW01-%'`);
    await pool.query(`DELETE FROM clients WHERE id LIKE 'TRW01-%'`);
    await pool.query(`DELETE FROM users WHERE lower(email) LIKE 'trw01.%'`);
  }

  async function seedRequest(id: string, status: string, advisorEmail: string) {
    await pool.query(
      `INSERT INTO trade_requests
         (id, client_id, client_name, client_ids, client_names, advisor_id, trade_type, status,
          selected_accounts, priority, advisor_notes, updated_at)
       VALUES ($1, $2::varchar, 'Synthetic Client', jsonb_build_array($2::varchar), '["Synthetic Client"]',
               (SELECT id FROM users WHERE email = $3), 'Liquidate', $4,
               ARRAY['TRW01-ACCT-1'], 'Standard', 'original notes', date_trunc('milliseconds', NOW()))`,
      [id, CLIENT, advisorEmail, status],
    );
  }

  async function freshUpdatedAt(id: string) {
    const row = await requestRow(id);
    return new Date(row.updated_at).toISOString();
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();
    // Existing roster records: ADVISOR_B's row is stored with mixed case to prove
    // case-insensitive matching; OPS is deliberately on the roster as an advisor
    // to prove the Ops Portal role, not the roster role, decides authority (D1).
    await pool.query(
      `INSERT INTO users (email, name, role, is_active) VALUES
         ($1, $4, 'advisor', true), ('Trw01.Advisor.B@example.com', $5, 'advisor', true),
         ($2, $6, 'advisor', true), ($3, $7, 'trader', false)`,
      [ADVISOR_A, OPS, ADMIN, NAMES[ADVISOR_A], NAMES[ADVISOR_B], NAMES[OPS], NAMES[ADMIN]],
    );
    await pool.query(`INSERT INTO clients (id, name) VALUES ($1, 'Synthetic Client')`, [CLIENT]);
    await seedRequest(PENDING, 'Pending Review', ADVISOR_A);
    await seedRequest(NEEDS_INFO, 'Needs Info', 'Trw01.Advisor.B@example.com');

    const { requireDelegatedCaller } = await import('../../middleware/delegatedAuth.js');
    const { default: delegatedRoutes, requireDelegatedOperation } = await import('../delegated.js');
    const { errorHandler } = await import('../../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.requestId = 'contract-test';
      const token = req.headers['x-ops-portal-actor-assertion'];
      if (typeof token === 'string') issuedTokens.push(token);
      next();
    });
    app.use('/api/ops-portal', requireDelegatedOperation, requireDelegatedCaller, delegatedRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  describe('AC-14 — reviewer-only actions', () => {
    it('leaves the request unchanged when an ADVISOR changes its status', async () => {
      const before = await requestRow(PENDING);
      const res = await request(app)
        .put(`/api/ops-portal/requests/${PENDING}/status`)
        .set(await headers(ADVISOR_A, 'ADVISOR'))
        .send({ status: 'Approved', expectedUpdatedAt: new Date(before.updated_at).toISOString() });
      expect(res.status).toBe(403);
      expect(await requestRow(PENDING)).toEqual(before);
    });

    it('leaves the checklist unchanged when an ADVISOR edits it', async () => {
      const before = await requestRow(PENDING);
      const res = await request(app)
        .put(`/api/ops-portal/requests/${PENDING}/checklist`)
        .set(await headers(ADVISOR_A, 'ADVISOR'))
        .send({ key: CHECKLIST_ITEM_KEYS[0], checked: true });
      expect(res.status).toBe(403);
      expect(await requestRow(PENDING)).toEqual(before);
    });

    it('lets OPERATIONS edit the checklist and records the person', async () => {
      const res = await request(app)
        .put(`/api/ops-portal/requests/${PENDING}/checklist`)
        .set(await headers(OPS, 'OPERATIONS'))
        .send({ key: CHECKLIST_ITEM_KEYS[0], checked: true });
      expect(res.status).toBe(200);
      expect(res.body.checklist[CHECKLIST_ITEM_KEYS[0]]).toMatchObject({ checked: true, by: NAMES[OPS] });
    });

    it('lets OPERATIONS change status even though the roster lists them as an advisor (D1)', async () => {
      const res = await request(app)
        .put(`/api/ops-portal/requests/${PENDING}/status`)
        .set(await headers(OPS, 'OPERATIONS'))
        .send({ status: 'Needs Info', note: 'contract test', expectedUpdatedAt: await freshUpdatedAt(PENDING) });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('Needs Info');
      const { rows } = await pool.query(
        `SELECT user_id, user_name FROM audit_logs WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [PENDING],
      );
      expect(rows[0]).toEqual({ user_id: await userId(OPS), user_name: NAMES[OPS] });
    });

    it('lets ADMIN change status, acting as its inactive roster record (D1)', async () => {
      const res = await request(app)
        .put(`/api/ops-portal/requests/${PENDING}/status`)
        .set(await headers(ADMIN, 'ADMIN'))
        .send({ status: 'Pending Review', expectedUpdatedAt: await freshUpdatedAt(PENDING) });
      expect(res.status).toBe(200);
      const { rows } = await pool.query(
        `SELECT user_id FROM audit_logs WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [PENDING],
      );
      expect(rows[0].user_id).toBe(await userId(ADMIN));
    });
  });

  describe('AC-26 — advisors resubmit only their own requests', () => {
    it("leaves another person's Needs Info request unchanged", async () => {
      const before = await requestRow(NEEDS_INFO);
      const res = await request(app)
        .put(`/api/ops-portal/requests/${NEEDS_INFO}`)
        .set(await headers(ADVISOR_A, 'ADVISOR'))
        .send({
          clientId: CLIENT,
          clientName: 'Synthetic Client',
          tradeType: 'Liquidate',
          selectedAccounts: ['TRW01-ACCT-1'],
          priority: 'Standard',
          liquidateOption: 'Entire Account',
          advisorNotes: 'hijacked',
          expectedUpdatedAt: new Date(before.updated_at).toISOString(),
        });
      expect(res.status).toBe(403);
      expect(await requestRow(NEEDS_INFO)).toEqual(before);
    });
  });

  describe('AC-27 — a role change applies to the next request', () => {
    it('refuses then admits the same person as their Ops Portal role changes', async () => {
      const first = await request(app)
        .put(`/api/ops-portal/requests/${PENDING}/status`)
        .set(await headers(ADVISOR_A, 'ADVISOR'))
        .send({ status: 'Needs Info', expectedUpdatedAt: await freshUpdatedAt(PENDING) });
      expect(first.status).toBe(403);

      const next = await request(app)
        .put(`/api/ops-portal/requests/${PENDING}/status`)
        .set(await headers(ADVISOR_A, 'OPERATIONS'))
        .send({ status: 'Needs Info', expectedUpdatedAt: await freshUpdatedAt(PENDING) });
      expect(next.status).toBe(200);

      const demoted = await request(app)
        .get('/api/ops-portal/requests')
        .set(await headers(ADVISOR_A, 'VIEWER'));
      expect(demoted.status).toBe(403);
    });
  });

  describe('AC-67 — CLIENT_SERVICE and VIEWER are refused with no data', () => {
    for (const role of ['CLIENT_SERVICE', 'VIEWER']) {
      for (const path of ['/requests', '/requests/counts', `/requests/${PENDING}`, '/notifications']) {
        it(`refuses ${role} on GET ${path}`, async () => {
          const res = await request(app)
            .get(`/api/ops-portal${path}`)
            .set(await headers(ADVISOR_B, role));
          expect(res.status).toBe(403);
          expect(Object.keys(res.body).sort()).toEqual(['code', 'error', 'requestId']);
          expect(res.body.code).toBe('role_not_permitted');
        });
      }

      it(`leaves the request unchanged when ${role} changes its status`, async () => {
        const before = await requestRow(PENDING);
        const res = await request(app)
          .put(`/api/ops-portal/requests/${PENDING}/status`)
          .set(await headers(ADVISOR_B, role))
          .send({ status: 'Rejected', expectedUpdatedAt: new Date(before.updated_at).toISOString() });
        expect(res.status).toBe(403);
        expect(await requestRow(PENDING)).toEqual(before);
      });
    }
  });

  describe('AC-68 — an unconfirmed person or role gets no read or write', () => {
    const now = () => Math.floor(Date.now() / 1000);
    const cases: Array<[string, () => Promise<Record<string, string>>]> = [
      ['no actor assertion', async () => ({ Authorization: `Bearer ${await callerToken()}` })],
      ['an expired assertion', () => headers(OPS, 'OPERATIONS', { iat: now() - 600, exp: now() - 120 })],
      ['an assertion for another audience', () => headers(OPS, 'OPERATIONS', { audience: 'http://elsewhere/api/ops-portal' })],
      ['an assertion from another issuer', () => headers(OPS, 'OPERATIONS', { issuer: 'someone@else.invalid' })],
      [
        'an assertion re-signed with a foreign key',
        () => headers(OPS, 'OPERATIONS', { key: new TextEncoder().encode('not-the-key') }),
      ],
      ['an unknown role', () => headers(OPS, 'SUPERUSER')],
    ];

    for (const [label, makeHeaders] of cases) {
      it(`refuses a read with ${label}`, async () => {
        const res = await request(app)
          .get('/api/ops-portal/requests')
          .set(await makeHeaders());
        expect(res.status).toBe(401);
        expect(res.body.data).toBeUndefined();
        expect(['person_unconfirmed', 'role_unconfirmed']).toContain(res.body.code);
      });

      it(`leaves the request unchanged on a write with ${label}`, async () => {
        const before = await requestRow(PENDING);
        const res = await request(app)
          .put(`/api/ops-portal/requests/${PENDING}/status`)
          .set(await makeHeaders())
          .send({ status: 'Rejected', expectedUpdatedAt: new Date(before.updated_at).toISOString() });
        expect(res.status).toBe(401);
        expect(await requestRow(PENDING)).toEqual(before);
      });
    }

    it('refuses a call without the application identity', async () => {
      const res = await request(app)
        .get('/api/ops-portal/requests')
        .set({ 'X-OPS-PORTAL-Actor-Assertion': await actorAssertion(OPS, 'OPERATIONS') });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('caller_unauthenticated');
    });
  });

  describe('surface scope (ruling D4, contract item 7)', () => {
    it.each([
      ['post', `/requests/${PENDING}/run-engine`],
      ['post', `/requests/${PENDING}/RUN-ENGINE/`],
      ['get', `/requests/${PENDING}/classified-holdings`],
      ['get', `/requests/${PENDING}/household-holdings`],
      ['get', `/Requests/${PENDING}/Classified-Holdings`],
      ['get', '/users'],
      ['get', '/drift'],
      ['delete', `/requests/${PENDING}`],
    ])('returns 404 for %s %s', async (method, path) => {
      const agent = request(app) as unknown as Record<string, (p: string) => request.Test>;
      const res = await agent[method](`/api/ops-portal${path}`).set(await headers(OPS, 'OPERATIONS'));
      expect(res.status).toBe(404);
    });

    it('refuses an unlisted operation before resolving or provisioning an actor', async () => {
      const stranger = 'trw01.stranger@example.com';
      const res = await request(app)
        .post(`/api/ops-portal/requests/${PENDING}/run-engine`)
        .set(await headers(stranger, 'OPERATIONS'));
      expect(res.status).toBe(404);
      expect(await userId(stranger)).toBeUndefined();
    });

    it('serves the firm-wide queue to an ADVISOR (D2)', async () => {
      const res = await request(app)
        .get('/api/ops-portal/requests')
        .set(await headers(ADVISOR_A, 'ADVISOR'));
      expect(res.status).toBe(200);
      const ids = (res.body.data as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining([PENDING, NEEDS_INFO]));
    });
  });

  describe('person identity', () => {
    it('records an Ops Portal person without a roster record as an inactive shadow actor, once', async () => {
      for (let i = 0; i < 2; i++) {
        const res = await request(app)
          .get('/api/ops-portal/notifications')
          .set(await headers(NEWCOMER, 'ADVISOR'));
        expect(res.status).toBe(200);
      }
      const { rows } = await pool.query(
        `SELECT name, role, is_active, ops_portal_provisioned_at IS NOT NULL AS shadow FROM users WHERE email = $1`,
        [NEWCOMER],
      );
      expect(rows).toEqual([{ name: NAMES[NEWCOMER], role: 'advisor', is_active: false, shadow: true }]);
    });

    it('matches an existing roster record regardless of letter case', async () => {
      await request(app)
        .get('/api/ops-portal/notifications')
        .set(await headers(ADVISOR_B, 'ADVISOR'));
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [ADVISOR_B]);
      expect(rows[0].n).toBe(1);
    });
  });

  describe('logging (contract item 8)', () => {
    it('never logs a person, a name or token contents', () => {
      expect(loggedCalls.length).toBeGreaterThan(0);
      const logged = JSON.stringify(loggedCalls);
      const secrets = [...Object.keys(NAMES), ...Object.values(NAMES), ...issuedTokens.map((t) => t.slice(-24))];
      for (const secret of secrets) expect(logged).not.toContain(secret);
    });
  });
});
