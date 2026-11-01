import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getMcpPublicUrl } from "@/lib/mcp/config";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const connections = await prisma.mcpConnection.findMany({
      where: { userEmail: session.user.email },
      orderBy: { createdAt: "desc" },
      include: { client: true },
    });
    return NextResponse.json({
      connectorUrl: `${getMcpPublicUrl()}/mcp`,
      connections: connections.map((connection) => ({
        id: connection.id,
        clientName: connection.client.clientName,
        scopes: connection.scopes,
        createdAt: connection.createdAt,
        expiresAt: connection.expiresAt,
        revokedAt: connection.revokedAt,
        lastUsedAt: connection.lastUsedAt,
      })),
    });
  } catch (err) {
    logger.error({ err }, "GET /api/mcp/connections failed");
    return NextResponse.json({ error: "Failed to load MCP connections" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const connectionId = new URL(request.url).searchParams.get("connectionId");
    if (!connectionId) {
      return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
    }
    const now = new Date();
    const result = await prisma.mcpConnection.updateMany({
      where: { id: connectionId, userEmail: session.user.email },
      data: { revokedAt: now },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }
    await prisma.$transaction([
      prisma.mcpAccessToken.updateMany({
        where: { connectionId, revokedAt: null },
        data: { revokedAt: now },
      }),
      prisma.mcpRefreshToken.updateMany({
        where: { connectionId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "DELETE /api/mcp/connections failed");
    return NextResponse.json({ error: "Failed to revoke MCP connection" }, { status: 500 });
  }
}
