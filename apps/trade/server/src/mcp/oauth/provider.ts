import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import pool from '../../db/pool.js';
import { readSecret } from '../../lib/secrets.js';
import { personaSignInEnabled } from '../../demo/personas.js';
import logger from '../../lib/logger.js';
import {
  DbOAuthClientsStore,
  consumeAuthorizationCode,
  hasPatPrefix,
  insertPendingAuth,
  issueAccessToken,
  issueAuthorizationCode,
  issueRefreshToken,
  lookupAccessToken,
  lookupPat,
  lookupRefreshToken,
  newFamilyId,
  peekAuthorizationCode,
  revokeAccessToken,
  revokeFamily,
  revokeRefreshToken,
  rotateRefreshToken,
  touchPatLastUsed,
} from './store.js';

const ACCESS_TOKEN_TTL_S = Number(process.env.MCP_ACCESS_TOKEN_TTL_S ?? 60 * 60); // 1h
const REFRESH_TOKEN_TTL_S = Number(process.env.MCP_REFRESH_TOKEN_TTL_S ?? 60 * 60 * 24 * 30); // 30d
const SCOPE = 'mcp:read';

const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface ProviderConfig {
  /** Canonical resource URL for the MCP server, e.g. https://app.example.com/mcp. */
  resourceUrl: string;
  /** Where Google should redirect after upstream auth, e.g. https://app.example.com/oauth/google/callback. */
  googleCallbackUrl: string;
  /** Optional Google `hd` hint to limit account picker to your hosted domain. */
  googleHd?: string;
  /**
   * DEV-ONLY: when set AND `NODE_ENV !== 'production'`, the authorize endpoint
   * skips Google entirely and issues a code directly for the user with this
   * email. Production callers will throw at boot, see `assertDevLoginNotInProd`.
   */
  devLoginEmail?: string;
}

/** Throws if `DEV_LOGIN_EMAIL` is configured while running under `NODE_ENV=production`. */
export function assertDevLoginNotInProd(devLoginEmail: string | undefined): void {
  if (devLoginEmail && process.env.NODE_ENV === 'production') {
    throw new Error(
      'DEV_LOGIN_EMAIL is set but NODE_ENV=production. Refusing to start — this would expose an OAuth bypass.',
    );
  }
}

export class TradeRequestOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new DbOAuthClientsStore();

  constructor(private readonly config: ProviderConfig) {}

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!params.resource) {
      throw new InvalidRequestError('Missing resource parameter (RFC 8707 required)');
    }
    if (params.resource.toString() !== this.config.resourceUrl) {
      throw new InvalidRequestError(`Invalid resource: token can only be issued for ${this.config.resourceUrl}`);
    }

    // DEV-ONLY bypass: skip Google entirely and mint an authorization code
    // for the configured DEV_LOGIN_EMAIL. Gated by NODE_ENV check; setupMcp
    // additionally refuses to start if this is set under NODE_ENV=production.
    if (this.config.devLoginEmail && process.env.NODE_ENV !== 'production') {
      const userId = await lookupActiveUserIdByEmail(this.config.devLoginEmail);
      if (!userId) {
        throw new InvalidRequestError(`DEV_LOGIN_EMAIL ${this.config.devLoginEmail} does not match an active user`);
      }
      logger.warn(
        { devLoginEmail: this.config.devLoginEmail, clientId: client.client_id },
        'DEV LOGIN: skipping Google OAuth and minting code directly',
      );
      const code = await issueAuthorizationCode({
        clientId: client.client_id,
        userId,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        resource: params.resource.toString(),
        scope: (params.scopes ?? []).join(' ') || SCOPE,
      });
      const redirect = new URL(params.redirectUri);
      redirect.searchParams.set('code', code);
      if (params.state) redirect.searchParams.set('state', params.state);
      res.redirect(302, redirect.toString());
      return;
    }

    const upstreamState = randomBytes(24).toString('base64url');
    await insertPendingAuth({
      state: upstreamState,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      resource: params.resource.toString(),
      scope: (params.scopes ?? []).join(' ') || SCOPE,
      mcpState: params.state,
    });

    // The public demo has no Google: send the visitor to the persona picker, which completes this request
    // (POST /auth/persona with the state) by issuing the code for the persona they choose.
    if (personaSignInEnabled()) {
      const origin = (process.env.CLIENT_ORIGIN ?? '').split(',')[0]?.trim() || '';
      res.redirect(302, `${origin}/login?mcp=${encodeURIComponent(upstreamState)}`);
      return;
    }

    const googleClientId = readSecret('GOOGLE_CLIENT_ID');
    if (!googleClientId) throw new InvalidRequestError('GOOGLE_CLIENT_ID not configured');

    const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    url.searchParams.set('client_id', googleClientId);
    url.searchParams.set('redirect_uri', this.config.googleCallbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', upstreamState);
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    if (this.config.googleHd) url.searchParams.set('hd', this.config.googleHd);

    res.redirect(302, url.toString());
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = await peekAuthorizationCode(authorizationCode);
    if (!record) throw new InvalidGrantError('Invalid or expired authorization code');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const consumed = await consumeAuthorizationCode(authorizationCode);
    if (!consumed) throw new InvalidGrantError('Invalid or expired authorization code');

    if (consumed.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    if (redirectUri && redirectUri !== consumed.redirectUri) {
      throw new InvalidGrantError('redirect_uri mismatch');
    }
    if (resource && resource.toString() !== consumed.resource) {
      throw new InvalidGrantError('resource mismatch');
    }

    return this.mintTokenPair({
      familyId: newFamilyId(),
      clientId: consumed.clientId,
      userId: consumed.userId,
      audience: consumed.resource,
      scope: consumed.scope,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = await lookupRefreshToken(refreshToken);
    if (!record) throw new InvalidGrantError('Invalid refresh token');

    // Reuse detection: if the refresh token has already been rotated or revoked, an attacker
    // is replaying a stolen token. Revoke the entire family.
    if (record.rotatedTo || record.revokedAt) {
      logger.warn(
        { clientId: record.clientId, userId: record.userId, familyId: record.familyId },
        'Refresh token reuse detected; revoking token family',
      );
      await revokeFamily(record.familyId);
      throw new InvalidGrantError('Refresh token has been revoked');
    }

    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was issued to a different client');
    }
    if (resource && resource.toString() !== record.audience) {
      throw new InvalidGrantError('resource mismatch');
    }

    const newPair = await this.mintTokenPair({
      familyId: record.familyId,
      clientId: record.clientId,
      userId: record.userId,
      audience: record.audience,
      scope: record.scope,
    });

    // Mark the old refresh token as rotated. Single-use; presenting it again triggers the reuse check above.
    if (newPair.refresh_token) {
      await rotateRefreshToken(refreshToken, newPair.refresh_token);
    }

    return newPair;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    // PAT path. Branch on the prefix so we don't pay two DB lookups per
    // request, and do NOT fall through to OAuth on miss — a malformed/revoked
    // PAT is a hard reject.
    if (hasPatPrefix(token)) {
      const pat = await lookupPat(token);
      if (!pat) throw new InvalidGrantError('Invalid or expired token');
      // Fire-and-forget the last_used_at bump (debounced inside the helper);
      // don't block the response on this best-effort write.
      touchPatLastUsed(token).catch((err) => {
        logger.warn({ err, patId: pat.id }, 'Failed to update PAT last_used_at');
      });
      // PATs don't expire — revocation is the mechanism. The SDK's bearerAuth
      // middleware requires expiresAt to be a number, so we set a far-future
      // sentinel (year 2099). lookupPat already checks revoked_at.
      const FAR_FUTURE = Math.floor(new Date('2099-01-01T00:00:00Z').getTime() / 1000);
      return {
        token,
        clientId: 'pat',
        scopes: ['mcp:read'],
        expiresAt: FAR_FUTURE,
        resource: new URL(pat.audience),
        extra: { userId: pat.userId, patId: pat.id },
      };
    }

    const record = await lookupAccessToken(token);
    if (!record) throw new InvalidGrantError('Invalid or expired access token');
    return {
      token,
      clientId: record.clientId,
      scopes: record.scope.split(' ').filter(Boolean),
      expiresAt: Math.floor(record.expiresAt.getTime() / 1000),
      resource: new URL(record.audience),
      extra: { userId: record.userId },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    if (!request.token) return;
    const hint = request.token_type_hint;
    if (hint === 'refresh_token') {
      await revokeRefreshToken(request.token);
      return;
    }
    if (hint === 'access_token') {
      await revokeAccessToken(request.token);
      return;
    }
    // No hint — try both, ignore misses.
    await Promise.all([revokeAccessToken(request.token), revokeRefreshToken(request.token)]);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Mint an access+refresh pair against the given family. */
  private async mintTokenPair(params: {
    familyId: string;
    clientId: string;
    userId: string;
    audience: string;
    scope: string;
  }): Promise<OAuthTokens> {
    const access = await issueAccessToken({
      clientId: params.clientId,
      userId: params.userId,
      audience: params.audience,
      scope: params.scope,
      ttlSeconds: ACCESS_TOKEN_TTL_S,
    });
    const refresh = await issueRefreshToken({
      familyId: params.familyId,
      clientId: params.clientId,
      userId: params.userId,
      audience: params.audience,
      scope: params.scope,
      ttlSeconds: REFRESH_TOKEN_TTL_S,
    });
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refresh,
      scope: params.scope,
    };
  }

  /** Issue an authorization code after Google authentication; called from googleCallback. */
  async issueAuthorizationCodeForUser(input: {
    pendingState: string;
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scope: string;
  }): Promise<string> {
    return issueAuthorizationCode({
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      resource: input.resource,
      scope: input.scope,
    });
  }
}

async function lookupActiveUserIdByEmail(email: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND is_active = true',
    [email],
  );
  return rows[0]?.id ?? null;
}
