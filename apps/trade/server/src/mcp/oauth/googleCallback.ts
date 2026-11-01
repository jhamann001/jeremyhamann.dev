import type { Request, Response } from 'express';
import { decodeJwt } from 'jose';
import pool from '../../db/pool.js';
import logger from '../../lib/logger.js';
import { readSecret } from '../../lib/secrets.js';
import { ALLOWED_DOMAINS, mapRow } from '../../middleware/auth.js';
import { consumePendingAuth, issueAuthorizationCode } from './store.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

interface GoogleIdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  hd?: string;
}

export interface GoogleCallbackConfig {
  googleCallbackUrl: string;
}

/**
 * Handle Google's redirect after the upstream OAuth flow. Looks up the pending
 * MCP authorization, exchanges the Google code for an id_token, validates the
 * email domain, looks up the user, mints an MCP authorization code, and
 * redirects to the MCP client's redirect_uri.
 */
export function googleCallbackHandler(config: GoogleCallbackConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    const code = String(req.query.code ?? '');
    const state = String(req.query.state ?? '');
    const errorParam = req.query.error;

    if (errorParam) {
      logger.warn({ error: errorParam }, 'Google OAuth returned an error during MCP flow');
      res.status(400).send(`Google login failed: ${String(errorParam)}`);
      return;
    }

    if (!code || !state) {
      res.status(400).send('Missing code or state');
      return;
    }

    const pending = await consumePendingAuth(state);
    if (!pending) {
      res.status(400).send('Invalid or expired authorization request');
      return;
    }

    let claims: GoogleIdTokenClaims;
    try {
      claims = await exchangeGoogleCode(code, config.googleCallbackUrl);
    } catch (err) {
      logger.error({ err }, 'Failed to exchange Google authorization code');
      res.redirect(
        302,
        redirectWithError(pending.redirectUri, 'server_error', 'Google token exchange failed', pending.mcpState),
      );
      return;
    }

    const email = claims.email?.toLowerCase();
    const emailDomain = email?.split('@')[1];
    if (!email || !emailDomain || !ALLOWED_DOMAINS.includes(emailDomain) || claims.email_verified === false) {
      const domainList = ALLOWED_DOMAINS.map((d) => `@${d}`).join(' or ');
      res.redirect(
        302,
        redirectWithError(
          pending.redirectUri,
          'access_denied',
          `Only ${domainList} accounts are allowed`,
          pending.mcpState,
        ),
      );
      return;
    }

    const user = await findOrLinkUser({
      googleId: claims.sub,
      email,
      name: claims.name ?? email,
      picture: claims.picture ?? null,
    });

    if (!user) {
      res.redirect(
        302,
        redirectWithError(
          pending.redirectUri,
          'access_denied',
          'No account found. Please ask a trader to invite you before signing in.',
          pending.mcpState,
        ),
      );
      return;
    }

    const authorizationCode = await issueAuthorizationCode({
      clientId: pending.clientId,
      userId: user.id,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      scope: pending.scope,
    });

    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('code', authorizationCode);
    if (pending.mcpState) redirect.searchParams.set('state', pending.mcpState);
    res.redirect(302, redirect.toString());
  };
}

async function exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleIdTokenClaims> {
  const clientId = readSecret('GOOGLE_CLIENT_ID');
  const clientSecret = readSecret('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('GOOGLE_CLIENT_ID/SECRET not configured');

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google token endpoint returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error('Google response missing id_token');

  // The id_token is already validated by Google over a TLS connection from googleapis.com;
  // we trust the response transport and decode the claims.
  return decodeJwt(tokens.id_token) as GoogleIdTokenClaims;
}

interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
  picture: string | null;
}

async function findOrLinkUser(profile: GoogleProfile) {
  const byGoogleId = await pool.query(
    'SELECT id, google_id, email, name, picture, role, slack_user_id, theme_preference, is_active, last_login, created_at FROM users WHERE google_id = $1',
    [profile.googleId],
  );

  if (byGoogleId.rows.length > 0) {
    const row = byGoogleId.rows[0];
    if (!row.is_active) return null;
    await pool.query('UPDATE users SET last_login = NOW(), name = $1, picture = $2 WHERE id = $3', [
      profile.name,
      profile.picture,
      row.id,
    ]);
    return mapRow({ ...row, name: profile.name, picture: profile.picture, last_login: new Date().toISOString() });
  }

  const byEmail = await pool.query(
    'SELECT id, google_id, email, name, picture, role, slack_user_id, theme_preference, is_active, last_login, created_at FROM users WHERE email = $1',
    [profile.email],
  );

  if (byEmail.rows.length === 0) return null;
  const row = byEmail.rows[0];
  if (!row.is_active) return null;

  await pool.query('UPDATE users SET google_id = $1, name = $2, picture = $3, last_login = NOW() WHERE id = $4', [
    profile.googleId,
    profile.name,
    profile.picture,
    row.id,
  ]);

  return mapRow({
    ...row,
    google_id: profile.googleId,
    name: profile.name,
    picture: profile.picture,
    last_login: new Date().toISOString(),
  });
}

function redirectWithError(redirectUri: string, error: string, description: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}
