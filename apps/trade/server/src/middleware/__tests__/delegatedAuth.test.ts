import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, type CryptoKey } from 'jose';

// Real jose verification; only the remote key fetch is replaced so Google's
// OIDC keys and the per-service-account key endpoint resolve to locally
// generated key pairs.
const { remoteKeys, resolveActorMock, loggerMock } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  return {
    remoteKeys: new Map<string, unknown>(),
    resolveActorMock: vi.fn(),
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return {
    ...actual,
    createRemoteJWKSet: (url: URL) => (protectedHeader: unknown, token: unknown) => {
      const keys = remoteKeys.get(url.href) as JWTVerifyGetKey | undefined;
      if (!keys) throw new Error(`no test keys for ${url.href}`);
      return (keys as (h: unknown, t: unknown) => unknown)(protectedHeader, token);
    },
  };
});

vi.mock('../../services/delegatedActor.js', () => ({ resolveDelegatedActor: resolveActorMock }));
vi.mock('../../lib/logger.js', () => ({ default: loggerMock }));

const OPS_PORTAL_SA = 'ops-portal-run@ops-portal.iam.gserviceaccount.com';
const OTHER_SA = 'other@another-project.iam.gserviceaccount.com';
const AUDIENCE = 'https://trade-request.example.run.app/api/ops-portal';
const PERSON = 'pat.synthetic@example.com';
const PERSON_NAME = 'Pat Synthetic';
const GOOGLE_CERTS = 'https://www.googleapis.com/oauth2/v3/certs';
const saJwkUrl = (email: string) => `https://www.googleapis.com/service_accounts/v1/jwk/${encodeURIComponent(email)}`;

let googleKey: CryptoKey;
let opsPortalSaKey: CryptoKey;
let otherSaKey: CryptoKey;

async function jwksFor(kid: string, publicKey: CryptoKey) {
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return createLocalJWKSet({ keys: [jwk] });
}

beforeAll(async () => {
  const google = await generateKeyPair('RS256');
  const opsPortal = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  googleKey = google.privateKey;
  opsPortalSaKey = opsPortal.privateKey;
  otherSaKey = other.privateKey;
  remoteKeys.set(GOOGLE_CERTS, await jwksFor('google-1', google.publicKey));
  remoteKeys.set(saJwkUrl(OPS_PORTAL_SA), await jwksFor('ops-portal-1', opsPortal.publicKey));
  remoteKeys.set(saJwkUrl(OTHER_SA), await jwksFor('other-1', other.publicKey));
});

interface IdTokenOptions {
  email?: string;
  emailVerified?: boolean;
  audience?: string;
  key?: CryptoKey;
}

async function idToken(opts: IdTokenOptions = {}) {
  return new SignJWT({ email: opts.email ?? OPS_PORTAL_SA, email_verified: opts.emailVerified ?? true })
    .setProtectedHeader({ alg: 'RS256', kid: 'google-1' })
    .setIssuer('https://accounts.google.com')
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(opts.key ?? googleKey);
}

interface AssertionOptions {
  sub?: string;
  name?: string | null;
  role?: string | null;
  issuer?: string;
  audience?: string;
  key?: CryptoKey;
  kid?: string;
  iat?: number;
  exp?: number;
}

async function assertion(opts: AssertionOptions = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {};
  if (opts.role !== null) claims.ops_portal_role = opts.role ?? 'ADVISOR';
  if (opts.name !== null) claims.name = opts.name ?? PERSON_NAME;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'ops-portal-1' })
    .setIssuer(opts.issuer ?? OPS_PORTAL_SA)
    .setSubject(opts.sub ?? PERSON)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt(opts.iat ?? now)
    .setExpirationTime(opts.exp ?? now + 120)
    .setJti('jti-1')
    .sign(opts.key ?? opsPortalSaKey);
}

function createReqRes(headers: Record<string, string>) {
  const req = { headers, requestId: 'req-1' } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), req } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

async function run(headers: Record<string, string>) {
  const { requireDelegatedCaller } = await import('../delegatedAuth.js');
  const ctx = createReqRes(headers);
  await requireDelegatedCaller(ctx.req, ctx.res, ctx.next);
  return ctx;
}

async function validHeaders(a?: AssertionOptions, t?: IdTokenOptions) {
  return { authorization: `Bearer ${await idToken(t)}`, 'x-ops-portal-actor-assertion': await assertion(a) };
}

function expectRefused(ctx: Awaited<ReturnType<typeof run>>, status: number, code: string) {
  expect(ctx.res.status).toHaveBeenCalledWith(status);
  expect(ctx.res.json).toHaveBeenCalledWith(expect.objectContaining({ code }));
  expect(ctx.next).not.toHaveBeenCalled();
  expect(resolveActorMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPS_PORTAL_DELEGATED_AUDIENCE = AUDIENCE;
  process.env.OPS_PORTAL_DELEGATED_CALLER_SA = ` ${OPS_PORTAL_SA.toUpperCase()} , unused@x.iam.gserviceaccount.com`;
  delete process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY;
  resolveActorMock.mockImplementation(async (email: string, name: string, role: string) => ({
    id: 'actor-uuid',
    email,
    name,
    role,
  }));
});

afterEach(() => {
  delete process.env.OPS_PORTAL_DELEGATED_AUDIENCE;
  delete process.env.OPS_PORTAL_DELEGATED_CALLER_SA;
  delete process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY;
  vi.unstubAllEnvs();
});

describe('requireDelegatedCaller — configuration', () => {
  it('returns 503 when the audience is not configured', async () => {
    delete process.env.OPS_PORTAL_DELEGATED_AUDIENCE;
    expectRefused(await run(await validHeaders()), 503, 'delegated_not_configured');
  });

  it('returns 503 when the caller allowlist is empty', async () => {
    process.env.OPS_PORTAL_DELEGATED_CALLER_SA = ' , ';
    expectRefused(await run(await validHeaders()), 503, 'delegated_not_configured');
  });
});

describe('requireDelegatedCaller — application identity', () => {
  it('refuses a call with no bearer token', async () => {
    expectRefused(await run({ 'x-ops-portal-actor-assertion': await assertion() }), 401, 'caller_unauthenticated');
  });

  it('refuses an application token not signed by Google', async () => {
    expectRefused(await run(await validHeaders({}, { key: otherSaKey })), 401, 'caller_unauthenticated');
  });

  it('refuses an application token minted for another audience', async () => {
    expectRefused(
      await run(await validHeaders({}, { audience: 'https://elsewhere.example' })),
      401,
      'caller_unauthenticated',
    );
  });

  it('refuses a service account that is not on the allowlist', async () => {
    expectRefused(
      await run(await validHeaders({ issuer: OTHER_SA, key: otherSaKey, kid: 'other-1' }, { email: OTHER_SA })),
      403,
      'caller_not_permitted',
    );
  });

  it('refuses an application token whose email is not verified', async () => {
    expectRefused(await run(await validHeaders({}, { emailVerified: false })), 403, 'caller_not_permitted');
  });
});

describe('requireDelegatedCaller — person identity (AC-68)', () => {
  it('refuses a call that carries only the application identity', async () => {
    expectRefused(await run({ authorization: `Bearer ${await idToken()}` }), 401, 'person_unconfirmed');
  });

  it('refuses an expired assertion', async () => {
    const now = Math.floor(Date.now() / 1000);
    expectRefused(await run(await validHeaders({ iat: now - 400, exp: now - 100 })), 401, 'person_unconfirmed');
  });

  it('refuses an assertion valid for longer than 300 seconds', async () => {
    const now = Math.floor(Date.now() / 1000);
    expectRefused(await run(await validHeaders({ iat: now, exp: now + 3600 })), 401, 'person_unconfirmed');
  });

  it('refuses an assertion minted for another audience', async () => {
    expectRefused(await run(await validHeaders({ audience: 'https://elsewhere.example' })), 401, 'person_unconfirmed');
  });

  it('refuses an assertion signed by a different service account (wrong caller)', async () => {
    expectRefused(
      await run(await validHeaders({ issuer: OTHER_SA, key: otherSaKey, kid: 'other-1' })),
      401,
      'person_unconfirmed',
    );
  });

  it('refuses an assertion whose issuer is not the calling service account', async () => {
    expectRefused(await run(await validHeaders({ issuer: OTHER_SA })), 401, 'person_unconfirmed');
  });

  it('refuses an assertion re-pointed at another person and re-signed with a foreign key', async () => {
    expectRefused(
      await run(await validHeaders({ sub: 'someone.else@example.com', key: otherSaKey, kid: 'ops-portal-1' })),
      401,
      'person_unconfirmed',
    );
  });

  it('refuses a person outside the company email domains', async () => {
    expectRefused(await run(await validHeaders({ sub: 'pat@gmail.com' })), 401, 'person_unconfirmed');
  });

  it('refuses an assertion without a display name', async () => {
    expectRefused(await run(await validHeaders({ name: null })), 401, 'person_unconfirmed');
  });
});

describe('requireDelegatedCaller — role mapping (D1, AC-67)', () => {
  it('refuses an assertion without a role', async () => {
    expectRefused(await run(await validHeaders({ role: null })), 401, 'role_unconfirmed');
  });

  it('refuses an unknown role', async () => {
    expectRefused(await run(await validHeaders({ role: 'SUPERUSER' })), 401, 'role_unconfirmed');
  });

  it.each(['CLIENT_SERVICE', 'VIEWER'])('refuses %s with 403 and no data', async (role) => {
    const ctx = await run(await validHeaders({ role }));
    expectRefused(ctx, 403, 'role_not_permitted');
    const body = (ctx.res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'requestId']);
  });

  it.each([
    ['ADMIN', 'trader'],
    ['OPERATIONS', 'trader'],
    ['ADVISOR', 'advisor'],
  ])('admits %s as %s through the Ops Portal channel', async (opsPortalRole, mapped) => {
    const ctx = await run(await validHeaders({ role: opsPortalRole, sub: PERSON.toUpperCase() }));
    expect(ctx.next).toHaveBeenCalledWith();
    expect(resolveActorMock).toHaveBeenCalledWith(PERSON, PERSON_NAME, mapped);
    expect(ctx.req.user).toMatchObject({ role: mapped, email: PERSON });
    expect(ctx.req.authChannel).toBe('opsPortal');
    expect(ctx.req.isDemo).toBe(false);
  });

  it('passes a database failure to the error handler without admitting the call', async () => {
    resolveActorMock.mockRejectedValueOnce(new Error('db down'));
    const ctx = await run(await validHeaders());
    expect(ctx.next).toHaveBeenCalledWith(expect.any(Error));
    expect(ctx.req.authChannel).toBeUndefined();
  });
});

describe('requireDelegatedCaller — local mode', () => {
  const LOCAL_KEY = 'local-test-key-0123456789';

  async function localToken(claims: Record<string, unknown>, subject?: string) {
    const now = Math.floor(Date.now() / 1000);
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('ops-portal-local@delegated.invalid')
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 120);
    if (subject) jwt.setSubject(subject);
    return jwt.sign(new TextEncoder().encode(LOCAL_KEY));
  }

  async function localHeaders() {
    return {
      authorization: `Bearer ${await localToken({ email: 'ops-portal-local@delegated.invalid' })}`,
      'x-ops-portal-actor-assertion': await localToken({ ops_portal_role: 'OPERATIONS', name: PERSON_NAME }, PERSON),
    };
  }

  it('accepts HS256 tokens signed with the local key outside production', async () => {
    process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY = LOCAL_KEY;
    process.env.OPS_PORTAL_DELEGATED_CALLER_SA = 'ops-portal-local@delegated.invalid';
    const ctx = await run(await localHeaders());
    expect(ctx.next).toHaveBeenCalledWith();
    expect(ctx.req.user).toMatchObject({ role: 'trader' });
  });

  it('ignores the local key in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY = LOCAL_KEY;
    process.env.OPS_PORTAL_DELEGATED_CALLER_SA = 'ops-portal-local@delegated.invalid';
    expectRefused(await run(await localHeaders()), 401, 'caller_unauthenticated');
  });
});

describe('requireDelegatedCaller — logging (contract item 8)', () => {
  it('never logs the person, the role or token contents', async () => {
    const headers = await validHeaders({ role: 'VIEWER' });
    await run(headers);
    await run(await validHeaders({ sub: 'pat@gmail.com' }));
    await run({ authorization: headers.authorization });
    const logged = JSON.stringify([
      ...loggerMock.warn.mock.calls,
      ...loggerMock.info.mock.calls,
      ...loggerMock.error.mock.calls,
    ]);
    expect(loggerMock.warn).toHaveBeenCalled();
    for (const secret of [PERSON, 'pat@gmail.com', PERSON_NAME, 'VIEWER', headers.authorization.slice(7, 40)]) {
      expect(logged).not.toContain(secret);
    }
  });
});
