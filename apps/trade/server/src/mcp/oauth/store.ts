import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import pool from '../../db/pool.js';

// ─── Token primitives ───────────────────────────────────────────────────────

/** Generate a 256-bit random opaque token. Returned as URL-safe base64. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

// ─── Clients store ──────────────────────────────────────────────────────────

interface ClientRow {
  id: string;
  client_secret_hash: Buffer | null;
  redirect_uris: string[];
  client_name: string | null;
  created_at: Date;
}

function rowToClient(row: ClientRow): OAuthClientInformationFull {
  return {
    client_id: row.id,
    redirect_uris: row.redirect_uris,
    client_name: row.client_name ?? undefined,
    client_id_issued_at: Math.floor(row.created_at.getTime() / 1000),
    token_endpoint_auth_method: row.client_secret_hash ? 'client_secret_basic' : 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  } as OAuthClientInformationFull;
}

export class DbOAuthClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const { rows } = await pool.query<ClientRow>('SELECT * FROM oauth_clients WHERE id = $1', [clientId]);
    return rows[0] ? rowToClient(rows[0]) : undefined;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    const id = `mcp_${randomBytes(12).toString('base64url')}`;
    await pool.query(
      `INSERT INTO oauth_clients (id, client_secret_hash, redirect_uris, client_name)
       VALUES ($1, NULL, $2, $3)`,
      [id, client.redirect_uris, client.client_name ?? null],
    );
    return {
      ...client,
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
    } as OAuthClientInformationFull;
  }
}

// ─── Pending authorization ──────────────────────────────────────────────────

export interface PendingAuth {
  state: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  mcpState?: string;
}

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export async function insertPendingAuth(p: PendingAuth): Promise<void> {
  await pool.query(
    `INSERT INTO mcp_pending_auth (state, client_id, redirect_uri, code_challenge, resource, scope, mcp_state, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + INTERVAL '${PENDING_AUTH_TTL_MS} milliseconds')`,
    [p.state, p.clientId, p.redirectUri, p.codeChallenge, p.resource, p.scope, p.mcpState ?? null],
  );
}

export async function consumePendingAuth(state: string): Promise<PendingAuth | null> {
  const { rows } = await pool.query<{
    state: string;
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    resource: string;
    scope: string;
    mcp_state: string | null;
  }>(
    `DELETE FROM mcp_pending_auth
     WHERE state = $1 AND expires_at > NOW()
     RETURNING state, client_id, redirect_uri, code_challenge, resource, scope, mcp_state`,
    [state],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    state: r.state,
    clientId: r.client_id,
    redirectUri: r.redirect_uri,
    codeChallenge: r.code_challenge,
    resource: r.resource,
    scope: r.scope,
    mcpState: r.mcp_state ?? undefined,
  };
}

// ─── Authorization codes ────────────────────────────────────────────────────

export interface IssueAuthCodeInput {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
}

const AUTH_CODE_TTL_MS = 30 * 1000;

export async function issueAuthorizationCode(input: IssueAuthCodeInput): Promise<string> {
  const code = generateToken();
  await pool.query(
    `INSERT INTO oauth_authorization_codes
       (code_hash, client_id, user_id, redirect_uri, code_challenge, resource, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW() + INTERVAL '${AUTH_CODE_TTL_MS} milliseconds')`,
    [
      hashToken(code),
      input.clientId,
      input.userId,
      input.redirectUri,
      input.codeChallenge,
      input.resource,
      input.scope,
    ],
  );
  return code;
}

export interface AuthCodeRecord {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
}

export async function peekAuthorizationCode(code: string): Promise<AuthCodeRecord | null> {
  const { rows } = await pool.query<{
    client_id: string;
    user_id: string;
    redirect_uri: string;
    code_challenge: string;
    resource: string;
    scope: string;
  }>(
    `SELECT client_id, user_id, redirect_uri, code_challenge, resource, scope
     FROM oauth_authorization_codes
     WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()`,
    [hashToken(code)],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    clientId: r.client_id,
    userId: r.user_id,
    redirectUri: r.redirect_uri,
    codeChallenge: r.code_challenge,
    resource: r.resource,
    scope: r.scope,
  };
}

export async function consumeAuthorizationCode(code: string): Promise<AuthCodeRecord | null> {
  const { rows } = await pool.query<{
    client_id: string;
    user_id: string;
    redirect_uri: string;
    code_challenge: string;
    resource: string;
    scope: string;
  }>(
    `UPDATE oauth_authorization_codes
     SET consumed_at = NOW()
     WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
     RETURNING client_id, user_id, redirect_uri, code_challenge, resource, scope`,
    [hashToken(code)],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    clientId: r.client_id,
    userId: r.user_id,
    redirectUri: r.redirect_uri,
    codeChallenge: r.code_challenge,
    resource: r.resource,
    scope: r.scope,
  };
}

// ─── Access tokens ──────────────────────────────────────────────────────────

export interface IssueAccessTokenInput {
  clientId: string;
  userId: string;
  audience: string;
  scope: string;
  ttlSeconds: number;
}

export async function issueAccessToken(input: IssueAccessTokenInput): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  await pool.query(
    `INSERT INTO oauth_access_tokens (token_hash, client_id, user_id, audience, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [hashToken(token), input.clientId, input.userId, input.audience, input.scope, expiresAt],
  );
  return { token, expiresAt };
}

export interface AccessTokenRecord {
  clientId: string;
  userId: string;
  audience: string;
  scope: string;
  expiresAt: Date;
}

export async function lookupAccessToken(token: string): Promise<AccessTokenRecord | null> {
  const { rows } = await pool.query<{
    client_id: string;
    user_id: string;
    audience: string;
    scope: string;
    expires_at: Date;
  }>(
    `SELECT client_id, user_id, audience, scope, expires_at
     FROM oauth_access_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [hashToken(token)],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    clientId: r.client_id,
    userId: r.user_id,
    audience: r.audience,
    scope: r.scope,
    expiresAt: r.expires_at,
  };
}

export async function revokeAccessToken(token: string): Promise<void> {
  await pool.query(`UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`, [
    hashToken(token),
  ]);
}

// ─── Refresh tokens ─────────────────────────────────────────────────────────

export interface IssueRefreshTokenInput {
  familyId: string;
  clientId: string;
  userId: string;
  audience: string;
  scope: string;
  ttlSeconds: number;
}

export async function issueRefreshToken(input: IssueRefreshTokenInput): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  await pool.query(
    `INSERT INTO oauth_refresh_tokens (token_hash, family_id, client_id, user_id, audience, scope, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [hashToken(token), input.familyId, input.clientId, input.userId, input.audience, input.scope, expiresAt],
  );
  return token;
}

export interface RefreshTokenRecord {
  familyId: string;
  clientId: string;
  userId: string;
  audience: string;
  scope: string;
  rotatedTo: Buffer | null;
  revokedAt: Date | null;
}

export async function lookupRefreshToken(token: string): Promise<RefreshTokenRecord | null> {
  const { rows } = await pool.query<{
    family_id: string;
    client_id: string;
    user_id: string;
    audience: string;
    scope: string;
    rotated_to: Buffer | null;
    revoked_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT family_id, client_id, user_id, audience, scope, rotated_to, revoked_at, expires_at
     FROM oauth_refresh_tokens
     WHERE token_hash = $1`,
    [hashToken(token)],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  if (r.expires_at.getTime() <= Date.now()) return null;
  return {
    familyId: r.family_id,
    clientId: r.client_id,
    userId: r.user_id,
    audience: r.audience,
    scope: r.scope,
    rotatedTo: r.rotated_to,
    revokedAt: r.revoked_at,
  };
}

export async function rotateRefreshToken(oldToken: string, newToken: string): Promise<void> {
  await pool.query(`UPDATE oauth_refresh_tokens SET rotated_to = $1 WHERE token_hash = $2 AND rotated_to IS NULL`, [
    hashToken(newToken),
    hashToken(oldToken),
  ]);
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await pool.query(`UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL`, [
    hashToken(token),
  ]);
}

/** Revoke an entire refresh-token family and all access tokens issued to its user/client. */
export async function revokeFamily(familyId: string): Promise<void> {
  const txClient = await pool.connect();
  try {
    await txClient.query('BEGIN');
    const { rows } = await txClient.query<{ user_id: string; client_id: string }>(
      `UPDATE oauth_refresh_tokens
       SET revoked_at = NOW()
       WHERE family_id = $1 AND revoked_at IS NULL
       RETURNING user_id, client_id`,
      [familyId],
    );
    if (rows.length > 0) {
      const { user_id, client_id } = rows[0];
      await txClient.query(
        `UPDATE oauth_access_tokens
         SET revoked_at = NOW()
         WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
        [user_id, client_id],
      );
    }
    await txClient.query('COMMIT');
  } catch (err) {
    await txClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    txClient.release();
  }
}

export function newFamilyId(): string {
  return randomUUID();
}

// ─── Personal Access Tokens (PATs) ──────────────────────────────────────────
//
// Long-lived bearer tokens generated from the SPA UI for MCP clients that
// can't speak OAuth (Claude Desktop today). Cleartext format is
// `tr_pat_<base64url(32)>` so the bearer middleware can disambiguate from
// OAuth tokens with a single string prefix check, no extra DB lookup.

export const PAT_PREFIX = 'tr_pat_';

export function generatePat(): string {
  return `${PAT_PREFIX}${generateToken()}`;
}

export function hasPatPrefix(token: string): boolean {
  return token.startsWith(PAT_PREFIX);
}

export interface IssuePatInput {
  userId: string;
  name: string;
  audience: string;
}

export interface PatMetadata {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function issuePat(input: IssuePatInput): Promise<{ id: string; token: string; createdAt: Date }> {
  const token = generatePat();
  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO mcp_pats (user_id, token_hash, name, audience)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [input.userId, hashToken(token), input.name, input.audience],
  );
  return { id: rows[0].id, token, createdAt: rows[0].created_at };
}

export interface PatRecord {
  id: string;
  userId: string;
  audience: string;
  lastUsedAt: Date | null;
}

/** Look up a PAT by its cleartext value. Returns null when missing, revoked, or hash mismatch. */
export async function lookupPat(token: string): Promise<PatRecord | null> {
  if (!hasPatPrefix(token)) return null;
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    audience: string;
    last_used_at: Date | null;
  }>(
    `SELECT id, user_id, audience, last_used_at
     FROM mcp_pats
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    userId: r.user_id,
    audience: r.audience,
    lastUsedAt: r.last_used_at,
  };
}

const PAT_TOUCH_DEBOUNCE_MS = 60 * 1000;

/**
 * Update last_used_at to NOW() if the previous value is older than the debounce
 * window (or null). Skips the write entirely otherwise to keep the /mcp hot
 * path cheap. Single SQL statement — race-free under concurrent updates.
 */
export async function touchPatLastUsed(token: string): Promise<void> {
  await pool.query(
    `UPDATE mcp_pats
     SET last_used_at = NOW()
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '${PAT_TOUCH_DEBOUNCE_MS} milliseconds')`,
    [hashToken(token)],
  );
}

export async function listPatsForUser(userId: string): Promise<PatMetadata[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    created_at: Date;
    last_used_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, created_at, last_used_at, revoked_at
     FROM mcp_pats
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}

/** Revoke a single PAT. Returns true if a row was actually updated (i.e. it existed and wasn't already revoked). */
export async function revokePat(id: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE mcp_pats SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}

/** Revoke every active PAT for a user (called from the deactivate cascade). Returns the count revoked. */
export async function revokePatsForUser(userId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE mcp_pats SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  return rowCount ?? 0;
}

/**
 * Revoke every active OAuth family (refresh + access tokens) for a user.
 * Used by the deactivate cascade alongside revokePatsForUser. Returns the
 * count of refresh tokens revoked (access tokens are revoked under the same
 * UPDATE — count there is opaque to callers).
 */
export async function revokeOAuthForUser(userId: string): Promise<number> {
  const txClient = await pool.connect();
  try {
    await txClient.query('BEGIN');
    const { rowCount: refreshCount } = await txClient.query(
      `UPDATE oauth_refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await txClient.query(
      `UPDATE oauth_access_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    await txClient.query('COMMIT');
    return refreshCount ?? 0;
  } catch (err) {
    await txClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    txClient.release();
  }
}
