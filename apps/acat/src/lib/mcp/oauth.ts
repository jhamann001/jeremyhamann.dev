import { prisma } from "@/lib/prisma";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  getAppBaseUrl,
  getMcpPublicUrl,
  isAllowedRedirectUri,
  isMcpGloballyEnabled,
} from "@/lib/mcp/config";
import { createOpaqueToken, hashSecret, verifyPkceS256 } from "@/lib/mcp/crypto";
import { canUseMcp, lockMcpUser } from "@/lib/mcp/user-access";
import {
  DEFAULT_MCP_SCOPES,
  type McpScope,
  parseScopes,
  scopeString,
} from "@/lib/mcp/scopes";

export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string | null;
};

export function authorizationServerMetadata() {
  const base = getAppBaseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/mcp/oauth/authorize`,
    token_endpoint: `${base}/api/mcp/oauth/token`,
    registration_endpoint: `${base}/api/mcp/oauth/register`,
    revocation_endpoint: `${base}/api/mcp/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: DEFAULT_MCP_SCOPES,
  };
}

export function protectedResourceMetadata() {
  return {
    resource: getMcpPublicUrl(),
    authorization_servers: [getAppBaseUrl()],
    scopes_supported: DEFAULT_MCP_SCOPES,
    bearer_methods_supported: ["header"],
  };
}

export async function assertMcpEnabledForUser(email: string) {
  if (!(await isMcpGloballyEnabled())) {
    throw new OAuthError("temporarily_unavailable", "MCP is not enabled", 503);
  }
  const user = await prisma.allowedUser.findUnique({
    where: { email: email.toLowerCase() },
    select: { email: true, active: true, mcpEnabled: true, role: true },
  });
  if (!canUseMcp(user)) {
    throw new OAuthError("access_denied", "MCP is not enabled for this user", 403);
  }
  return user;
}

export function parseAuthorizationRequest(searchParams: URLSearchParams): AuthorizationRequest {
  const responseType = searchParams.get("response_type");
  const clientId = searchParams.get("client_id");
  const redirectUri = searchParams.get("redirect_uri");
  const codeChallenge = searchParams.get("code_challenge");
  const codeChallengeMethod = searchParams.get("code_challenge_method");

  if (responseType !== "code") {
    throw new OAuthError("unsupported_response_type", "Only response_type=code is supported");
  }
  if (!clientId || !redirectUri || !codeChallenge) {
    throw new OAuthError("invalid_request", "Missing required OAuth parameters");
  }
  if (codeChallengeMethod !== "S256") {
    throw new OAuthError("invalid_request", "PKCE S256 is required");
  }
  if (!isAllowedRedirectUri(redirectUri)) {
    throw new OAuthError("invalid_request", "Invalid redirect URI");
  }

  return {
    clientId,
    redirectUri,
    state: searchParams.get("state"),
    codeChallenge,
    codeChallengeMethod,
    scope: searchParams.get("scope"),
  };
}

export async function validateAuthorizationRequest(req: AuthorizationRequest) {
  const client = await prisma.mcpOAuthClient.findUnique({
    where: { clientId: req.clientId },
  });
  if (!client || client.revokedAt) {
    throw new OAuthError("invalid_client", "Unknown OAuth client", 401);
  }
  if (!client.redirectUris.includes(req.redirectUri)) {
    throw new OAuthError("invalid_request", "Redirect URI is not registered");
  }
  const scopes = parseScopes(req.scope);
  return { client, scopes };
}

export async function createAuthorizationCode(args: {
  userEmail: string;
  clientDbId: string;
  redirectUri: string;
  scopes: McpScope[];
  codeChallenge: string;
}) {
  await assertMcpEnabledForUser(args.userEmail);
  const code = createOpaqueToken("acat_code");
  await prisma.$transaction(async (tx) => {
    if (!canUseMcp(await lockMcpUser(tx, args.userEmail))) {
      throw new OAuthError("access_denied", "MCP is not enabled for this user", 403);
    }
    await tx.mcpOAuthAuthorizationCode.create({
      data: {
        codeHash: code.hash,
        clientId: args.clientDbId,
        userEmail: args.userEmail.toLowerCase(),
        redirectUri: args.redirectUri,
        scopes: args.scopes,
        codeChallenge: args.codeChallenge,
        expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
      },
    });
  });
  return code.token;
}

export async function registerOAuthClient(input: {
  client_name?: string;
  redirect_uris?: string[];
  scope?: string;
}) {
  const redirectUris = input.redirect_uris ?? [];
  if (redirectUris.length === 0 || redirectUris.length > 10) {
    throw new OAuthError("invalid_client_metadata", "redirect_uris is required");
  }
  if (redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
    throw new OAuthError("invalid_client_metadata", "Invalid redirect URI");
  }
  const scopes = parseScopes(input.scope);
  const clientId = createOpaqueToken("acat_client").token;
  const client = await prisma.mcpOAuthClient.create({
    data: {
      clientId,
      clientName: input.client_name?.slice(0, 120) ?? null,
      redirectUris,
      scopes,
    },
  });

  return {
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: scopeString(client.scopes),
    client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
  };
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}) {
  if (!(await isMcpGloballyEnabled())) {
    throw new OAuthError("temporarily_unavailable", "MCP is not enabled", 503);
  }

  const codeHash = hashSecret(input.code);
  const row = await prisma.mcpOAuthAuthorizationCode.findUnique({
    where: { codeHash },
    include: { client: true },
  });
  if (!row || row.client.revokedAt || row.client.clientId !== input.clientId) {
    throw new OAuthError("invalid_grant", "Invalid authorization code", 400);
  }
  if (row.consumedAt || row.expiresAt <= new Date()) {
    throw new OAuthError("invalid_grant", "Authorization code expired", 400);
  }
  if (row.redirectUri !== input.redirectUri) {
    throw new OAuthError("invalid_grant", "Redirect URI mismatch", 400);
  }
  if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) {
    throw new OAuthError("invalid_grant", "PKCE verification failed", 400);
  }

  const access = createOpaqueToken("acat_at");
  const refresh = createOpaqueToken("acat_rt");
  const now = new Date();
  const connectionExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

  const result = await prisma.$transaction(async (tx) => {
    if (!canUseMcp(await lockMcpUser(tx, row.userEmail))) {
      throw new OAuthError("invalid_grant", "Authorization is no longer valid", 400);
    }
    const consumed = await tx.mcpOAuthAuthorizationCode.updateMany({
      where: {
        id: row.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        client: { revokedAt: null },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new OAuthError("invalid_grant", "Authorization code is no longer valid", 400);
    }
    const connection = await tx.mcpConnection.create({
      data: {
        userEmail: row.userEmail,
        clientId: row.clientId,
        scopes: row.scopes,
        expiresAt: connectionExpiresAt,
      },
    });
    await tx.mcpAccessToken.create({
      data: {
        tokenHash: access.hash,
        prefix: access.publicPrefix,
        lastFour: access.lastFour,
        connectionId: connection.id,
        scopes: row.scopes,
        expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
      },
    });
    await tx.mcpRefreshToken.create({
      data: {
        tokenHash: refresh.hash,
        prefix: refresh.publicPrefix,
        lastFour: refresh.lastFour,
        connectionId: connection.id,
        expiresAt: connectionExpiresAt,
      },
    });
    return connection;
  });

  return tokenResponse(access.token, refresh.token, row.scopes, ACCESS_TOKEN_TTL_MS, result.expiresAt);
}

export async function refreshAccessToken(input: {
  refreshToken: string;
  clientId: string;
}) {
  if (!(await isMcpGloballyEnabled())) {
    throw new OAuthError("temporarily_unavailable", "MCP is not enabled", 503);
  }

  const tokenHash = hashSecret(input.refreshToken);
  const row = await prisma.mcpRefreshToken.findUnique({
    where: { tokenHash },
    include: { connection: { include: { client: true, user: true } } },
  });
  if (!row || row.connection.client.clientId !== input.clientId) {
    throw new OAuthError("invalid_grant", "Invalid refresh token", 400);
  }
  const now = new Date();
  if (
    row.revokedAt ||
    row.expiresAt <= now ||
    row.connection.revokedAt ||
    row.connection.expiresAt <= now ||
    row.connection.client.revokedAt ||
    !canUseMcp(row.connection.user)
  ) {
    throw new OAuthError("invalid_grant", "Refresh token is no longer valid", 400);
  }
  const access = createOpaqueToken("acat_at");
  const refresh = createOpaqueToken("acat_rt");
  const result = await prisma.$transaction(async (tx) => {
    if (!canUseMcp(await lockMcpUser(tx, row.connection.userEmail))) {
      throw new OAuthError("invalid_grant", "Refresh token is no longer valid", 400);
    }
    const current = await tx.mcpRefreshToken.findUnique({ where: { id: row.id } });
    if (!current || current.revokedAt || current.expiresAt <= new Date()) {
      throw new OAuthError("invalid_grant", "Refresh token is no longer valid", 400);
    }
    if (current.rotatedToId) {
      await tx.mcpConnection.update({
        where: { id: row.connectionId },
        data: {
          revokedAt: now,
          refreshTokens: {
            update: { where: { id: row.id }, data: { reusedAt: now } },
          },
          accessTokens: { updateMany: { where: { revokedAt: null }, data: { revokedAt: now } } },
        },
      });
      // Commit family revocation before reporting reuse; throwing here would
      // roll it back, including when two requests raced with the same token.
      return null;
    }
    // Recheck revocation after acquiring the user lock: a privilege change may
    // have revoked this connection since the initial token lookup.
    const connection = await tx.mcpConnection.updateMany({
      where: {
        id: row.connectionId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        client: { revokedAt: null },
      },
      data: { lastUsedAt: now },
    });
    if (connection.count !== 1) {
      throw new OAuthError("invalid_grant", "Refresh token is no longer valid", 400);
    }
    const nextRefresh = await tx.mcpRefreshToken.create({
      data: {
        tokenHash: refresh.hash,
        prefix: refresh.publicPrefix,
        lastFour: refresh.lastFour,
        connectionId: row.connectionId,
        expiresAt: row.expiresAt,
      },
    });
    const rotated = await tx.mcpRefreshToken.updateMany({
      where: { id: row.id, revokedAt: null, rotatedToId: null, expiresAt: { gt: new Date() } },
      data: { rotatedToId: nextRefresh.id, lastUsedAt: now },
    });
    if (rotated.count !== 1) {
      throw new OAuthError("invalid_grant", "Refresh token is no longer valid", 400);
    }
    await tx.mcpAccessToken.create({
      data: {
        tokenHash: access.hash,
        prefix: access.publicPrefix,
        lastFour: access.lastFour,
        connectionId: row.connectionId,
        scopes: row.connection.scopes,
        expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
      },
    });
    return nextRefresh;
  });

  if (!result) {
    throw new OAuthError("invalid_grant", "Refresh token reuse detected", 400);
  }
  return tokenResponse(access.token, refresh.token, row.connection.scopes, ACCESS_TOKEN_TTL_MS, result.expiresAt);
}

export async function revokeToken(token: string) {
  const tokenHash = hashSecret(token);
  const now = new Date();
  await prisma.$transaction([
    prisma.mcpRefreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now },
    }),
    prisma.mcpAccessToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);
}

function tokenResponse(
  accessToken: string,
  refreshToken: string,
  scopes: readonly string[],
  ttlMs: number,
  refreshExpiresAt: Date
) {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ttlMs / 1000),
    refresh_token: refreshToken,
    refresh_token_expires_at: Math.floor(refreshExpiresAt.getTime() / 1000),
    scope: scopeString(scopes),
  };
}
