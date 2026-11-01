import { Router } from 'express';
import passport from 'passport';
import type { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '@trade-request/shared';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { requireAuth, ALLOWED_DOMAINS, SESSION_COOKIE_NAME, mapRow, googleSignInEnabled } from '../middleware/auth.js';
import { canonicalPersonaEmail, listPersonas, personaSignInEnabled } from '../demo/personas.js';
import { consumePendingAuth, issueAuthorizationCode } from '../mcp/oauth/store.js';
import { sendError } from '../middleware/errorHandler.js';
import pool from '../db/pool.js';
import logger from '../lib/logger.js';

const router = Router();

const SESSION_TTL_MS = Number(process.env.SESSION_MAX_AGE_MS ?? 60 * 60 * 1000);

const DEMO_ALLOWED_EMAILS = (process.env.DEMO_ALLOWED_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

router.get('/config', requireAuth, (_req: Request, res: Response) => {
  res.json({ allowedDomains: ALLOWED_DOMAINS, sessionTtlMs: SESSION_TTL_MS });
});

/** What the sign-in page offers: Google, demo personas, or both. Public. */
router.get('/sign-in-options', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ google: googleSignInEnabled, personas: personaSignInEnabled() ? await listPersonas() : [] });
  } catch (err) {
    next(err);
  }
});

// Each persona sign-in writes a session row; 20 per 15 minutes per visitor is plenty for trying the roles.
const personaSignInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_PERSONA_MAX ?? 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-ins, please try again in a few minutes.' },
});

const personaSchema = z.object({
  email: z.string().email().max(255),
  /** Set when an MCP client's authorization request sent the visitor here (see the OAuth provider). */
  mcpState: z.string().min(1).max(200).optional(),
});

/** Demo only: sign in as one of the firm's personas, with no password. */
router.post('/persona', personaSignInLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!personaSignInEnabled()) {
      sendError(res, 404, 'Not found');
      return;
    }
    const { email: requested, mcpState } = personaSchema.parse(req.body);
    const email = canonicalPersonaEmail(requested);
    if (!email) {
      sendError(res, 403, 'That is not one of the demo personas');
      return;
    }
    const result = await pool.query(
      'SELECT id, google_id, email, name, picture, role, slack_user_id, theme_preference, is_active, last_login, created_at FROM users WHERE email = $1 AND is_active = true',
      [email],
    );
    if (result.rows.length === 0) {
      sendError(res, 404, 'That persona is not available right now');
      return;
    }
    // An MCP client's one-time request is consumed only once the persona is known to be available.
    const pending = mcpState ? await consumePendingAuth(mcpState) : null;
    if (mcpState && !pending) {
      sendError(res, 400, 'This connection request has expired. Start connecting again from your MCP client.');
      return;
    }
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [result.rows[0].id]);
    const userData = mapRow(result.rows[0]);
    // An MCP client's request: issue its authorization code for this persona and send the browser back to it.
    let redirect: string | undefined;
    if (pending) {
      const code = await issueAuthorizationCode({
        clientId: pending.clientId,
        userId: userData.id,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        resource: pending.resource,
        scope: pending.scope,
      });
      const url = new URL(pending.redirectUri);
      url.searchParams.set('code', code);
      if (pending.mcpState) url.searchParams.set('state', pending.mcpState);
      redirect = url.toString();
    }
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.login(userData, (loginErr) => {
        if (loginErr) return next(loginErr);
        res.json(redirect ? { ...userData, redirect } : userData);
      });
    });
  } catch (err) {
    next(err);
  }
});

// Google's routes answer 404 when Google sign-in isn't configured (the demo).
router.use(['/google', '/google/callback'], (_req: Request, res: Response, next: NextFunction) => {
  if (googleSignInEnabled) next();
  else sendError(res, 404, 'Google sign-in is not configured');
});

router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
  }),
);

router.get(
  '/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=unauthorized' }),
  (req: Request, res: Response) => {
    const userData = req.user;
    req.session.regenerate((err) => {
      if (err) {
        logger.error({ err }, 'Session regeneration failed after OAuth login');
        res.redirect('/login?error=unauthorized');
        return;
      }
      req.login(userData!, (loginErr) => {
        if (loginErr) {
          logger.error({ err: loginErr }, 'Re-login after session regeneration failed');
          res.redirect('/login?error=unauthorized');
          return;
        }
        res.redirect('/');
      });
    });
  },
);

/**
 * DEV-ONLY: skip Google OAuth and log in directly as the user whose email
 * matches `DEV_LOGIN_EMAIL`. Mirrors the MCP-side bypass in
 * `server/src/mcp/oauth/provider.ts` so local development doesn't require a
 * valid Google OAuth client. Doubly-gated: this handler 404s unless BOTH
 *
 *   1. `NODE_ENV !== 'production'`, AND
 *   2. `DEV_LOGIN_EMAIL` is set to a non-empty value.
 *
 * A boot-time guard in `server/src/index.ts` additionally refuses to start
 * the server if these are configured together in production. Never log the
 * request body — only the resolved email (which is itself a config value,
 * not user input).
 */
router.get('/dev-login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const devEmail = process.env.DEV_LOGIN_EMAIL;
    if (process.env.NODE_ENV === 'production' || !devEmail) {
      res.status(404).send('Not found');
      return;
    }

    const result = await pool.query(
      'SELECT id, google_id, email, name, picture, role, slack_user_id, theme_preference, is_active, last_login, created_at FROM users WHERE LOWER(email) = LOWER($1) AND is_active = true',
      [devEmail],
    );
    if (result.rows.length === 0) {
      logger.warn({ devEmail }, 'DEV LOGIN: no active user matches DEV_LOGIN_EMAIL');
      res.status(404).send(`No active user matches DEV_LOGIN_EMAIL=${devEmail}`);
      return;
    }
    const userData = mapRow(result.rows[0]);
    logger.warn({ devEmail, userId: userData.id }, 'DEV LOGIN: skipping Google OAuth and logging in directly');

    // In dev the React app runs on the Vite server (CLIENT_ORIGIN, default
    // http://localhost:5173) while this Express server runs on :8080.
    // Redirecting to `/` would land on the bare Express server. The session
    // cookie is host-scoped (localhost, port-agnostic) so it carries across.
    const postLoginRedirect = (process.env.CLIENT_ORIGIN ?? '').split(',')[0]?.trim() || '/';
    req.session.regenerate((err) => {
      if (err) {
        logger.error({ err }, 'DEV LOGIN: session regeneration failed');
        res.redirect('/login?error=unauthorized');
        return;
      }
      req.login(userData, (loginErr) => {
        if (loginErr) {
          logger.error({ err: loginErr }, 'DEV LOGIN: req.login failed after session regeneration');
          res.redirect('/login?error=unauthorized');
          return;
        }
        res.redirect(postLoginRedirect);
      });
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req: Request, res: Response) => {
  const user = req.user as AuthUser;
  res.json({
    ...user,
    demo: req.session.demo ?? false,
    canDemo: DEMO_ALLOWED_EMAILS.includes(user.email.toLowerCase()),
    outbox: process.env.DEMO_STAND_INS === 'on',
  });
});

router.post('/demo', requireAuth, (req: Request, res: Response) => {
  const user = req.user as AuthUser;
  if (!DEMO_ALLOWED_EMAILS.includes(user.email.toLowerCase())) {
    sendError(res, 403, 'Demo mode is not available for this account');
    return;
  }
  req.session.demo = !req.session.demo;
  res.json({ demo: req.session.demo });
});

router.post('/extend-session', requireAuth, (req: Request, res: Response) => {
  req.session.touch();
  res.json({ ok: true });
});

const preferencesSchema = z.object({
  themePreference: z.enum(['light', 'dark', 'system']),
});

router.patch('/preferences', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { themePreference } = preferencesSchema.parse(req.body);
    const user = req.user as AuthUser;
    const result = await pool.query('UPDATE users SET theme_preference = $1 WHERE id = $2 RETURNING *', [
      themePreference,
      user.id,
    ]);
    const updated = mapRow(result.rows[0]);
    req.login(updated, (err) => {
      if (err) return next(err);
      res.json(updated);
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req: Request, res: Response) => {
  req.logout((err) => {
    if (err) {
      sendError(res, 500, 'Logout failed');
      return;
    }
    req.session.destroy((destroyErr) => {
      if (destroyErr) logger.error({ err: destroyErr }, 'Session destroy error');
      res.clearCookie(SESSION_COOKIE_NAME);
      res.json({ ok: true });
    });
  });
});

export default router;
