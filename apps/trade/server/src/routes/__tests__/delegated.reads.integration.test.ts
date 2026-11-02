// Direct-service contract tests for reads through the advisor platform delegated surface
// (/api/ops-portal), against a real Postgres with migrations applied: the firm-wide
// queue, search and Load more (epic AC-4, AC-5, AC-28), the export-scale list,
// counts, detail, checklist, pickers, standing-exclusion reads, the
// prior-allocation rule, and the person's own notifications with mark-one and
// mark-all read (AC-62, AC-63).
//
// Other integration files write to the same database in parallel, so firm-wide
// assertions use date windows only this file writes to, or properties that
// concurrent inserts cannot break. Requires a scratch or CI database (no seed
// data older than 2001-01-02). Synthetic data only; rows use a TRW03- / trw03.
// prefix and are removed afterwards.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';
import { CHECKLIST_ITEM_KEYS } from '@trade-request/shared';

vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY = 'trw03-contract-local-key';
  process.env.OPS_PORTAL_DELEGATED_AUDIENCE = 'http://trade-request.test/api/ops-portal';
  process.env.OPS_PORTAL_DELEGATED_CALLER_SA = 'ops-portal-local@delegated.invalid';
});

vi.mock('../../lib/logger.js', () => {
  const logger: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  logger.child = () => logger;
  return { default: logger };
});

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
  isConfigured: vi.fn(() => false),
  getCachedClients: vi.fn(),
}));
vi.mock('../../services/householdConfigCache.js', () => ({
  loadHouseholdConfigCached: vi.fn(),
}));

import * as warehouse from '../../services/warehouse.js';
import { loadHouseholdConfigCached } from '../../services/householdConfigCache.js';
import { ActiveAccountsLoadError } from '../../services/meridianActiveAccounts.js';

const DATABASE_URL = process.env.DATABASE_URL;
const KEY = new TextEncoder().encode(process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY);
const AUDIENCE = process.env.OPS_PORTAL_DELEGATED_AUDIENCE!;
const CALLER = 'ops-portal-local@delegated.invalid';

const DOMAIN = 'example.com';
const ADMIN = `trw03.admin@${DOMAIN}`;
const OPS = `trw03.ops@${DOMAIN}`;
const ADVISOR_A = `trw03.advisor.a@${DOMAIN}`;
const ADVISOR_B = `trw03.advisor.b@${DOMAIN}`;
const ADVISOR_C = `trw03.advisor.c@${DOMAIN}`;
const SEARCHER = `trw03.searcher@${DOMAIN}`;
const BELL_B = `trw03.bell.b@${DOMAIN}`;
const BELL_OWNER_STORED = `Trw03.Bell.A@${DOMAIN}`;
const BELL_OWNER = BELL_OWNER_STORED.toLowerCase();
const NEWCOMER = `trw03.newcomer@${DOMAIN}`;

const ROLES = ['ADMIN', 'OPERATIONS', 'ADVISOR'] as const;
type WorkspaceRole = (typeof ROLES)[number];
const PERSON_FOR_ROLE: Record<WorkspaceRole, string> = { ADMIN, OPERATIONS: OPS, ADVISOR: ADVISOR_A };

const TOP_SET = [
  'TRW03-QID-ZK7',
  'TRW03-SRCH-NAME',
  'TRW03-SRCH-CID',
  'TRW03-SRCH-STATUS',
  'TRW03-SRCH-TYPE',
  'TRW03-SRCH-SUB',
  'TRW03-SRCH-CONTROL',
];
const anc = (i: number) => `TRW03-ANC-${String(i).padStart(2, '0')}`;
const pgId = (i: number) => `TRW03-PG-${String(i).padStart(2, '0')}`;
const ANCHOR_BEFORE = '2001-01-02T00:00:00.000Z';
const HH_ULID = '01SYNTHD626TENH0RCAKD05631';

interface ListRow {
  id: string;
  date: string;
  clientName: string;
  clientNames: string[];
  clientIds: string[];
  tradeType: string;
  status: string;
  submittedBy: string;
}
interface NotificationRow {
  id: string;
  message: string;
  isRead: boolean;
  date: string;
}

async function callerToken() {
  return new SignJWT({ email: CALLER })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(CALLER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(KEY);
}

async function headers(email: string, role: string) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ ops_portal_role: role, name: 'Synthetic Person' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(CALLER)
    .setSubject(email)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(randomUUID())
    .sign(KEY);
  return { Authorization: `Bearer ${await callerToken()}`, 'X-OPS-PORTAL-Actor-Assertion': assertion };
}

const mine = <T extends { id: string }>(rows: T[]) => rows.filter((r) => r.id.startsWith('TRW03-'));

function matchesTerm(row: ListRow, term: string): boolean {
  const t = term.toLowerCase();
  const fields = [
    row.id,
    row.clientName,
    ...row.clientNames,
    ...row.clientIds,
    row.tradeType,
    row.status,
    row.submittedBy,
  ];
  return fields.some((f) => (f ?? '').toLowerCase().includes(t));
}

// Dates are compared across every row (millisecond truncation cannot reverse an
// order); the id tie-break only across this file's rows, whose timestamps are
// written at millisecond precision.
function assertNewestFirst(rows: ListRow[]) {
  for (let i = 1; i < rows.length; i++) {
    expect(Date.parse(rows[i].date)).toBeLessThanOrEqual(Date.parse(rows[i - 1].date));
  }
  const own = mine(rows);
  for (let i = 1; i < own.length; i++) {
    const prev = Date.parse(own[i - 1].date);
    const cur = Date.parse(own[i].date);
    expect(cur < prev || (cur === prev && own[i].id < own[i - 1].id)).toBe(true);
  }
}

describe.skipIf(!DATABASE_URL)('OPS_PORTAL delegated reads — queue, pickers, rules and notifications (Postgres)', () => {
  let pool: pg.Pool;
  let app: express.Express;
  const ids: Record<string, string> = {};
  const ownerNotes: Record<number, string> = {};
  const bNotes: Record<number, string> = {};

  async function api(method: 'get' | 'post' | 'patch', path: string, email: string, role: string, body?: object) {
    const client = request(app);
    const agent = client[method](`/api/ops-portal${path}`).set(await headers(email, role));
    return body ? agent.send(body) : agent;
  }

  async function asEachRole(method: 'get' | 'post', path: string, body?: object) {
    const out: Record<WorkspaceRole, request.Response> = {} as Record<WorkspaceRole, request.Response>;
    for (const role of ROLES) out[role] = await api(method, path, PERSON_FOR_ROLE[role], role, body);
    return out;
  }

  async function insertRequest(r: {
    id: string;
    clientId?: string;
    clientName?: string;
    clientIds?: string[];
    clientNames?: string[];
    advisor?: string;
    tradeType?: string;
    status?: string;
    createdAt: string;
    updatedAt?: string;
    riskProfile?: number;
    baseAllocation?: object;
    equityStrategies?: object[];
    checklist?: object;
  }) {
    const clientId = r.clientId ?? `${r.id}-C`;
    const clientName = r.clientName ?? 'Synthetic Client';
    await pool.query(
      `INSERT INTO trade_requests
         (id, client_id, client_name, client_ids, client_names, advisor_id, trade_type, status, priority,
          risk_profile, base_allocation, equity_strategies, preapproval_checklist, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Standard', $9, $10, $11, $12, $13, $14)`,
      [
        r.id,
        clientId,
        clientName,
        JSON.stringify(r.clientIds ?? [clientId]),
        JSON.stringify(r.clientNames ?? [clientName]),
        ids[r.advisor ?? ADVISOR_A],
        r.tradeType ?? 'Liquidate',
        r.status ?? 'Pending Review',
        r.riskProfile ?? null,
        r.baseAllocation ? JSON.stringify(r.baseAllocation) : null,
        r.equityStrategies ? JSON.stringify(r.equityStrategies) : null,
        r.checklist ? JSON.stringify(r.checklist) : null,
        r.createdAt,
        r.updatedAt ?? r.createdAt,
      ],
    );
  }

  async function cleanup() {
    await pool.query(
      `DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE lower(email) LIKE 'trw03.%')`,
    );
    await pool.query(`DELETE FROM client_exclusions WHERE client_id LIKE 'TRW03-%'`);
    await pool.query(`DELETE FROM account_exclusions WHERE account_id LIKE 'TRW03-%'`);
    await pool.query(
      `DELETE FROM trade_requests
        WHERE id LIKE 'TRW03-%' OR advisor_id IN (SELECT id FROM users WHERE lower(email) LIKE 'trw03.%')`,
    );
    await pool.query(`DELETE FROM accounts WHERE client_id LIKE 'TRW03-%'`);
    await pool.query(`DELETE FROM clients WHERE id LIKE 'TRW03-%'`);
    await pool.query(`DELETE FROM users WHERE lower(email) LIKE 'trw03.%'`);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await cleanup();

    const people: Array<[string, string]> = [
      [ADMIN, 'Ada Trw03'],
      [OPS, 'Orin Trw03'],
      [ADVISOR_A, 'Avery Trw03'],
      [ADVISOR_B, 'Blake Trw03'],
      [ADVISOR_C, 'Cass Trw03'],
      [SEARCHER, 'Marlowe Searchwell'],
      [BELL_B, 'Bree Trw03'],
      [BELL_OWNER_STORED, 'Bell Owner'],
    ];
    for (const [email, name] of people) {
      const { rows } = await pool.query(
        `INSERT INTO users (email, name, role, is_active) VALUES ($1, $2, 'advisor', true) RETURNING id`,
        [email, name],
      );
      ids[email] = rows[0].id;
    }
    ids[BELL_OWNER] = ids[BELL_OWNER_STORED];

    // Top set: the newest requests in the database.
    const top = (ms: number) => `2099-01-01T00:00:00.00${ms}Z`;
    await insertRequest({ id: 'TRW03-QID-ZK7', createdAt: top(7) });
    await insertRequest({
      id: 'TRW03-SRCH-NAME',
      clientName: 'Primary Zephyr',
      clientNames: ['Primary Zephyr', 'Secondary Quillon'],
      clientIds: ['TRW03-NAME-C1', 'TRW03-NAME-C2'],
      createdAt: top(6),
    });
    await insertRequest({ id: 'TRW03-SRCH-CID', clientIds: ['TRW03-CID-A', 'TRW03-CID-XRAY'], createdAt: top(5) });
    await insertRequest({ id: 'TRW03-SRCH-STATUS', status: 'Pending Current Asset Liquidation', createdAt: top(4) });
    await insertRequest({
      id: 'TRW03-SRCH-TYPE',
      tradeType: 'Cash Deposit',
      clientName: 'Typewell Synthetic',
      createdAt: top(3),
    });
    await insertRequest({ id: 'TRW03-SRCH-SUB', advisor: SEARCHER, createdAt: top(3) });
    await insertRequest({ id: 'TRW03-SRCH-CONTROL', clientName: 'Control Synthetic', createdAt: top(1) });

    // Anchor set: the only requests before 2001-01-02; ANC-59 and ANC-60 share a timestamp.
    for (let i = 1; i <= 60; i++) {
      const second = i === 60 ? 59 : i;
      await insertRequest({ id: anc(i), createdAt: new Date(Date.UTC(2001, 0, 1, 0, 0, second)).toISOString() });
    }
    for (let i = 1; i <= 55; i++) {
      await insertRequest({
        id: pgId(i),
        clientName: 'Pagewell Synthetic',
        createdAt: new Date(Date.UTC(2001, 5, 1, 0, 0, i)).toISOString(),
      });
    }

    const at2003 = (month: number, day: number, second: number) =>
      new Date(Date.UTC(2003, month, day, 0, 0, second)).toISOString();
    const cnt: Array<[string, string]> = [
      ['TRW03-CNT-P1', 'Pending Review'],
      ['TRW03-CNT-P2', 'Pending Review'],
      ['TRW03-CNT-N1', 'Needs Info'],
      ['TRW03-CNT-A1', 'Approved'],
      ['TRW03-CNT-C1', 'Completed'],
    ];
    for (const [i, [id, status]] of cnt.entries()) {
      await insertRequest({ id, clientId: 'TRW03-CNT-1', status, createdAt: at2003(1, 1, i) });
    }

    await insertRequest({
      id: 'TRW03-PA-OLD',
      clientId: 'TRW03-PA-1',
      tradeType: 'Rebalance',
      status: 'Approved',
      riskProfile: 12,
      baseAllocation: { equity: 60, fixed: 38, cash: 2 },
      equityStrategies: [{ id: 1, benchmark: 'IWM', allocation: 100, rationale: 'old' }],
      advisor: ADVISOR_A,
      createdAt: at2003(0, 1, 1),
      updatedAt: at2003(0, 1, 1),
    });
    await insertRequest({
      id: 'TRW03-PA-NEW',
      clientId: 'TRW03-PA-1',
      tradeType: 'Initial Funding',
      status: 'Completed',
      riskProfile: 15,
      baseAllocation: { equity: 80, fixed: 18, cash: 2 },
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: 'synthetic' }],
      advisor: ADVISOR_B,
      createdAt: at2003(0, 1, 2),
      updatedAt: at2003(0, 2, 0),
    });
    await insertRequest({
      id: 'TRW03-PA-DRAFT',
      clientId: 'TRW03-PA-1',
      tradeType: 'Rebalance',
      riskProfile: 20,
      advisor: ADVISOR_B,
      createdAt: at2003(0, 1, 3),
      updatedAt: at2003(0, 5, 0),
    });
    await insertRequest({ id: 'TRW03-PA-NONE-R', clientId: 'TRW03-PA-NONE', createdAt: at2003(0, 4, 0) });

    await insertRequest({
      id: 'TRW03-DETAIL',
      createdAt: at2003(0, 3, 0),
      checklist: {
        [CHECKLIST_ITEM_KEYS[0]]: { checked: true, value: '', by: 'Orin Trw03', at: '2003-01-01T00:00:00.000Z' },
      },
    });
    await pool.query(
      `INSERT INTO audit_logs (request_id, user_name, user_id, action, notes, channel, created_at) VALUES
         ('TRW03-DETAIL', 'Avery Trw03', $1, 'Created Request', 'synthetic', 'standalone', '2003-01-03T00:00:01Z'),
         ('TRW03-DETAIL', 'Orin Trw03', $2, 'Status changed to Needs Info', 'synthetic', 'opsPortal', '2003-01-03T00:00:02Z')`,
      [ids[ADVISOR_A], ids[OPS]],
    );

    await pool.query(`INSERT INTO clients (id, name) VALUES ('TRW03-CL-1', 'Clientwell Synthetic')`);
    await pool.query(
      `INSERT INTO accounts (client_id, account_number, account_type, balance) VALUES
         ('TRW03-CL-1', 'TRW03-ACCT-1', 'Taxable', 1000), ('TRW03-CL-1', 'TRW03-ACCT-2', 'Taxable', 2000)`,
    );

    for (let i = 1; i <= 105; i++) {
      const { rows } = await pool.query(
        `INSERT INTO notifications (user_id, body, created_at) VALUES ($1, $2, $3) RETURNING id`,
        [ids[BELL_OWNER], `TRW03 owner note ${i}`, new Date(Date.UTC(2001, 0, 1, 0, i)).toISOString()],
      );
      ownerNotes[i] = rows[0].id;
    }
    for (let i = 1; i <= 3; i++) {
      const { rows } = await pool.query(
        `INSERT INTO notifications (user_id, body, created_at) VALUES ($1, $2, $3) RETURNING id`,
        [ids[BELL_B], `TRW03 B note ${i}`, new Date(Date.UTC(2001, 0, 2, 0, 0, i)).toISOString()],
      );
      bNotes[i] = rows[0].id;
    }

    const { requireDelegatedCaller } = await import('../../middleware/delegatedAuth.js');
    const { default: delegatedRoutes, requireDelegatedOperation } = await import('../delegated.js');
    const { errorHandler } = await import('../../middleware/errorHandler.js');
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.requestId = 'contract-test';
      next();
    });
    app.use('/api/ops-portal', requireDelegatedOperation, requireDelegatedCaller, delegatedRoutes);
    app.use(errorHandler);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  describe('AC-4 firm-wide queue', () => {
    it.each(ROLES)('lists the 50 newest requests in the firm, newest first, for %s', async (role) => {
      const res = await api('get', '/requests', PERSON_FOR_ROLE[role], role);
      expect(res.status).toBe(200);
      const data = res.body.data as ListRow[];
      expect(data).toHaveLength(50);
      assertNewestFirst(data);
      expect(data.slice(0, 7).map((r) => r.id)).toEqual(TOP_SET);
      expect(res.body.nextCursor).toEqual(expect.any(String));
    });

    it('returns the same page to ADMIN, OPERATIONS and ADVISOR', async () => {
      const byRole = await asEachRole('get', `/requests?before=${ANCHOR_BEFORE}`);
      expect(byRole.OPERATIONS.body).toEqual(byRole.ADMIN.body);
      expect(byRole.ADVISOR.body).toEqual(byRole.ADMIN.body);
      const expected = [anc(60), anc(59), ...Array.from({ length: 48 }, (_, k) => anc(58 - k))];
      expect((byRole.ADMIN.body.data as ListRow[]).map((r) => r.id)).toEqual(expected);
      expect(byRole.ADMIN.body.nextCursor).toBe(`2001-01-01T00:00:11.000Z|${anc(11)}`);
    });
  });

  describe('AC-28 load more', () => {
    it('appends the next older page without overlap and ends the list', async () => {
      for (const role of ROLES) {
        const first = await api('get', `/requests?before=${ANCHOR_BEFORE}`, PERSON_FOR_ROLE[role], role);
        const next = await api(
          'get',
          `/requests?before=${encodeURIComponent(first.body.nextCursor)}`,
          PERSON_FOR_ROLE[role],
          role,
        );
        expect(next.status).toBe(200);
        const ids2 = (next.body.data as ListRow[]).map((r) => r.id);
        expect(ids2).toEqual(Array.from({ length: 10 }, (_, k) => anc(10 - k)));
        expect(next.body.nextCursor).toBeNull();
        const ids1 = new Set((first.body.data as ListRow[]).map((r) => r.id));
        expect(ids2.filter((id) => ids1.has(id))).toEqual([]);
      }
    });

    it('pages through a search 50 at a time', async () => {
      for (const role of ROLES) {
        const first = await api('get', '/requests?q=pagewell', PERSON_FOR_ROLE[role], role);
        const page1 = first.body.data as ListRow[];
        expect(page1).toHaveLength(50);
        expect(page1.every((r) => r.id.startsWith('TRW03-PG-'))).toBe(true);
        expect(first.body.nextCursor).toEqual(expect.any(String));

        const second = await api(
          'get',
          `/requests?q=pagewell&before=${encodeURIComponent(first.body.nextCursor)}`,
          PERSON_FOR_ROLE[role],
          role,
        );
        const page2 = second.body.data as ListRow[];
        expect(page2).toHaveLength(5);
        expect(second.body.nextCursor).toBeNull();
        const all = [...page1, ...page2].map((r) => r.id);
        expect(new Set(all).size).toBe(55);
        expect([...all].sort()).toEqual(Array.from({ length: 55 }, (_, k) => pgId(k + 1)));
        const lastOfFirst = Date.parse(page1[49].date);
        expect(page2.every((r) => Date.parse(r.date) < lastOfFirst)).toBe(true);
      }
    });
  });

  describe('AC-5 search', () => {
    async function searchEachRole(term: string) {
      const results: ListRow[][] = [];
      for (const role of ROLES) {
        const res = await api('get', `/requests?q=${encodeURIComponent(term)}`, PERSON_FOR_ROLE[role], role);
        expect(res.status).toBe(200);
        const data = res.body.data as ListRow[];
        for (const row of data) expect(matchesTerm(row, term)).toBe(true);
        expect(data.map((r) => r.id)).not.toContain('TRW03-SRCH-CONTROL');
        results.push(data);
      }
      expect(mine(results[1])).toEqual(mine(results[0]));
      expect(mine(results[2])).toEqual(mine(results[0]));
      return results[0].map((r) => r.id);
    }

    it('matches the request ID', async () => {
      expect(await searchEachRole('qid-zk7')).toContain('TRW03-QID-ZK7');
    });

    it('matches any client name, ignoring letter case', async () => {
      expect(await searchEachRole('QUILLON')).toContain('TRW03-SRCH-NAME');
    });

    it('matches any client identifier', async () => {
      expect(await searchEachRole('cid-xray')).toContain('TRW03-SRCH-CID');
    });

    it('matches the stored status, not its display label', async () => {
      expect(await searchEachRole('pending current asset')).toContain('TRW03-SRCH-STATUS');
      expect(await searchEachRole('Pending Liquidation')).not.toContain('TRW03-SRCH-STATUS');
    });

    it('matches the stored trade type', async () => {
      expect(await searchEachRole('cash dep')).toContain('TRW03-SRCH-TYPE');
    });

    it('matches the submitter name', async () => {
      expect(await searchEachRole('SearchWell')).toContain('TRW03-SRCH-SUB');
    });

    it('returns identical results to every workspace role', async () => {
      const byRole = await asEachRole('get', '/requests?q=zephyr');
      for (const role of ROLES) {
        expect(mine(byRole[role].body.data as ListRow[]).map((r) => r.id)).toEqual(['TRW03-SRCH-NAME']);
      }
    });
  });

  describe('export-scale list', () => {
    it('returns every request newest first without truncation when under 5,000', async () => {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM trade_requests');
      expect(rows[0].n).toBeLessThanOrEqual(5000);
      const byRole = await asEachRole('get', '/requests?all=true');
      for (const role of ROLES) {
        const data = byRole[role].body.data as ListRow[];
        expect(byRole[role].body.truncated).toBe(false);
        assertNewestFirst(data);
        expect(data.slice(0, 7).map((r) => r.id)).toEqual(TOP_SET);
        const got = new Set(data.map((r) => r.id));
        for (let i = 1; i <= 60; i++) expect(got.has(anc(i))).toBe(true);
      }
    });

    it('caps the list at 5,000 and signals truncation', async () => {
      await pool.query(
        `INSERT INTO trade_requests (id, client_id, client_ids, advisor_id, trade_type, status, created_at, updated_at)
           SELECT 'TRW03-EXP-' || lpad(n::text, 4, '0'), 'TRW03-EXPC', '["TRW03-EXPC"]'::jsonb, $1, 'Liquidate',
                  'Pending Review', '2002-01-01T00:00:00Z'::timestamptz + n * interval '1 millisecond',
                  '2002-01-01T00:00:00Z'::timestamptz + n * interval '1 millisecond'
             FROM generate_series(1, 5001) AS n`,
        [ids[ADVISOR_A]],
      );
      try {
        const byRole = await asEachRole('get', '/requests?all=true');
        for (const role of ROLES) {
          const data = byRole[role].body.data as ListRow[];
          expect(byRole[role].body.truncated).toBe(true);
          expect(data).toHaveLength(5000);
          assertNewestFirst(data);
          expect(data.slice(0, 7).map((r) => r.id)).toEqual(TOP_SET);
        }
      } finally {
        await pool.query(`DELETE FROM trade_requests WHERE id LIKE 'TRW03-EXP-%'`);
      }
    }, 30000);

    it('refuses a search combined with export mode', async () => {
      const res = await api('get', '/requests?all=true&q=x', OPS, 'OPERATIONS');
      expect(res.status).toBe(400);
    });
  });

  describe('counts', () => {
    it('counts firm-wide, Approved / Done including Completed, identically for every role', async () => {
      const before = (await api('get', '/requests/counts', ADMIN, 'ADMIN')).body;
      await insertRequest({
        id: 'TRW03-CNT-C2',
        clientId: 'TRW03-CNT-1',
        status: 'Completed',
        createdAt: '2003-02-01T00:00:10.000Z',
      });
      await insertRequest({
        id: 'TRW03-CNT-C3',
        clientId: 'TRW03-CNT-1',
        status: 'Completed',
        createdAt: '2003-02-01T00:00:11.000Z',
      });
      for (const [email, role] of [
        [OPS, 'OPERATIONS'],
        [ADVISOR_A, 'ADVISOR'],
      ] as const) {
        const res = await api('get', '/requests/counts', email, role);
        expect(res.status).toBe(200);
        const c = res.body as { total: number; pendingReview: number; needsInfo: number; approved: number };
        expect(c.approved - before.approved).toBe(2);
        expect(c.pendingReview).toBeGreaterThanOrEqual(3);
        expect(c.needsInfo).toBeGreaterThanOrEqual(1);
        expect(c.approved).toBeGreaterThanOrEqual(3);
        expect(c.total).toBeGreaterThanOrEqual(c.pendingReview + c.needsInfo + c.approved);
      }
    });
  });

  describe('detail and checklist', () => {
    it('returns the same detail, with audit channels, to every role', async () => {
      const byRole = await asEachRole('get', '/requests/TRW03-DETAIL');
      expect(byRole.ADMIN.status).toBe(200);
      expect(byRole.OPERATIONS.body).toEqual(byRole.ADMIN.body);
      expect(byRole.ADVISOR.body).toEqual(byRole.ADMIN.body);
      expect((byRole.ADMIN.body.data.auditLog as Array<{ channel: string }>).map((e) => e.channel)).toEqual([
        'opsPortal',
        'standalone',
      ]);
    });

    it('returns the same checklist to every role', async () => {
      const byRole = await asEachRole('get', '/requests/TRW03-DETAIL/checklist');
      for (const role of ROLES) {
        expect(byRole[role].status).toBe(200);
        expect(byRole[role].body).toEqual({
          checklist: {
            [CHECKLIST_ITEM_KEYS[0]]: { checked: true, value: '', by: 'Orin Trw03', at: '2003-01-01T00:00:00.000Z' },
          },
        });
      }
    });

    it('returns 404 for a missing request and its checklist', async () => {
      expect((await api('get', '/requests/TRW03-NOPE', OPS, 'OPERATIONS')).status).toBe(404);
      expect((await api('get', '/requests/TRW03-NOPE/checklist', OPS, 'OPERATIONS')).status).toBe(404);
    });
  });

  describe('pickers', () => {
    it('lists clients with their accounts identically for every role', async () => {
      const byRole = await asEachRole('get', '/clients');
      for (const role of ROLES) {
        const clients = (
          byRole[role].body.data as Array<{ id: string; name: string; accounts: Array<{ accountNumber: string }> }>
        ).filter((c) => c.id.startsWith('TRW03-'));
        expect(
          clients.map((c) => ({ id: c.id, name: c.name, accounts: c.accounts.map((a) => a.accountNumber) })),
        ).toEqual([{ id: 'TRW03-CL-1', name: 'Clientwell Synthetic', accounts: ['TRW03-ACCT-1', 'TRW03-ACCT-2'] }]);
      }
      expect(byRole.OPERATIONS.body.data.filter((c: { id: string }) => c.id.startsWith('TRW03-'))).toEqual(
        byRole.ADMIN.body.data.filter((c: { id: string }) => c.id.startsWith('TRW03-')),
      );
    });

    it('resolves a firm household identically for every role', async () => {
      vi.mocked(warehouse.isConfigured).mockReturnValue(true);
      vi.mocked(warehouse.getCachedClients).mockResolvedValue([
        {
          id: 'TRW03-HH-CLI',
          name: 'Household Synthetic',
          accounts: [
            {
              id: HH_ULID,
              clientId: 'TRW03-HH-CLI',
              accountNumber: 'TRW03-HH-ACCT',
              accountType: 'Taxable',
              balance: 1000,
              holdings: { cash: 0, fixed: 0, equity: 1000 },
            },
          ],
        },
      ]);
      vi.mocked(loadHouseholdConfigCached).mockResolvedValue({
        byAccountNumber: new Map([
          [HH_ULID, { accountNumber: HH_ULID, householdName: 'Trw03 Household', householdId: 9001 }],
        ]),
        householdNames: new Set(['Trw03 Household']),
        entries: [{ accountNumber: HH_ULID, householdName: 'Trw03 Household', householdId: 9001 }],
      });
      try {
        const byRole = await asEachRole('get', '/households/resolve?clientIds=TRW03-HH-CLI');
        expect(byRole.ADMIN.status).toBe(200);
        expect(byRole.OPERATIONS.body).toEqual(byRole.ADMIN.body);
        expect(byRole.ADVISOR.body).toEqual(byRole.ADMIN.body);
        expect(byRole.ADMIN.body.data.households[0]).toMatchObject({
          householdId: 9001,
          householdName: 'Trw03 Household',
        });
      } finally {
        vi.mocked(warehouse.isConfigured).mockReturnValue(false);
      }
    });

    it('returns household_data_unavailable when the household file cannot load', async () => {
      vi.mocked(warehouse.isConfigured).mockReturnValue(true);
      vi.mocked(loadHouseholdConfigCached).mockRejectedValue(new ActiveAccountsLoadError('synthetic outage', 'gcs'));
      try {
        const res = await api('get', '/households/resolve?clientIds=TRW03-HH-CLI', ADVISOR_A, 'ADVISOR');
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('household_data_unavailable');
      } finally {
        vi.mocked(warehouse.isConfigured).mockReturnValue(false);
      }
    });
  });

  // exclusions.integration and account-exclusions.integration TRUNCATE these
  // tables between their tests; a run is retried only when that removed the seed.
  describe('standing exclusion reads', () => {
    async function seedExclusions() {
      await pool.query(`DELETE FROM client_exclusions WHERE client_id LIKE 'TRW03-%'`);
      await pool.query(`DELETE FROM account_exclusions WHERE account_id LIKE 'TRW03-%'`);
      await pool.query(
        `INSERT INTO client_exclusions (client_id, ticker, kind, reason, created_by_name) VALUES
           ('TRW03-CL-1', 'TRWX', 'advisor', 'synthetic', 'Avery Trw03'),
           ('TRW03-CL-1', 'TRWY', 'advisor', 'synthetic', 'Avery Trw03')`,
      );
      await pool.query(
        `INSERT INTO account_exclusions (account_id, ticker, kind, reason, created_by_name)
         VALUES ('TRW03-ULID-1', 'TRWZ', 'client', 'synthetic', 'Avery Trw03')`,
      );
    }

    async function seedIntact() {
      const { rows } = await pool.query(
        `SELECT (SELECT count(*) FROM client_exclusions WHERE client_id = 'TRW03-CL-1')
              + (SELECT count(*) FROM account_exclusions WHERE account_id = 'TRW03-ULID-1') AS n`,
      );
      return Number(rows[0].n) === 3;
    }

    async function withSeededExclusions(fn: () => Promise<void>) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        await seedExclusions();
        try {
          await fn();
          return;
        } catch (err) {
          if (await seedIntact()) throw err;
          lastError = err;
        }
      }
      throw lastError;
    }

    const tickers = (rows: Array<{ ticker: string }>) => rows.map((r) => r.ticker);

    it('reads one client', () =>
      withSeededExclusions(async () => {
        const byRole = await asEachRole('get', '/clients/TRW03-CL-1/exclusions');
        expect(byRole.OPERATIONS.body).toEqual(byRole.ADMIN.body);
        expect(byRole.ADVISOR.body).toEqual(byRole.ADMIN.body);
        expect(tickers(byRole.ADMIN.body.data)).toEqual(['TRWX', 'TRWY']);
      }));

    it('reads clients in bulk', () =>
      withSeededExclusions(async () => {
        const byRole = await asEachRole('post', '/clients/exclusions/bulk', {
          clientIds: ['TRW03-CL-1', 'TRW03-CL-EMPTY'],
        });
        expect(byRole.OPERATIONS.body).toEqual(byRole.ADMIN.body);
        expect(byRole.ADVISOR.body).toEqual(byRole.ADMIN.body);
        expect(tickers(byRole.ADMIN.body.data['TRW03-CL-1'])).toEqual(['TRWX', 'TRWY']);
        expect(byRole.ADMIN.body.data['TRW03-CL-EMPTY']).toEqual([]);
      }));

    it('reads accounts in bulk', () =>
      withSeededExclusions(async () => {
        const byRole = await asEachRole('post', '/clients/account-exclusions/bulk', { accountIds: ['TRW03-ULID-1'] });
        expect(byRole.OPERATIONS.body).toEqual(byRole.ADMIN.body);
        expect(byRole.ADVISOR.body).toEqual(byRole.ADMIN.body);
        expect(tickers(byRole.ADMIN.body.data['TRW03-ULID-1'])).toEqual(['TRWZ']);
      }));

    it('exports both scopes firm-wide', () =>
      withSeededExclusions(async () => {
        const byRole = await asEachRole('get', '/clients/exclusions/export');
        const own = (body: { data: Array<{ scope: string; clientId: string; accountId: string; ticker: string }> }) =>
          body.data
            .filter((r) => r.clientId.startsWith('TRW03-') || r.accountId.startsWith('TRW03-'))
            .map((r) => `${r.scope}:${r.ticker}`);
        expect(own(byRole.OPERATIONS.body)).toEqual(own(byRole.ADMIN.body));
        expect(own(byRole.ADVISOR.body)).toEqual(own(byRole.ADMIN.body));
        expect(own(byRole.ADMIN.body)).toEqual(['client:TRWX', 'client:TRWY', 'account:TRWZ']);
      }));
  });

  describe('prior allocation', () => {
    const expected = {
      riskProfile: 15,
      baseAllocation: { equity: 80, fixed: 18, cash: 2 },
      equityStrategies: [{ id: 1, benchmark: 'SPY', allocation: 100, rationale: 'synthetic' }],
    };

    it('gives a reviewer the newest eligible allocation for any client', async () => {
      for (const [email, role] of [
        [OPS, 'OPERATIONS'],
        [ADMIN, 'ADMIN'],
      ] as const) {
        const res = await api('get', '/requests/last-allocation/TRW03-PA-1', email, role);
        expect(res.status).toBe(200);
        expect(res.body).toEqual(expected);
      }
    });

    it('gives an ADVISOR the allocation for a client on a request they submitted', async () => {
      const res = await api('get', '/requests/last-allocation/TRW03-PA-1', ADVISOR_A, 'ADVISOR');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expected);
    });

    it('refuses an ADVISOR who has no request for the client', async () => {
      const res = await api('get', '/requests/last-allocation/TRW03-PA-1', ADVISOR_C, 'ADVISOR');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('You do not have access to this client');
    });

    it('returns null when the client has no eligible allocation', async () => {
      const res = await api('get', '/requests/last-allocation/TRW03-PA-NONE', OPS, 'OPERATIONS');
      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });
  });

  describe('AC-62 AC-63 notifications', () => {
    async function unread(email: string) {
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
        [ids[email]],
      );
      return rows[0].n as number;
    }
    const readAt = async (id: string) =>
      (await pool.query('SELECT read_at FROM notifications WHERE id = $1', [id])).rows[0].read_at as Date | null;

    it("lists the person's 50 newest notifications with the unread count", async () => {
      const res = await api('get', '/notifications', BELL_OWNER, 'ADVISOR');
      expect(res.status).toBe(200);
      const data = res.body.data as NotificationRow[];
      expect(data).toHaveLength(50);
      expect(data[0].message).toBe('TRW03 owner note 105');
      for (let i = 1; i < data.length; i++) expect(Date.parse(data[i].date)).toBeLessThan(Date.parse(data[i - 1].date));
      expect(res.body.unreadCount).toBe(105);
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM notifications WHERE id = ANY($1::uuid[]) AND user_id = $2',
        [data.map((n) => n.id), ids[BELL_OWNER]],
      );
      expect(rows[0].n).toBe(50);
    });

    it('lists up to 100, the same whatever the advisor platform role', async () => {
      const bodies = [];
      for (const role of ROLES) {
        const res = await api('get', '/notifications?limit=100', BELL_OWNER, role);
        expect(res.status).toBe(200);
        bodies.push(res.body);
      }
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect((bodies[0].data as NotificationRow[]).map((n) => n.message)).toEqual(
        Array.from({ length: 100 }, (_, k) => `TRW03 owner note ${105 - k}`),
      );
      expect(bodies[0].unreadCount).toBe(105);
    });

    it('refuses more than 100', async () => {
      expect((await api('get', '/notifications?limit=101', BELL_OWNER, 'ADVISOR')).status).toBe(400);
    });

    it('marks one selected notification read (AC-62)', async () => {
      const bBefore = await unread(BELL_B);
      const res = await api('patch', `/notifications/${ownerNotes[50]}/read`, BELL_OWNER, 'ADVISOR');
      expect(res.status).toBe(204);
      expect(await readAt(ownerNotes[50])).not.toBeNull();
      expect(await unread(BELL_OWNER)).toBe(104);
      expect(await unread(BELL_B)).toBe(bBefore);
    });

    it('accepts selecting an already-read notification again (AC-62)', async () => {
      expect((await api('patch', `/notifications/${ownerNotes[49]}/read`, BELL_OWNER, 'ADVISOR')).status).toBe(204);
      const first = await readAt(ownerNotes[49]);
      expect(first).not.toBeNull();
      expect((await api('patch', `/notifications/${ownerNotes[49]}/read`, BELL_OWNER, 'ADVISOR')).status).toBe(204);
      expect(await readAt(ownerNotes[49])).toEqual(first);
    });

    it("cannot mark another person's notification", async () => {
      const res = await api('patch', `/notifications/${bNotes[1]}/read`, BELL_OWNER, 'ADVISOR');
      expect(res.status).toBe(404);
      expect(await readAt(bNotes[1])).toBeNull();
    });

    it("marks every one of the person's notifications read and no one else's (AC-63)", async () => {
      const bBefore = await unread(BELL_B);
      expect((await api('post', '/notifications/read-all', BELL_OWNER, 'ADVISOR')).status).toBe(204);
      expect(await unread(BELL_OWNER)).toBe(0);
      expect((await api('get', '/notifications', BELL_OWNER, 'ADVISOR')).body.unreadCount).toBe(0);
      expect(await unread(BELL_B)).toBe(bBefore);
    });

    it('lists only the calling person’s notifications', async () => {
      const res = await api('get', '/notifications', BELL_B, 'ADVISOR');
      expect((res.body.data as NotificationRow[]).map((n) => n.message).sort()).toEqual([
        'TRW03 B note 1',
        'TRW03 B note 2',
        'TRW03 B note 3',
      ]);
    });

    it('shows a person without a roster record the notifications addressed to them', async () => {
      const first = await api('get', '/notifications', NEWCOMER, 'ADVISOR');
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual([]);
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1 AND ops_portal_provisioned_at IS NOT NULL', [
        NEWCOMER,
      ]);
      expect(rows).toHaveLength(1);
      await pool.query(
        `INSERT INTO notifications (user_id, body, created_at) VALUES ($1, 'TRW03 newcomer note', '2001-01-03T00:00:00Z')`,
        [rows[0].id],
      );
      const second = await api('get', '/notifications', NEWCOMER, 'ADVISOR');
      expect((second.body.data as NotificationRow[]).map((n) => n.message)).toEqual(['TRW03 newcomer note']);
    });
  });

  describe('refused roles on the remaining reads', () => {
    const operations: Array<[method: 'get' | 'post' | 'patch', path: string, body?: object]> = [
      ['get', '/clients'],
      ['get', '/households/resolve?clientIds=TRW03-CL-1'],
      ['get', '/clients/TRW03-CL-1/exclusions'],
      ['get', '/clients/exclusions/export'],
      ['post', '/clients/exclusions/bulk', { clientIds: ['TRW03-CL-1'] }],
      ['post', '/clients/account-exclusions/bulk', { accountIds: ['TRW03-ULID-1'] }],
      ['get', '/requests/TRW03-DETAIL/checklist'],
      ['get', '/requests/last-allocation/TRW03-PA-1'],
      ['patch', '/notifications/:ownerNote/read'],
      ['post', '/notifications/read-all'],
      ['get', '/requests?all=true'],
    ];
    const cases = ['CLIENT_SERVICE', 'VIEWER'].flatMap((role) =>
      operations.map(([method, path, body]) => ({ role, method, path, body })),
    );

    it.each(cases)('refuses $role on $method $path', async ({ role, method, path, body }) => {
      const res = await api(method, path.replace(':ownerNote', ownerNotes[1]), BELL_OWNER, role, body);
      expect(res.status).toBe(403);
      expect(Object.keys(res.body).sort()).toEqual(['code', 'error', 'requestId']);
      expect(res.body.code).toBe('role_not_permitted');
    });
  });
});
