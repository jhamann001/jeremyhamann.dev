import type { Prisma } from "@prisma/client";

type McpUser = { active: boolean; mcpEnabled: boolean; role: string };
export type McpUserRole = "ADMIN" | "USER";

/** MCP exposes operations data; advisor access is limited to the browser's redacted view. */
export function canUseMcp<T extends McpUser>(
  user: T | null | undefined
): user is T & { role: McpUserRole } {
  return Boolean(
    user?.active && user.mcpEnabled && (user.role === "ADMIN" || user.role === "USER")
  );
}

/** Serialize credential issuance with privilege updates and their revocations. */
export async function lockMcpUser(tx: Prisma.TransactionClient, email: string) {
  const normalizedEmail = email.toLowerCase();
  await tx.$queryRaw`
    SELECT "id" FROM "AllowedUser" WHERE "email" = ${normalizedEmail} FOR UPDATE
  `;
  return tx.allowedUser.findUnique({ where: { email: normalizedEmail } });
}

/** Must share the transaction that changes the user's privileges. Never un-revoke. */
export async function revokeUserMcpCredentials(
  tx: Prisma.TransactionClient,
  userEmail: string,
  revokedAt = new Date()
) {
  await tx.mcpPersonalToken.updateMany({
    where: { userEmail, revokedAt: null },
    data: { revokedAt },
  });
  await tx.mcpConnection.updateMany({
    where: { userEmail, revokedAt: null },
    data: { revokedAt },
  });
  await tx.mcpAccessToken.updateMany({
    where: { connection: { userEmail }, revokedAt: null },
    data: { revokedAt },
  });
  await tx.mcpRefreshToken.updateMany({
    where: { connection: { userEmail }, revokedAt: null },
    data: { revokedAt },
  });
  await tx.mcpOAuthAuthorizationCode.updateMany({
    where: { userEmail, consumedAt: null },
    data: { consumedAt: revokedAt },
  });
}
