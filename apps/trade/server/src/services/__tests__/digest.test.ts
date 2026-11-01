import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendChannelMessageMock, sendDirectMessageMock } = vi.hoisted(() => ({
  sendChannelMessageMock: vi.fn().mockResolvedValue(undefined),
  sendDirectMessageMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../slack.js', async () => {
  const actual = await vi.importActual<typeof import('../slack.js')>('../slack.js');
  return {
    ...actual,
    sendChannelMessage: sendChannelMessageMock,
    sendDirectMessage: sendDirectMessageMock,
  };
});

vi.mock('../../lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  computeRunDate,
  buildDailyDigest,
  sendDailyDigest,
  renderDigest,
  sendDigestToTarget,
  type DigestSummary,
  type OutstandingRequest,
} from '../digest.js';

interface QueryCall {
  sql: string;
  args?: unknown[];
}

interface OutstandingRowLike {
  id: string;
  status: string;
  trade_type: string;
  trade_amount: string | null;
  total_value: string | null;
  priority: string | null;
  created_at: string;
  liquidity_deadline: string | null;
  client_names: string[] | null;
  client_name: string | null;
  advisor_name: string | null;
  waiting_minutes: string;
}

function makePool(options: {
  rows?: OutstandingRowLike[];
  insertResults?: Array<{ rows: Array<{ run_date: string }> }>;
}) {
  const calls: QueryCall[] = [];
  let insertCallIdx = 0;

  return {
    calls,
    query: vi.fn(async (sql: string, args?: unknown[]) => {
      calls.push({ sql, args });
      if (sql.includes('FROM trade_requests tr')) {
        return { rows: options.rows ?? [] };
      }
      if (sql.includes('INSERT INTO digest_runs')) {
        const next = options.insertResults?.[insertCallIdx++];
        if (next) return next;
        return { rows: [{ run_date: String(args?.[0] ?? '') }] };
      }
      return { rows: [] };
    }),
  };
}

function row(overrides: Partial<OutstandingRowLike> = {}): OutstandingRowLike {
  return {
    id: 'TR-0001',
    status: 'Pending Review',
    trade_type: 'Rebalance',
    trade_amount: null,
    total_value: null,
    priority: 'Standard',
    created_at: '2026-04-20T12:00:00Z',
    liquidity_deadline: null,
    client_names: ['Acme Family'],
    client_name: 'Acme Family',
    advisor_name: 'Sarah Lee',
    waiting_minutes: '120',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CLIENT_ORIGIN;
});

describe('computeRunDate', () => {
  it('returns the calendar date in America/New_York', () => {
    expect(computeRunDate(new Date('2026-04-21T02:30:00Z'))).toBe('2026-04-20');
    expect(computeRunDate(new Date('2026-04-21T12:00:00Z'))).toBe('2026-04-21');
    expect(computeRunDate(new Date('2026-01-21T12:00:00Z'))).toBe('2026-01-21');
  });
});

function baseRequest(overrides: Partial<OutstandingRequest> = {}): OutstandingRequest {
  return {
    id: 'TR-0001',
    status: 'Pending Review',
    tradeType: 'Rebalance',
    tradeAmount: null,
    totalValue: 250_000,
    priority: 'Standard',
    createdAt: new Date('2026-04-19T12:00:00Z'),
    liquidityDeadline: null,
    clientNames: ['Jane Doe'],
    submittedByName: 'Sarah Lee',
    waitingMinutes: 180,
    ...overrides,
  };
}

describe('renderDigest', () => {
  const emptySummary: DigestSummary = {
    runDate: '2026-04-21',
    total: 0,
    urgent: 0,
    overdue48h: 0,
    oldestWaitingMinutes: null,
    byStatus: {},
  };

  it('renders "All clear" when there are no open requests', () => {
    const text = renderDigest(emptySummary, new Date('2026-04-21T12:00:00Z'));
    expect(text).toContain('All clear');
    expect(text).toMatch(/Open the queue/);
  });

  it('renders per-request detail grouped by status, urgent first then oldest first', () => {
    const text = renderDigest(
      {
        runDate: '2026-04-21',
        total: 3,
        urgent: 1,
        overdue48h: 1,
        oldestWaitingMinutes: 4320,
        byStatus: {
          'Pending Review': [
            baseRequest({ id: 'TR-0010', priority: 'Urgent', waitingMinutes: 4320, totalValue: 250_000 }),
            baseRequest({
              id: 'TR-0011',
              priority: 'Standard',
              waitingMinutes: 120,
              totalValue: null,
              tradeAmount: null,
              clientNames: ['Jane Doe', 'John Doe'],
            }),
          ],
          'Needs Info': [
            baseRequest({
              id: 'TR-0020',
              status: 'Needs Info',
              priority: 'Standard',
              waitingMinutes: 300,
              tradeType: 'Liquidate',
              totalValue: null,
            }),
          ],
        },
      },
      new Date('2026-04-21T12:00:00Z'),
    );

    expect(text).toContain('3 open requests');
    expect(text).toContain('1 urgent');
    expect(text).toContain('1 waiting > 48h');
    expect(text).toContain('oldest 3d');
    expect(text).toContain('*Pending Review (2)*');
    expect(text).toContain('*Needs Info (1)*');
    expect(text).toContain('TR-0010');
    expect(text).toContain('🚨 Urgent');
    // Slack-escape turns `&` into `&amp;` so the message safely renders.
    expect(text).toContain('Jane Doe &amp; John Doe');
    expect(text).toContain('$250k');

    // Urgent row must appear before the standard one in Pending Review.
    expect(text.indexOf('TR-0010')).toBeLessThan(text.indexOf('TR-0011'));
  });

  it('renders upcoming liquidity deadlines inline', () => {
    const text = renderDigest(
      {
        runDate: '2026-04-21',
        total: 1,
        urgent: 0,
        overdue48h: 0,
        oldestWaitingMinutes: 60,
        byStatus: {
          'Pending Review': [baseRequest({ id: 'TR-DDL', liquidityDeadline: '2026-04-25', waitingMinutes: 60 })],
        },
      },
      new Date('2026-04-21T12:00:00Z'),
    );
    expect(text).toContain('deadline Apr 25');
  });

  it('flags overdue deadlines', () => {
    const text = renderDigest(
      {
        runDate: '2026-04-21',
        total: 1,
        urgent: 0,
        overdue48h: 0,
        oldestWaitingMinutes: 60,
        byStatus: {
          'Pending Review': [baseRequest({ id: 'TR-OVD', liquidityDeadline: '2026-04-18', waitingMinutes: 60 })],
        },
      },
      new Date('2026-04-21T12:00:00Z'),
    );
    expect(text).toContain('deadline overdue');
  });

  it('caps per-request rows and summarises overflow', () => {
    const bucket: OutstandingRequest[] = [];
    for (let i = 1; i <= 13; i += 1) {
      bucket.push(
        baseRequest({
          id: `TR-${String(i).padStart(4, '0')}`,
          waitingMinutes: 300 - i,
        }),
      );
    }
    const text = renderDigest(
      {
        runDate: '2026-04-21',
        total: bucket.length,
        urgent: 0,
        overdue48h: 0,
        oldestWaitingMinutes: 299,
        byStatus: { 'Pending Review': bucket },
      },
      new Date('2026-04-21T12:00:00Z'),
    );
    expect(text).toContain('TR-0001');
    // 11th row should not be present (cap = 10).
    expect(text).not.toContain('TR-0011');
    expect(text).toContain('…and 3 more in this bucket');
    expect(text).toContain('Showing the 10 most pressing');
  });

  it('uses the first CLIENT_ORIGIN entry for links', () => {
    process.env.CLIENT_ORIGIN = 'https://trade.example.com,https://other.example.com';
    const text = renderDigest(emptySummary, new Date('2026-04-21T12:00:00Z'));
    expect(text).toContain('https://trade.example.com/queue');
    expect(text).not.toContain('https://other.example.com');
  });
});

describe('buildDailyDigest', () => {
  it('excludes approved and rejected, keeps everything else including completed', async () => {
    const pool = makePool({
      rows: [
        row({ id: 'TR-A', status: 'Pending Review', waiting_minutes: '120' }),
        row({ id: 'TR-B', status: 'Needs Info', waiting_minutes: '60' }),
        row({ id: 'TR-C', status: 'Pending Current Asset Liquidation', waiting_minutes: '30' }),
        row({ id: 'TR-D', status: 'Completed', waiting_minutes: '15' }),
      ],
    });

    const { summary } = await buildDailyDigest(
      pool as unknown as Parameters<typeof buildDailyDigest>[0],
      new Date('2026-04-21T12:00:00Z'),
    );

    expect(summary.total).toBe(4);
    expect(summary.byStatus['Pending Review']?.length).toBe(1);
    expect(summary.byStatus['Needs Info']?.length).toBe(1);
    expect(summary.byStatus['Pending Current Asset Liquidation']?.length).toBe(1);
    expect(summary.byStatus['Completed']?.length).toBe(1);

    const sqlCall = pool.calls.find((c) => c.sql.includes('FROM trade_requests tr'));
    expect(sqlCall).toBeDefined();
    expect(sqlCall?.args?.[0]).toEqual([
      'Pending Review',
      'Needs Info',
      'Pending Current Asset Liquidation',
      'Completed',
    ]);
  });

  it('sorts urgent before standard within a bucket', async () => {
    const pool = makePool({
      rows: [
        row({ id: 'TR-STD', priority: 'Standard', waiting_minutes: '3000' }),
        row({ id: 'TR-URG', priority: 'Urgent', waiting_minutes: '60' }),
      ],
    });

    const { summary } = await buildDailyDigest(
      pool as unknown as Parameters<typeof buildDailyDigest>[0],
      new Date('2026-04-21T12:00:00Z'),
    );

    const pending = summary.byStatus['Pending Review']!;
    expect(pending[0].id).toBe('TR-URG');
    expect(pending[1].id).toBe('TR-STD');
    expect(summary.urgent).toBe(1);
  });

  it('counts > 48h waiters', async () => {
    const pool = makePool({
      rows: [row({ id: 'TR-OLD', waiting_minutes: String(60 * 49) }), row({ id: 'TR-NEW', waiting_minutes: '120' })],
    });

    const { summary } = await buildDailyDigest(
      pool as unknown as Parameters<typeof buildDailyDigest>[0],
      new Date('2026-04-21T12:00:00Z'),
    );

    expect(summary.overdue48h).toBe(1);
    expect(summary.oldestWaitingMinutes).toBe(60 * 49);
  });
});

describe('sendDailyDigest', () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_TEST';
  });

  it('posts to Slack and writes digest_runs on first call', async () => {
    const pool = makePool({ rows: [row({ id: 'TR-1' })] });

    const result = await sendDailyDigest(
      pool as unknown as Parameters<typeof sendDailyDigest>[0],
      new Date('2026-04-21T12:00:00Z'),
    );

    expect(result.sent).toBe(true);
    expect(sendChannelMessageMock).toHaveBeenCalledTimes(1);
    const insertCall = pool.calls.find((c) => c.sql.includes('INSERT INTO digest_runs'));
    expect(insertCall).toBeDefined();
    expect(insertCall?.args?.[0]).toBe('2026-04-21');
  });

  it('is idempotent: returns sent=false and does NOT post when row already exists', async () => {
    const pool = makePool({
      rows: [row({ id: 'TR-1' })],
      insertResults: [{ rows: [] }],
    });

    const result = await sendDailyDigest(
      pool as unknown as Parameters<typeof sendDailyDigest>[0],
      new Date('2026-04-21T12:00:00Z'),
    );

    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.reason).toBe('already_posted');
    expect(sendChannelMessageMock).not.toHaveBeenCalled();
  });
});

describe('sendDigestToTarget', () => {
  it('sends to the supplied target via DM and does NOT write to digest_runs', async () => {
    const pool = makePool({ rows: [row({ id: 'TR-1' })] });

    const result = await sendDigestToTarget(
      pool as unknown as Parameters<typeof sendDigestToTarget>[0],
      'U_TEST',
      new Date('2026-04-21T12:00:00Z'),
    );

    expect(result.sent).toBe(true);
    expect(result.target).toBe('U_TEST');
    expect(sendDirectMessageMock).toHaveBeenCalledTimes(1);
    expect(sendDirectMessageMock).toHaveBeenCalledWith('U_TEST', expect.any(String));
    const insertCall = pool.calls.find((c) => c.sql.includes('INSERT INTO digest_runs'));
    expect(insertCall).toBeUndefined();
  });
});
