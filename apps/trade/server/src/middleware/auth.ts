import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Express, Request, Response, NextFunction } from 'express';
import type { AuthChannel, AuthUser, UserRole, ThemePreference } from '@trade-request/shared';
import pool from '../db/pool.js';
import { sendError } from './errorHandler.js';
import { readSecret } from '../lib/secrets.js';

declare module 'express-session' {
  interface SessionData {
    demo?: boolean;
    csrfToken?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      isDemo?: boolean;
      /** Set to 'opsPortal' only by requireDelegatedCaller after both identities are verified. */
      authChannel?: AuthChannel;
      /** Verified service-account email, set only by requireMachineAuth. */
      machineCaller?: string;
    }
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends AuthUser {}
  }
}

const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAIN ?? 'example.com,example.org')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

// ─── Validate required env vars at import time ──────────────────────────────

const GOOGLE_CLIENT_ID = readSecret('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = readSecret('GOOGLE_CLIENT_SECRET');
const SESSION_SECRET_VALUE = readSecret('SESSION_SECRET');
// Google sign-in may be left unconfigured only when persona sign-in (the public demo) replaces it.
const PERSONA_SIGN_IN = process.env.PERSONA_SIGN_IN === 'on';
for (const [name, val] of Object.entries({
  ...(PERSONA_SIGN_IN ? {} : { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET }),
  SESSION_SECRET: SESSION_SECRET_VALUE,
})) {
  if (!val) throw new Error(`Missing required secret: ${name}`);
}

/** Google sign-in is offered only when its client is configured. */
export const googleSignInEnabled = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

if (googleSignInEnabled) passport.use(
  new GoogleStrategy(
    {
      clientID: GOOGLE_CLIENT_ID!,
      clientSecret: GOOGLE_CLIENT_SECRET!,
      callbackURL: process.env.GOOGLE_CALLBACK_URL ?? '/auth/google/callback',
      state: true,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        const emailDomain = email?.split('@')[1]?.toLowerCase();
        if (!email || !emailDomain || !ALLOWED_DOMAINS.includes(emailDomain)) {
          const domainList = ALLOWED_DOMAINS.map((d) => `@${d}`).join(' or ');
          return done(null, false, { message: `Only ${domainList} accounts are allowed` });
        }

        // Returning users: match by google_id
        const byGoogleId = await pool.query(
          'SELECT id, google_id, email, name, picture, role, slack_user_id, theme_preference, is_active, last_login, created_at FROM users WHERE google_id = $1',
          [profile.id],
        );

        let user: AuthUser;

        if (byGoogleId.rows.length > 0) {
          const row = byGoogleId.rows[0];
          if (!row.is_active) {
            return done(null, false, { message: 'Account has been deactivated' });
          }
          await pool.query('UPDATE users SET last_login = NOW(), name = $1, picture = $2 WHERE id = $3', [
            profile.displayName,
            profile.photos?.[0]?.value ?? null,
            row.id,
          ]);
          user = mapRow({
            ...row,
            name: profile.displayName,
            picture: profile.photos?.[0]?.value ?? null,
            last_login: new Date().toISOString(),
          });
        } else {
          // Invited user row (email present, google_id null) or brand-new sign-up
          const byEmail = await pool.query(
            'SELECT id, google_id, email, name, picture, role, slack_user_id, theme_preference, is_active, last_login, created_at FROM users WHERE email = $1',
            [email],
          );

          if (byEmail.rows.length > 0) {
            const row = byEmail.rows[0];
            if (!row.is_active) {
              return done(null, false, { message: 'Account has been deactivated' });
            }
            await pool.query(
              'UPDATE users SET google_id = $1, name = $2, picture = $3, last_login = NOW() WHERE id = $4',
              [profile.id, profile.displayName, profile.photos?.[0]?.value ?? null, row.id],
            );
            user = mapRow({
              ...row,
              google_id: profile.id,
              name: profile.displayName,
              picture: profile.photos?.[0]?.value ?? null,
              last_login: new Date().toISOString(),
            });
          } else {
            return done(null, false, {
              message: 'No account found. Please ask a trader to invite you before signing in.',
            });
          }
        }

        return done(null, user);
      } catch (err) {
        return done(err as Error);
      }
    },
  ),
);

passport.serializeUser((user, done) => {
  done(null, (user as AuthUser).id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const result = await pool.query(
      'SELECT id, google_id, email, name, picture, role, slack_user_id, theme_preference, is_active, last_login, created_at FROM users WHERE id = $1 AND is_active = true',
      [id],
    );
    if (result.rows.length === 0) return done(null, false);
    done(null, mapRow(result.rows[0]));
  } catch (err) {
    done(err);
  }
});

/** Maps a DB row to AuthUser. After Google OAuth, google_id is always set; list/invite APIs may return null until first login. */
function mapRow(row: Record<string, unknown>): AuthUser {
  return {
    id: row.id as string,
    googleId: (row.google_id as string) ?? null,
    email: row.email as string,
    name: row.name as string,
    picture: (row.picture as string) ?? null,
    role: row.role as UserRole,
    slackUserId: (row.slack_user_id as string) ?? null,
    themePreference: ((row.theme_preference as string) ?? 'system') as ThemePreference,
    isActive: row.is_active as boolean,
    lastLogin: row.last_login ? String(row.last_login) : null,
    createdAt: String(row.created_at),
  };
}

export const SESSION_COOKIE_NAME = '__session';

export function setupAuth(app: Express): void {
  const PgStore = connectPgSimple(session);

  app.use(
    session({
      store: new PgStore({ pool, tableName: 'session', pruneSessionInterval: 60 * 15 }),
      name: SESSION_COOKIE_NAME,
      secret: SESSION_SECRET_VALUE!,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        maxAge: Number(process.env.SESSION_MAX_AGE_MS ?? 60 * 60 * 1000),
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'strict',
      },
    }),
  );

  app.use(passport.initialize());
  app.use(passport.session());
}

/** True only for /api/ops-portal calls that passed requireDelegatedCaller (never for a browser session). */
function isDelegated(req: Request): boolean {
  return req.authChannel === 'opsPortal' && !!req.user;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isDelegated(req) || (req.isAuthenticated?.() && req.user)) {
    next();
  } else {
    sendError(res, 401, 'Authentication required');
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isDelegated(req) && (!req.isAuthenticated?.() || !req.user)) {
      sendError(res, 401, 'Authentication required');
      return;
    }
    const user = req.user as AuthUser;
    if (!roles.includes(user.role)) {
      sendError(res, 403, 'Insufficient permissions');
      return;
    }
    next();
  };
}

export { ALLOWED_DOMAINS, mapRow };
