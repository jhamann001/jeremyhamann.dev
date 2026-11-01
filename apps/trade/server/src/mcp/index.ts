import type { Express } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { AuthUser } from '@trade-request/shared';
import logger from '../lib/logger.js';
import pool from '../db/pool.js';
import { ALLOWED_DOMAINS, mapRow } from '../middleware/auth.js';
import { TradeRequestOAuthProvider, assertDevLoginNotInProd } from './oauth/provider.js';
import { googleCallbackHandler } from './oauth/googleCallback.js';
import { registerTools } from './tools.js';
import { opsPortalRecordsConfigured } from '../db/opsPortalRecords.js';

interface McpSetupConfig {
  /** Canonical resource URL for the MCP server, e.g. `https://app.example.com/mcp`. */
  resourceUrl: string;
  /** Canonical issuer URL for the AS, typically the server's origin (e.g. `https://app.example.com`). */
  issuerUrl: string;
  /** Where Google should redirect after upstream auth, e.g. `https://app.example.com/oauth/google/callback`. */
  googleCallbackUrl: string;
  /** Optional Google `hd` hint to limit the account picker to this hosted domain. */
  googleHd?: string;
  /**
   * DEV-ONLY: when set AND `NODE_ENV !== 'production'`, MCP authorize skips
   * Google entirely and mints a code directly for the matching active user.
   * Refuses to start if set under `NODE_ENV=production`.
   */
  devLoginEmail?: string;
}

/**
 * Mount the MCP server, OAuth 2.1 Authorization Server endpoints, and the
 * Google upstream callback on the given Express app.
 *
 * Endpoints exposed:
 *   GET  /.well-known/oauth-authorization-server   (AS metadata)
 *   GET  /.well-known/oauth-protected-resource     (RS metadata, includes /mcp path)
 *   POST /register                                  (RFC 7591 DCR)
 *   GET  /authorize                                 (delegates to Google)
 *   POST /token                                     (code/refresh exchange)
 *   POST /revoke                                    (RFC 7009)
 *   GET  /oauth/google/callback                     (upstream callback)
 *   POST /mcp                                       (Streamable HTTP MCP, Bearer-auth required)
 *   GET  /mcp                                       (SSE)
 *
 * All endpoints sit outside `/api` to bypass session-based CSRF middleware.
 */
export function setupMcp(app: Express, config: McpSetupConfig): void {
  // Hard-fail at startup if a dev bypass is configured under NODE_ENV=production.
  assertDevLoginNotInProd(config.devLoginEmail);
  if (config.devLoginEmail) {
    logger.warn(
      { devLoginEmail: config.devLoginEmail },
      'MCP DEV LOGIN ENABLED — Google OAuth will be skipped for this email. Do not run with this set in production.',
    );
  }

  const provider = new TradeRequestOAuthProvider({
    resourceUrl: config.resourceUrl,
    googleCallbackUrl: config.googleCallbackUrl,
    googleHd: config.googleHd ?? ALLOWED_DOMAINS[0],
    devLoginEmail: config.devLoginEmail,
  });

  // Standard OAuth endpoints (metadata + register + authorize + token + revoke).
  // Mounted at the application root so the well-known URLs sit at `/.well-known/...`.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.issuerUrl),
      resourceServerUrl: new URL(config.resourceUrl),
      scopesSupported: ['mcp:read'],
      resourceName: 'Trade Request',
    }),
  );

  // Upstream Google callback. Sits OUTSIDE `/auth` so the existing SPA login flow at
  // `/auth/google/callback` is untouched. Receives `?code=&state=`, exchanges with
  // Google, mints an MCP authorization code, and redirects to the MCP client.
  app.get('/oauth/google/callback', googleCallbackHandler({ googleCallbackUrl: config.googleCallbackUrl }));

  // Bearer auth middleware. Validates the access token and sets `req.auth`. The
  // SDK's StreamableHTTP transport reads `req.auth` and passes it through to
  // tool callbacks as `extra.authInfo`.
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: ['mcp:read'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(config.resourceUrl)),
  });

  // Stateless mode: per the SDK's recommended pattern, instantiate a fresh
  // McpServer + transport per request. Keeping a single shared instance breaks
  // because the McpServer transitions to a "post-initialize" state on the first
  // request and rejects subsequent ones.
  app.post('/mcp', bearer, async (req, res) => {
    const server = new McpServer({ name: 'trade-request', version: '1.0.0' });
    registerTools(server, resolveUserFromExtra);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, 'MCP request failed');
      if (!res.headersSent) res.status(500).end();
    }
  });

  // GET /mcp would be the SSE long-poll for server-initiated notifications,
  // which requires session state. We're stateless, so disallow.
  app.get('/mcp', bearer, (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed in stateless mode.' },
      id: null,
    });
  });

  logger.info(
    { resourceUrl: config.resourceUrl, issuerUrl: config.issuerUrl, opsPortalRecords: opsPortalRecordsConfigured() },
    'MCP server mounted at /mcp',
  );
}

/**
 * Look up the AuthUser referenced by the validated access token. Re-checks
 * `is_active` and the email domain on every call — we don't trust the snapshot
 * taken when the token was minted.
 */
async function resolveUserFromExtra(extra: RequestHandlerExtra<never, never>): Promise<AuthUser> {
  const userId = extra.authInfo?.extra?.userId;
  if (typeof userId !== 'string') throw new Error('Token has no associated user');

  const { rows } = await pool.query(
    'SELECT id, google_id, email, name, picture, role, slack_user_id, theme_preference, is_active, last_login, created_at FROM users WHERE id = $1',
    [userId],
  );
  if (rows.length === 0) throw new Error('User not found');
  const row = rows[0];
  if (!row.is_active) throw new Error('Account has been deactivated');

  const emailDomain = String(row.email).split('@')[1]?.toLowerCase() ?? '';
  if (!ALLOWED_DOMAINS.includes(emailDomain)) {
    throw new Error('Account domain is no longer allowed');
  }

  return mapRow(row);
}
