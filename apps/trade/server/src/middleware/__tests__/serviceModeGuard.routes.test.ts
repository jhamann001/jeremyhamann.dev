import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Router } from 'express';
import request from 'supertest';

// Every route the application mounts, read from the routers themselves, checked against the guard
// in each mode (ticket). A new route is refused by default; this file fails if a mount is added
// to index.ts or delegated.ts without being listed here.

const { readStateMock } = vi.hoisted(() => {
  process.env.GOOGLE_CLIENT_ID = 'test-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.SESSION_SECRET = 'test-session';
  return { readStateMock: vi.fn() };
});

vi.mock('../../db/pool.js', () => ({ default: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../services/serviceMode.js', async (orig) => ({
  ...(await orig<typeof import('../../services/serviceMode.js')>()),
  readServiceState: readStateMock,
}));

const { serviceModeGuard, FROZEN_MESSAGE } = await import('../serviceModeGuard.js');
const r = async (p: string) => ((await import(p)) as { default: Router }).default;
const routers = {
  auth: await r('../../routes/auth.js'),
  internal: await r('../../routes/internal.js'),
  machine: await r('../../routes/machine.js'),
  clients: await r('../../routes/clients.js'),
  exclusions: await r('../../routes/exclusions.js'),
  drift: await r('../../routes/drift.js'),
  households: await r('../../routes/households.js'),
  requests: await r('../../routes/requests.js'),
  notifications: await r('../../routes/notifications.js'),
  users: await r('../../routes/users.js'),
  mcpSessions: await r('../../routes/mcpSessions.js'),
  mcpTokens: await r('../../routes/mcpTokens.js'),
  outbox: await r('../../routes/outbox.js'),
};

/** Mirrors routes/delegated.ts: the delegated surface re-mounts these routers under /api/ops-portal. */
const DELEGATED: Array<[string, Router]> = [
  ['/requests', routers.requests],
  ['/notifications', routers.notifications],
  ['/clients', routers.clients],
  ['/clients', routers.exclusions],
  ['/households', routers.households],
];

/** Mirrors index.ts, in mount order. */
const MOUNTS: Array<[string, Router[]]> = [
  ['/auth', [routers.auth]],
  ['/api/internal', [routers.internal]],
  ['/api/machine', [routers.machine]],
  ['/api/ops-portal', []],
  ['/api/clients', [routers.clients]],
  ['/api/clients', [routers.exclusions]],
  ['/api/drift', [routers.drift]],
  ['/api/households', [routers.households]],
  ['/api/requests', [routers.requests]],
  ['/api/notifications', [routers.notifications]],
  ['/api/users', [routers.users]],
  ['/api/me/mcp-sessions', [routers.mcpSessions]],
  ['/api/me/mcp-tokens', [routers.mcpTokens]],
  // Mounted only when DEMO_STAND_INS=on; read-only, so the guard treats it like any other read.
  ['/api/outbox', [routers.outbox]],
];
/** app.use() prefixes in index.ts that mount middleware or static files, not routers. */
const NON_ROUTER_USES = ['/api/', '/auth/', '/api/docs', '/assets'];
/** Routes index.ts declares directly (health is registered before the guard and never reaches it). */
const DIRECT = ['GET /api/health/live', 'GET /api/health', 'GET /api/service-mode', 'POST /api/client-errors'];

type RouteLayer = { route?: { path: string | string[]; methods: Record<string, boolean> } };

function routesOf(prefix: string, router: Router): string[] {
  const out: string[] = [];
  for (const layer of router.stack as unknown as RouteLayer[]) {
    if (!layer.route) continue;
    for (const p of ([] as string[]).concat(layer.route.path)) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push(`${method.toUpperCase()} ${prefix}${p === '/' ? '' : p}`);
      }
    }
  }
  return out;
}

const ROUTES = [
  ...MOUNTS.flatMap(([prefix, rs]) =>
    prefix === '/api/ops-portal'
      ? DELEGATED.flatMap(([sub, router]) => routesOf(`/api/ops-portal${sub}`, router))
      : rs.flatMap((router) => routesOf(prefix, router)),
  ),
  ...DIRECT.filter((d) => !d.includes('/api/health')),
];
const isWrite = (route: string) => !/^(GET|HEAD) /.test(route);

const FROZEN_ALLOWED_WRITES = [
  'POST /auth/persona',
  'POST /auth/demo',
  'POST /auth/extend-session',
  'POST /auth/logout',
  'POST /api/internal/demo-reset',
  'POST /api/internal/digest/daily',
  'POST /api/internal/digest/test-send',
  'POST /api/internal/drift/check',
  'POST /api/internal/drift/check/preview',
  'PUT /api/machine/service-mode',
  'DELETE /api/me/mcp-sessions/:familyId',
  'DELETE /api/me/mcp-sessions',
  'POST /api/me/mcp-tokens',
  'DELETE /api/me/mcp-tokens/:id',
  'POST /api/client-errors',
];
const MCP_ONLY_ALLOWED_PREFIXES = ['/api/internal/', '/api/machine/', '/api/me/mcp-sessions', '/api/me/mcp-tokens'];
const MCP_ONLY_ALLOWED_EXACT = [
  'GET /auth/config',
  'GET /auth/google',
  'GET /auth/google/callback',
  'GET /auth/dev-login',
  'GET /auth/sign-in-options',
  'POST /auth/persona',
  'GET /auth/me',
  'POST /auth/extend-session',
  'POST /auth/logout',
  'GET /api/service-mode',
  'POST /api/client-errors',
];
const mcpOnlyAllowed = (route: string) =>
  MCP_ONLY_ALLOWED_EXACT.includes(route) || MCP_ONLY_ALLOWED_PREFIXES.some((p) => route.split(' ')[1].startsWith(p));

const guarded = express();
guarded.use(serviceModeGuard);
guarded.use((_req, res) => {
  res.status(204).end();
});
// One listening server for the whole file, so no request can reach a socket left from another test.
const server = guarded.listen(0);
afterAll(() => new Promise<void>((done) => server.close(() => done())));

async function send(route: string) {
  const [method, routePath] = route.split(' ');
  const url = routePath.replace(/:[A-Za-z]+/g, 'x1');
  const agent = request(server);
  const call = (agent as unknown as Record<string, (u: string) => request.Test>)[method.toLowerCase()](url);
  return method === 'GET' || method === 'HEAD' ? call : call.send({});
}

beforeEach(() => {
  readStateMock.mockReset();
});

describe('service-mode guard over every mounted route', () => {
  it('lists every router mount in index.ts and delegated.ts', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const index = fs.readFileSync(path.join(here, '..', '..', 'index.ts'), 'utf8');
    const delegated = fs.readFileSync(path.join(here, '..', '..', 'routes', 'delegated.ts'), 'utf8');
    const uses = [...index.matchAll(/app\.use\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(uses.filter((u) => !NON_ROUTER_USES.includes(u))).toEqual(MOUNTS.map(([p]) => p));
    expect(uses.filter((u) => NON_ROUTER_USES.includes(u)).sort()).toEqual([...NON_ROUTER_USES].sort());
    const direct = [...index.matchAll(/app\.(get|post|put|patch|delete)\('(\/[^']*)'/g)]
      .map((m) => `${m[1].toUpperCase()} ${m[2]}`)
      .filter((d) => d !== 'GET /{*splat}');
    expect(direct).toEqual(DIRECT);
    expect([...delegated.matchAll(/router\.use\('([^']+)'/g)].map((m) => m[1])).toEqual(DELEGATED.map(([p]) => p));
  });

  it('mounts the guard once in index.ts, after health and before every route, MCP and the static client', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '..', '..', 'index.ts'), 'utf8');
    // Commented-out lines do not count as wiring.
    const index = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const at = (needle: string) => index.indexOf(needle);
    const once = (needle: string) => expect([needle, index.split(needle).length - 1]).toEqual([needle, 1]);
    once('app.use(serviceModeGuard);');
    once("app.get('/api/service-mode', serviceModeRoute);");
    once('startServiceModeRefresh();');
    const guard = at('app.use(serviceModeGuard);');
    expect(guard).toBeGreaterThan(at("app.get('/api/health'"));
    for (const later of [
      "app.get('/api/service-mode'",
      "app.use('/auth'",
      "app.use('/api/internal'",
      "app.use('/api/machine'",
      "'/api/ops-portal',",
      "app.use('/api/clients'",
      "app.post('/api/client-errors'",
      'setupMcp(app',
      "app.get('/{*splat}'",
    ]) {
      expect([later, at(later) > guard]).toEqual([later, true]);
    }
    // The refresh starts inside the listen callback, after the start-up log line and before shutdown handling.
    const refresh = at('startServiceModeRefresh();');
    expect([refresh > at("'Server running'"), refresh < at('let shuttingDown')]).toEqual([true, true]);
    expect(at("'Server running'")).toBeGreaterThan(at('app.listen('));
  });

  it('enumerates 49 mounted write routes', () => {
    expect(ROUTES.filter(isWrite)).toHaveLength(49);
  });

  it('frozen: refuses every write with the read-only message except sign-in, Connected Apps, jobs and the controls', async () => {
    readStateMock.mockResolvedValue({ mode: 'frozen' });
    const refused: string[] = [];
    const allowed: string[] = [];
    for (const route of ROUTES.filter(isWrite)) {
      const res = await send(route);
      if (res.status === 423 && res.body.error === FROZEN_MESSAGE) refused.push(route);
      else if (res.status === 204) allowed.push(route);
      else throw new Error(`${route} answered ${res.status}`);
    }
    expect(allowed.sort()).toEqual([...FROZEN_ALLOWED_WRITES].sort());
    expect(refused).toHaveLength(34);
  });

  it('frozen: keeps every read', async () => {
    readStateMock.mockResolvedValue({ mode: 'frozen' });
    const wrong: string[] = [];
    for (const route of ROUTES.filter((x) => !isWrite(x))) {
      const res = await send(route);
      if (res.status !== 204) wrong.push(`${route} ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('MCP-only: refuses every route except sign-in, Connected Apps, jobs and the machine surface', async () => {
    readStateMock.mockResolvedValue({ mode: 'mcp-only' });
    const wrong: string[] = [];
    for (const route of ROUTES) {
      const res = await send(route);
      const expected = mcpOnlyAllowed(route) ? 204 : 403;
      if (res.status !== expected) wrong.push(`${route} ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('active: lets every route through', async () => {
    readStateMock.mockResolvedValue({ mode: 'active' });
    const wrong: string[] = [];
    for (const route of ROUTES) {
      const res = await send(route);
      if (res.status !== 204) wrong.push(`${route} ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it('keeps MCP, its OAuth sign-in and discovery documents reachable in frozen and MCP-only mode', async () => {
    const MCP = [
      'POST /mcp',
      'GET /mcp',
      'GET /.well-known/oauth-authorization-server',
      'GET /.well-known/oauth-protected-resource/mcp',
      'POST /register',
      'GET /authorize',
      'POST /authorize',
      'POST /token',
      'POST /revoke',
      'GET /oauth/google/callback',
    ];
    for (const mode of ['frozen', 'mcp-only']) {
      readStateMock.mockResolvedValue({ mode });
      for (const route of MCP) expect([mode, route, (await send(route)).status]).toEqual([mode, route, 204]);
    }
  });
});
