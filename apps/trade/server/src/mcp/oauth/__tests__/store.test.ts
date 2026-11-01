import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPool } = vi.hoisted(() => ({
  mockPool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
    end: vi.fn(),
  },
}));
vi.mock('../../../db/pool.js', () => ({ default: mockPool }));

import { generateToken, hashToken, consumeAuthorizationCode, lookupAccessToken } from '../store.js';

beforeEach(() => {
  mockPool.query.mockReset().mockResolvedValue({ rows: [] });
});

describe('token primitives', () => {
  it('generates 256-bit url-safe tokens that hash to 32 bytes', () => {
    const tok = generateToken();
    // 32 bytes -> 43 base64url chars (no padding)
    expect(tok).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hash = hashToken(tok);
    expect(hash.length).toBe(32);
  });

  it('hashes the same token to the same digest deterministically', () => {
    const tok = 'fixed-token';
    expect(hashToken(tok).equals(hashToken(tok))).toBe(true);
  });
});

describe('consumeAuthorizationCode', () => {
  it('uses an atomic UPDATE … WHERE consumed_at IS NULL to prevent replay', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await consumeAuthorizationCode('the-code');
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE oauth_authorization_codes/);
    expect(sql).toMatch(/SET consumed_at = NOW\(\)/);
    expect(sql).toMatch(/WHERE code_hash = \$1 AND consumed_at IS NULL AND expires_at > NOW\(\)/);
    expect(params[0]).toBeInstanceOf(Buffer);
    expect((params[0] as Buffer).length).toBe(32);
  });

  it('returns null when the UPDATE matched no rows (already-consumed or expired)', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const result = await consumeAuthorizationCode('already-used');
    expect(result).toBeNull();
  });
});

describe('lookupAccessToken', () => {
  it('filters out revoked and expired tokens at the SQL layer', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    await lookupAccessToken('some-token');
    const [sql] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(sql).toMatch(/expires_at > NOW\(\)/);
  });
});
