import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import type { AuthUser } from '@trade-request/shared';
import { setupAuth, requireAuth, requireRole } from './middleware/auth.js';
import { attachDemoFlag } from './middleware/demo.js';
import { csrfProtection } from './middleware/csrf.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import clientExclusionRoutes from './routes/exclusions.js';
import driftRoutes from './routes/drift.js';
import householdRoutes from './routes/households.js';
import requestRoutes from './routes/requests.js';
import notificationRoutes from './routes/notifications.js';
import userRoutes from './routes/users.js';
import mcpSessionRoutes from './routes/mcpSessions.js';
import mcpTokenRoutes from './routes/mcpTokens.js';
import internalRoutes from './routes/internal.js';
import machineRoutes from './routes/machine.js';
import outboxRoutes from './routes/outbox.js';
import { startStandIns } from './demo/standIns/server.js';
import { requireMachineAuth } from './middleware/machineAuth.js';
import { requireDelegatedCaller } from './middleware/delegatedAuth.js';
import { serviceModeGuard, serviceModeRoute } from './middleware/serviceModeGuard.js';
import { startServiceModeRefresh } from './services/serviceMode.js';
import delegatedRoutes, { requireDelegatedOperation } from './routes/delegated.js';
import { setupMcp } from './mcp/index.js';
import pool from './db/pool.js';
import { startEngineUseCounting, flushEngineUse } from './services/engineUse.js';
import logger from './lib/logger.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 8080);

// ─── Security middleware ────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production' && !process.env.CLIENT_ORIGIN) {
  throw new Error('CLIENT_ORIGIN must be set in production');
}

// DEV_LOGIN_EMAIL bypasses Google OAuth for both the main web app
// (server/src/routes/auth.ts) and the MCP OAuth provider
// (server/src/mcp/oauth/provider.ts). Refuse to boot if it leaks into prod —
// the route handlers themselves also 404 in prod, but failing here gives a
// loud, early signal rather than a silent "the dev backdoor is closed".
if (process.env.NODE_ENV === 'production' && process.env.DEV_LOGIN_EMAIL) {
  throw new Error(
    'DEV_LOGIN_EMAIL is set but NODE_ENV=production. Refusing to start — this would expose an auth bypass.',
  );
}

// OPS_PORTAL_DELEGATED_LOCAL_KEY lets /api/ops-portal accept HS256 tokens signed with a shared
// key for local development and tests. delegatedAuth.ts ignores it in
// production; refuse to boot as well so a leaked value is loud, not silent.
if (process.env.NODE_ENV === 'production' && process.env.OPS_PORTAL_DELEGATED_LOCAL_KEY) {
  throw new Error(
    'OPS_PORTAL_DELEGATED_LOCAL_KEY is set but NODE_ENV=production. Refusing to start — this would weaken delegated auth.',
  );
}

if (process.env.NODE_ENV === 'production') {
  const allowedHosts = new Set(
    (process.env.CLIENT_ORIGIN ?? '')
      .split(',')
      .map((o) => {
        try {
          return new URL(o.trim()).host;
        } catch {
          return '';
        }
      })
      .filter(Boolean),
  );

  if (allowedHosts.size === 0) {
    throw new Error('CLIENT_ORIGIN contains no valid URLs');
  }

  app.use((req, res, next) => {
    if (req.path === '/api/health' || req.path === '/api/health/live') {
      next();
      return;
    }
    if (req.headers['x-forwarded-proto'] !== 'https') {
      const host = req.headers.host ?? '';
      if (!allowedHosts.has(host)) {
        res.status(400).send('Invalid host');
        return;
      }
      res.redirect(301, `https://${host}${req.url}`);
      return;
    }
    next();
  });
}

app.use(
  helmet({
    contentSecurityPolicy:
      process.env.NODE_ENV === 'production'
        ? {
            directives: {
              defaultSrc: ["'self'"],
              // Cloudflare Web Analytics: its edge injects this beacon, which reports back to this origin.
              scriptSrc: ["'self'", 'https://static.cloudflareinsights.com'],
              styleSrc: ["'self'", 'https://fonts.googleapis.com'],
              fontSrc: ["'self'", 'https://fonts.gstatic.com'],
              imgSrc: ["'self'", 'data:', 'https:'],
              connectSrc: ["'self'"],
            },
          }
        : false,
  }),
);

// ─── Health endpoints (registered before rate limiters) ──────────────────────

app.get('/api/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unhealthy' });
  }
});

// Rate limiters use the default in-memory store, which resets on deploy and is
// per-instance (Cloud Run may run up to 3 instances). Read-heavy UI polling
// should not block advisor workflows, so the per-user limiter below only
// constrains mutating authenticated API calls. If stricter global limits are
// needed, switch to @rate-limit/redis with a Memorystore instance.
const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000);

const apiLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  max: Number(process.env.RATE_LIMIT_API_MAX ?? 2000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  // Scheduler-driven internal endpoints (e.g. daily digest) have their own
  // OIDC-based auth and predictable call volume; excluding them keeps the
  // user-facing budget intact and prevents a noisy cron from throttling UI.
  //
  // The Ops Portal delegated surface (/api/ops-portal) is excluded too: every Ops Portal user's call
  // leaves from OPS_PORTAL's Cloud Run egress, so a per-IP budget sized for one browser
  // would throttle the whole firm at once. It has its own limiter below.
  skip: (req) => req.path.startsWith('/internal/') || req.path.startsWith('/ops-portal/'),
});
app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  max: Number(process.env.RATE_LIMIT_AUTH_MAX ?? 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});
app.use('/auth/', authLimiter);

const userApiLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  max: Number(process.env.RATE_LIMIT_USER_MAX ?? 100),
  // Demo personas are shared by every visitor, so there the budget is per persona and visitor IP: one
  // visitor running a script must not lock everyone else out of that persona.
  keyGenerator: (req) => {
    const userId = (req.user as AuthUser | undefined)?.id;
    if (userId && process.env.PERSONA_SIGN_IN === 'on') return `${userId}:${ipKeyGenerator(req.ip ?? '')}`;
    return userId ?? req.ip ?? 'unknown';
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from this user, please try again later.' },
  skip: (req) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method),
  validate: { keyGeneratorIpFallback: false },
});

// Machine-to-machine (OPS_PORTAL ops-portal-run@ SA) budget. Keyed by IP, stricter than the
// global apiLimiter — /api/machine also passes through apiLimiter (defense in
// depth; it is NOT added to the apiLimiter skip predicate).
const machineLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  max: Number(process.env.RATE_LIMIT_MACHINE_MAX ?? 300),
  keyGenerator: (req) => req.ip ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  validate: { keyGeneratorIpFallback: false },
});

// Ops Portal delegated surface budget, keyed by egress IP and sized for the firm (OPS_PORTAL
// sends every user's calls from a small set of IPs). Applied before token
// verification; userApiLimiter then applies the per-person mutation budget.
const delegatedLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  max: Number(process.env.RATE_LIMIT_DELEGATED_MAX ?? 6000),
  keyGenerator: (req) => req.ip ?? 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  validate: { keyGeneratorIpFallback: false },
});

// ─── Request correlation ID ──────────────────────────────────────────────────

app.use((req, res, next) => {
  // A caller's correlation id is kept only when it is short and plain; otherwise it would land verbatim in logs.
  const given = req.headers['x-request-id'];
  req.requestId = typeof given === 'string' && /^[\w-]{1,64}$/.test(given) ? given : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
});

// ─── HTTP request logging ────────────────────────────────────────────────────

app.use(
  pinoHttp({
    logger,
    genReqId: (req) => (req as express.Request).requestId ?? randomUUID(),
    autoLogging: {
      ignore: (req) => req.url === '/api/health' || req.url === '/api/health/live',
    },
    customProps: (req) => ({ requestId: (req as express.Request).requestId }),
  }),
);

// ─── Core middleware ────────────────────────────────────────────────────────

const allowedOrigins = (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',').map((o) => o.trim());
app.use(cors({ origin: allowedOrigins, credentials: true, maxAge: 86400 }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.set('trust proxy', 1);

setupAuth(app);
app.use(attachDemoFlag);

// ─── Routes ─────────────────────────────────────────────────────────────────

// Service mode (ticket): frozen refuses user-originated writes; MCP-only refuses everything except
// MCP, its sign-in, standalone sign-in, Connected Apps and the static client. Deny by default, so a
// route added below is covered without being listed (serviceModeGuard.routes.test.ts enumerates them).
app.use(serviceModeGuard);

// The effective mode only, for the static client's banner and its MCP-only view. No session needed.
app.get('/api/service-mode', serviceModeRoute);

app.use('/auth', csrfProtection, authRoutes);

// Internal endpoints invoked by Cloud Scheduler. No session/CSRF — the router
// authenticates the Google-signed OIDC token on each request itself.
app.use('/api/internal', internalRoutes);

// Machine-to-machine read surface (OPS_PORTAL ops-portal-run@ SA). The router authenticates
// the Google-signed OIDC token on each request itself (requireMachineAuth) and
// NEVER reads req.user / isAuthenticated — so a browser session cannot reach it,
// a bearer token is mandatory. NOTE: setupAuth() installs session/passport
// GLOBALLY, so these requests do pass through that middleware (req.user may be
// populated if a cookie is present); requireMachineAuth simply ignores it. It is
// not CSRF-guarded: the one state-changing verb (PUT /service-mode, ticket)
// requires the bearer token and the controller identity, never a cookie. Do NOT
// add a code path here that trusts req.user — that would silently open a
// session-cookie route.
app.use('/api/machine', machineLimiter, requireMachineAuth, machineRoutes);

// Delegated surface for the Ops Portal Trade Requests workspace. requireDelegatedCaller
// verifies OPS_PORTAL's service-account token AND a per-call actor assertion, maps the
// person's Ops Portal role to trader/advisor, and sets req.user itself — overwriting
// anything a session cookie put there — so a browser session alone can never
// reach it. Bearer-only and cookie-free, hence no CSRF. Dark (503) until
// OPS_PORTAL_DELEGATED_AUDIENCE and OPS_PORTAL_DELEGATED_CALLER_SA are configured. Only the
// operations listed in routes/delegated.ts are reachable (404 otherwise).
app.use(
  '/api/ops-portal',
  delegatedLimiter,
  requireDelegatedOperation,
  requireDelegatedCaller,
  userApiLimiter,
  delegatedRoutes,
);

app.use('/api/clients', requireAuth, csrfProtection, userApiLimiter, clientRoutes);
app.use('/api/clients', requireAuth, csrfProtection, userApiLimiter, clientExclusionRoutes);
app.use('/api/drift', requireAuth, csrfProtection, userApiLimiter, driftRoutes);
app.use('/api/households', requireAuth, csrfProtection, userApiLimiter, householdRoutes);
app.use('/api/requests', requireAuth, csrfProtection, userApiLimiter, requestRoutes);
app.use('/api/notifications', requireAuth, csrfProtection, userApiLimiter, notificationRoutes);
app.use('/api/users', requireAuth, csrfProtection, userApiLimiter, userRoutes);
app.use('/api/me/mcp-sessions', requireAuth, csrfProtection, userApiLimiter, mcpSessionRoutes);
app.use('/api/me/mcp-tokens', requireAuth, csrfProtection, userApiLimiter, mcpTokenRoutes);
// The demo's outbox and stand-ins exist only when DEMO_STAND_INS=on (see .env.example).
const demoStandIns = process.env.DEMO_STAND_INS === 'on';
if (demoStandIns) app.use('/api/outbox', requireAuth, csrfProtection, userApiLimiter, outboxRoutes);

// MCP server (Model Context Protocol). Mounted at /mcp with its own OAuth 2.1
// Authorization Server endpoints at the app root. Bearer-auth only — sits
// outside /api so it bypasses the SPA's session-based CSRF middleware.
if (process.env.MCP_RESOURCE_URL && process.env.MCP_ISSUER_URL && process.env.MCP_GOOGLE_CALLBACK_URL) {
  setupMcp(app, {
    resourceUrl: process.env.MCP_RESOURCE_URL,
    issuerUrl: process.env.MCP_ISSUER_URL,
    googleCallbackUrl: process.env.MCP_GOOGLE_CALLBACK_URL,
    googleHd: process.env.MCP_GOOGLE_HD,
    devLoginEmail: process.env.DEV_LOGIN_EMAIL,
  });
} else {
  logger.info('MCP server disabled (set MCP_RESOURCE_URL, MCP_ISSUER_URL, MCP_GOOGLE_CALLBACK_URL to enable)');
}

// ─── API documentation (non-production only) ────────────────────────────────

import('./docs/openapi.js')
  .then(({ swaggerSpec }) =>
    import('swagger-ui-express').then((swaggerUi) => {
      const docsMiddleware = process.env.NODE_ENV === 'production' ? [requireAuth, requireRole('trader')] : [];
      app.use('/api/docs', ...docsMiddleware, swaggerUi.serve, swaggerUi.setup(swaggerSpec));
      logger.info('Swagger UI available at /api/docs');
    }),
  )
  .catch((err) => logger.warn({ err }, 'Failed to load Swagger UI'));

const clientErrorLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
app.post('/api/client-errors', clientErrorLimiter, requireAuth, csrfProtection, (req, res) => {
  const body = req.body ?? {};
  const sanitize = (v: unknown, max: number) =>
    String(v ?? '')
      .slice(0, max)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  logger.error(
    {
      type: 'client_error',
      userId: (req.user as AuthUser | undefined)?.id,
      error: sanitize(body.error, 2000),
      stack: sanitize(body.stack, 4000),
      componentStack: sanitize(body.componentStack, 4000),
      url: sanitize(body.url, 500),
      requestId: req.requestId,
    },
    'Client-side error reported',
  );
  res.status(204).send();
});

// ─── Production static serving ──────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (!existsSync(clientDist)) {
    logger.error({ clientDist }, 'Client dist not found; build the client first');
  } else {
    // Vite emits hashed filenames into /assets, so those bytes never change for
    // a given URL — cache them aggressively. index.html is the entry point and
    // must always be revalidated so deploys are picked up immediately.
    app.use(
      '/assets',
      express.static(path.join(clientDist, 'assets'), {
        immutable: true,
        maxAge: '1y',
      }),
    );
    app.use(
      express.static(clientDist, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get('/{*splat}', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }
}

app.use(errorHandler);

// ─── Start server with graceful shutdown ────────────────────────────────────

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Server running');
  startServiceModeRefresh();
  void startEngineUseCounting().catch((err) => logger.error({ err }, 'engine-use counting start failed'));
  if (demoStandIns) {
    startStandIns().catch((err) => {
      logger.fatal({ err }, 'demo stand-ins failed to start');
      process.exit(1);
    });
  }
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown signal received, shutting down gracefully');
  server.close(() => {
    flushEngineUse()
      .catch(() => 0)
      .then(() => pool.end())
      .then(() => logger.info('Server closed'))
      .catch((err) => logger.error({ err }, 'Error closing database pool'))
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  shutdown('uncaughtException');
});
