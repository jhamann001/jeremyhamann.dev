import { prisma } from "@/lib/prisma";
import { hashSecret } from "@/lib/mcp/crypto";
import { isMcpGloballyEnabled } from "@/lib/mcp/config";
import { type McpScope, hasScopes } from "@/lib/mcp/scopes";
import { canUseMcp, type McpUserRole } from "@/lib/mcp/user-access";

export type McpPrincipal = {
  userEmail: string;
  connectionId: string | null;
  clientId: string;
  scopes: string[];
  role: McpUserRole;
};

export async function validateMcpBearerToken(
  authorization: string | null | undefined,
  requiredScopes: McpScope[] = []
): Promise<McpPrincipal> {
  if (!(await isMcpGloballyEnabled())) {
    throw new Error("MCP is globally disabled");
  }

  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Error("Missing bearer token");
  }
  const rawToken = match[1];

  if (rawToken.startsWith("mcp_pat_")) {
    return validatePersonalToken(rawToken, requiredScopes);
  }
  return validateOAuthToken(rawToken, requiredScopes);
}

async function validatePersonalToken(
  rawToken: string,
  requiredScopes: McpScope[]
): Promise<McpPrincipal> {
  const tokenHash = hashSecret(rawToken);
  const now = new Date();
  const token = await prisma.mcpPersonalToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (
    !token ||
    token.revokedAt ||
    !canUseMcp(token.user)
  ) {
    throw new Error("Invalid bearer token");
  }
  if (!hasScopes(token.scopes, requiredScopes)) {
    throw new Error("Insufficient MCP scope");
  }

  await prisma.mcpPersonalToken.update({
    where: { id: token.id },
    data: { lastUsedAt: now },
  });

  return {
    userEmail: token.userEmail,
    connectionId: null,
    clientId: `pat:${token.id}`,
    scopes: token.scopes,
    role: token.user.role,
  };
}

async function validateOAuthToken(
  rawToken: string,
  requiredScopes: McpScope[]
): Promise<McpPrincipal> {
  const tokenHash = hashSecret(rawToken);
  const now = new Date();
  const token = await prisma.mcpAccessToken.findUnique({
    where: { tokenHash },
    include: {
      connection: {
        include: {
          client: true,
          user: true,
        },
      },
    },
  });

  if (
    !token ||
    token.revokedAt ||
    token.expiresAt <= now ||
    token.connection.revokedAt ||
    token.connection.expiresAt <= now ||
    token.connection.client.revokedAt ||
    !canUseMcp(token.connection.user)
  ) {
    throw new Error("Invalid bearer token");
  }
  if (!hasScopes(token.scopes, requiredScopes)) {
    throw new Error("Insufficient MCP scope");
  }

  await prisma.$transaction([
    // Match revocation's connection-before-token lock order.
    prisma.mcpConnection.update({
      where: { id: token.connectionId },
      data: { lastUsedAt: now },
    }),
    prisma.mcpAccessToken.update({
      where: { id: token.id },
      data: { lastUsedAt: now },
    }),
  ]);

  return {
    userEmail: token.connection.userEmail,
    connectionId: token.connectionId,
    clientId: token.connection.client.clientId,
    scopes: token.scopes,
    role: token.connection.user.role,
  };
}
