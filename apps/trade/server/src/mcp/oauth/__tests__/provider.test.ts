import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the secrets reader and DB pool *before* importing the provider/store.
const { mockPool } = vi.hoisted(() => ({
  mockPool: {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    connect: vi.fn(),
    end: vi.fn(),
  },
}));
vi.mock('../../../db/pool.js', () => ({ default: mockPool }));
vi.mock('../../../lib/secrets.js', () => ({
  readSecret: (name: string) => (name === 'GOOGLE_CLIENT_ID' ? 'g-id' : 'g-secret'),
}));

import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { TradeRequestOAuthProvider, assertDevLoginNotInProd } from '../provider.js';
import * as store from '../store.js';

const RESOURCE_URL = 'https://app.example.com/mcp';

function makeProvider() {
  return new TradeRequestOAuthProvider({
    resourceUrl: RESOURCE_URL,
    googleCallbackUrl: 'https://app.example.com/oauth/google/callback',
    googleHd: 'example.com',
  });
}

const fakeClient: OAuthClientInformationFull = {
  client_id: 'mcp_test',
  redirect_uris: ['http://127.0.0.1:9999/cb'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
} as OAuthClientInformationFull;

beforeEach(() => {
  vi.restoreAllMocks();
  mockPool.query.mockReset().mockResolvedValue({ rows: [] });
});

describe('TradeRequestOAuthProvider.authorize', () => {
  it('rejects when resource is missing (RFC 8707 required)', async () => {
    const provider = makeProvider();
    const res = { redirect: vi.fn() } as never;
    await expect(
      provider.authorize(
        fakeClient,
        { codeChallenge: 'abc', redirectUri: 'http://127.0.0.1:9999/cb', scopes: ['mcp:read'] },
        res,
      ),
    ).rejects.toThrow(/Missing resource parameter/);
  });

  it('rejects when resource does not match canonical resource URL', async () => {
    const provider = makeProvider();
    const res = { redirect: vi.fn() } as never;
    await expect(
      provider.authorize(
        fakeClient,
        {
          codeChallenge: 'abc',
          redirectUri: 'http://127.0.0.1:9999/cb',
          resource: new URL('https://other.example.com/mcp'),
          scopes: ['mcp:read'],
        },
        res,
      ),
    ).rejects.toThrow(/Invalid resource/);
  });

  it('redirects to Google with our state and stores pending auth', async () => {
    const provider = makeProvider();
    const redirect = vi.fn();
    const res = { redirect } as never;
    await provider.authorize(
      fakeClient,
      {
        codeChallenge: 'abc',
        redirectUri: 'http://127.0.0.1:9999/cb',
        resource: new URL(RESOURCE_URL),
        scopes: ['mcp:read'],
        state: 'mcp-csrf-state',
      },
      res,
    );

    expect(redirect).toHaveBeenCalledTimes(1);
    const [status, url] = redirect.mock.calls[0];
    expect(status).toBe(302);
    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url).toContain('hd=example.com');
    expect(url).toContain('client_id=g-id');

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mcp_pending_auth'),
      expect.arrayContaining([
        'mcp_test',
        'http://127.0.0.1:9999/cb',
        'abc',
        RESOURCE_URL,
        'mcp:read',
        'mcp-csrf-state',
      ]),
    );
  });
});

describe('TradeRequestOAuthProvider.exchangeAuthorizationCode', () => {
  it('rejects when authorization code was minted for a different client', async () => {
    const provider = makeProvider();
    // consumeAuthorizationCode returns a record with a different clientId.
    vi.spyOn(store, 'consumeAuthorizationCode').mockResolvedValueOnce({
      clientId: 'other-client',
      userId: 'user-1',
      redirectUri: 'http://127.0.0.1:9999/cb',
      codeChallenge: 'abc',
      resource: RESOURCE_URL,
      scope: 'mcp:read',
    });

    await expect(provider.exchangeAuthorizationCode(fakeClient, 'somecode')).rejects.toThrow(/different client/);
  });

  it('rejects when redirect_uri does not match the one bound to the code', async () => {
    const provider = makeProvider();
    vi.spyOn(store, 'consumeAuthorizationCode').mockResolvedValueOnce({
      clientId: fakeClient.client_id,
      userId: 'user-1',
      redirectUri: 'http://127.0.0.1:9999/cb',
      codeChallenge: 'abc',
      resource: RESOURCE_URL,
      scope: 'mcp:read',
    });

    await expect(
      provider.exchangeAuthorizationCode(fakeClient, 'somecode', undefined, 'http://127.0.0.1:9999/different'),
    ).rejects.toThrow(/redirect_uri mismatch/);
  });

  it('rejects when resource does not match the one bound to the code', async () => {
    const provider = makeProvider();
    vi.spyOn(store, 'consumeAuthorizationCode').mockResolvedValueOnce({
      clientId: fakeClient.client_id,
      userId: 'user-1',
      redirectUri: 'http://127.0.0.1:9999/cb',
      codeChallenge: 'abc',
      resource: RESOURCE_URL,
      scope: 'mcp:read',
    });

    await expect(
      provider.exchangeAuthorizationCode(
        fakeClient,
        'somecode',
        undefined,
        'http://127.0.0.1:9999/cb',
        new URL('https://other.example.com/mcp'),
      ),
    ).rejects.toThrow(/resource mismatch/);
  });
});

describe('TradeRequestOAuthProvider.exchangeRefreshToken', () => {
  it('revokes the entire family when a rotated refresh token is replayed', async () => {
    const provider = makeProvider();
    const familyId = 'fam-1';

    // The refresh token has already been rotated — replay attack signal.
    vi.spyOn(store, 'lookupRefreshToken').mockResolvedValueOnce({
      familyId,
      clientId: fakeClient.client_id,
      userId: 'user-1',
      audience: RESOURCE_URL,
      scope: 'mcp:read',
      rotatedTo: Buffer.from('hash'),
      revokedAt: null,
    });
    const revokeSpy = vi.spyOn(store, 'revokeFamily').mockResolvedValueOnce(undefined);

    await expect(provider.exchangeRefreshToken(fakeClient, 'replayed-token')).rejects.toThrow(/revoked/);
    expect(revokeSpy).toHaveBeenCalledWith(familyId);
  });

  it('rejects when the refresh token was issued to a different client', async () => {
    const provider = makeProvider();
    vi.spyOn(store, 'lookupRefreshToken').mockResolvedValueOnce({
      familyId: 'fam-1',
      clientId: 'other-client',
      userId: 'user-1',
      audience: RESOURCE_URL,
      scope: 'mcp:read',
      rotatedTo: null,
      revokedAt: null,
    });
    await expect(provider.exchangeRefreshToken(fakeClient, 'tok')).rejects.toThrow(/different client/);
  });
});

describe('TradeRequestOAuthProvider.verifyAccessToken', () => {
  it('returns AuthInfo with resource set to the bound audience', async () => {
    const provider = makeProvider();
    vi.spyOn(store, 'lookupAccessToken').mockResolvedValueOnce({
      clientId: fakeClient.client_id,
      userId: 'user-1',
      audience: RESOURCE_URL,
      scope: 'mcp:read',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const info = await provider.verifyAccessToken('a-token');
    expect(info.clientId).toBe(fakeClient.client_id);
    expect(info.scopes).toEqual(['mcp:read']);
    expect(info.resource?.toString()).toBe(RESOURCE_URL);
    expect((info.extra as { userId: string }).userId).toBe('user-1');
  });

  it('throws when the token is unknown (lookup miss)', async () => {
    const provider = makeProvider();
    vi.spyOn(store, 'lookupAccessToken').mockResolvedValueOnce(null);
    await expect(provider.verifyAccessToken('bad')).rejects.toThrow(/Invalid or expired/);
  });

  it('routes tr_pat_ tokens to lookupPat and never to lookupAccessToken', async () => {
    const provider = makeProvider();
    const lookupPatSpy = vi.spyOn(store, 'lookupPat').mockResolvedValueOnce({
      id: 'pat-1',
      userId: 'user-1',
      audience: RESOURCE_URL,
      lastUsedAt: null,
    });
    const lookupAccessSpy = vi.spyOn(store, 'lookupAccessToken');
    const touchSpy = vi.spyOn(store, 'touchPatLastUsed').mockResolvedValueOnce(undefined);

    const info = await provider.verifyAccessToken('tr_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

    expect(lookupPatSpy).toHaveBeenCalledTimes(1);
    expect(lookupAccessSpy).not.toHaveBeenCalled();
    expect(touchSpy).toHaveBeenCalledTimes(1);
    expect(info.clientId).toBe('pat');
    expect(info.scopes).toEqual(['mcp:read']);
    // SDK bearerAuth requires expiresAt — PATs use a far-future sentinel.
    expect(typeof info.expiresAt).toBe('number');
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000 + 365 * 24 * 3600);
    expect(info.resource?.toString()).toBe(RESOURCE_URL);
    expect((info.extra as { userId: string; patId: string }).userId).toBe('user-1');
    expect((info.extra as { patId: string }).patId).toBe('pat-1');
  });

  it('rejects a PAT-prefixed token that misses lookup — no fall-through to OAuth', async () => {
    const provider = makeProvider();
    vi.spyOn(store, 'lookupPat').mockResolvedValueOnce(null);
    const lookupAccessSpy = vi.spyOn(store, 'lookupAccessToken');

    await expect(provider.verifyAccessToken('tr_pat_unknown')).rejects.toThrow(/Invalid or expired/);
    // Critically, we must NOT fall through to the OAuth lookup.
    expect(lookupAccessSpy).not.toHaveBeenCalled();
  });
});

describe('DEV_LOGIN_EMAIL bypass', () => {
  const baseConfig = {
    resourceUrl: RESOURCE_URL,
    googleCallbackUrl: 'https://app.example.com/oauth/google/callback',
    googleHd: 'example.com',
    devLoginEmail: 'jeremy@example.com',
  };

  it('hard-fails at boot when DEV_LOGIN_EMAIL is set under NODE_ENV=production', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => assertDevLoginNotInProd('any@example.com')).toThrow(/Refusing to start/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('is a no-op when DEV_LOGIN_EMAIL is unset, even in production', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => assertDevLoginNotInProd(undefined)).not.toThrow();
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('skips Google and mints a code for the configured user when NODE_ENV=development', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const provider = new TradeRequestOAuthProvider(baseConfig);
      // First mockPool.query call: lookupActiveUserIdByEmail
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 'user-uuid' }] });
      // Second mockPool.query call: issueAuthorizationCode INSERT
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const redirect = vi.fn();
      const res = { redirect } as never;

      await provider.authorize(
        fakeClient,
        {
          codeChallenge: 'pkce',
          redirectUri: 'http://127.0.0.1:9999/cb',
          resource: new URL(RESOURCE_URL),
          scopes: ['mcp:read'],
          state: 'mcp-state',
        },
        res,
      );

      expect(redirect).toHaveBeenCalledTimes(1);
      const [status, url] = redirect.mock.calls[0];
      expect(status).toBe(302);
      // Must NOT redirect to Google
      expect(url).not.toContain('accounts.google.com');
      // Must redirect back to client with code + state
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:9999\/cb\?/);
      expect(url).toContain('code=');
      expect(url).toContain('state=mcp-state');
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('falls through to Google flow when devLoginEmail is unset', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const provider = new TradeRequestOAuthProvider({ ...baseConfig, devLoginEmail: undefined });
      const redirect = vi.fn();
      await provider.authorize(
        fakeClient,
        {
          codeChallenge: 'pkce',
          redirectUri: 'http://127.0.0.1:9999/cb',
          resource: new URL(RESOURCE_URL),
          scopes: ['mcp:read'],
        },
        { redirect } as never,
      );
      expect(redirect.mock.calls[0][1]).toContain('accounts.google.com');
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('throws when DEV_LOGIN_EMAIL does not match an active user', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const provider = new TradeRequestOAuthProvider(baseConfig);
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // no user found

      await expect(
        provider.authorize(
          fakeClient,
          {
            codeChallenge: 'pkce',
            redirectUri: 'http://127.0.0.1:9999/cb',
            resource: new URL(RESOURCE_URL),
            scopes: ['mcp:read'],
          },
          { redirect: vi.fn() } as never,
        ),
      ).rejects.toThrow(/does not match an active user/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
