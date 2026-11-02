import { describe, it, expect, vi, beforeEach } from 'vitest';

// A first-time advisor platform user is not provisioned while the service is frozen (ticket).
const { mockPool, readStateMock } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  return { mockPool: { query: vi.fn(), connect: vi.fn(), end: vi.fn() }, readStateMock: vi.fn() };
});

vi.mock('../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../serviceMode.js', () => ({ readServiceState: readStateMock }));
vi.mock('../../lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { resolveDelegatedActor } from '../delegatedActor.js';

const FROZEN = 'Trade Requests is briefly read-only while it is being moved — try again in a few minutes.';
const ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  google_id: null,
  email: 'first.time@example.test',
  name: 'First Time',
  picture: null,
  role: 'advisor',
  slack_user_id: null,
  theme_preference: 'system',
  is_active: false,
  last_login: null,
  created_at: new Date('2026-10-20T14:00:00.000Z'),
};
const inserts = () => mockPool.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO users'));

beforeEach(() => {
  mockPool.query.mockReset();
  readStateMock.mockReset();
});

describe('resolveDelegatedActor and the service mode', () => {
  it('frozen: refuses a first-time actor with the read-only message and inserts nothing', async () => {
    readStateMock.mockResolvedValue({ mode: 'frozen' });
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await expect(resolveDelegatedActor('first.time@example.test', 'First Time', 'advisor')).rejects.toMatchObject({
      statusCode: 423,
      userMessage: FROZEN,
    });
    expect(inserts()).toHaveLength(0);
  });

  it('frozen: an existing actor resolves without reading the mode or inserting', async () => {
    readStateMock.mockResolvedValue({ mode: 'frozen' });
    mockPool.query.mockResolvedValueOnce({ rows: [ROW] });
    const user = await resolveDelegatedActor('first.time@example.test', 'First Time', 'trader');
    expect(user.role).toBe('trader');
    expect(readStateMock).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(0);
  });

  it('active: a first-time actor is provisioned (today)', async () => {
    readStateMock.mockResolvedValue({ mode: 'active' });
    mockPool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [ROW] });
    const user = await resolveDelegatedActor('first.time@example.test', 'First Time', 'advisor');
    expect(user.email).toBe('first.time@example.test');
    expect(inserts()).toHaveLength(1);
  });
});
