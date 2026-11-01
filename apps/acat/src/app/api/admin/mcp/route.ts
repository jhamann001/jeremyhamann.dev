import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { getMcpPublicUrl } from "@/lib/mcp/config";
import { logger } from "@/lib/logger";
import { demoMode } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  try {
    const [settings, connections, auditLogs] = await Promise.all([
      prisma.mcpSettings.upsert({
        where: { id: "global" },
        update: {},
        create: { id: "global", enabled: false },
      }),
      prisma.mcpConnection.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { client: true },
      }),
      prisma.mcpToolAuditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    ]);

    return NextResponse.json({
      connectorUrl: `${getMcpPublicUrl()}/mcp`,
      settings,
      connections: connections.map((connection) => ({
        id: connection.id,
        userEmail: connection.userEmail,
        clientName: connection.client.clientName,
        scopes: connection.scopes,
        createdAt: connection.createdAt,
        expiresAt: connection.expiresAt,
        revokedAt: connection.revokedAt,
        lastUsedAt: connection.lastUsedAt,
      })),
      auditLogs,
    });
  } catch (err) {
    logger.error({ err }, "GET /api/admin/mcp failed");
    return NextResponse.json({ error: "Failed to load MCP settings" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;
  if (demoMode()) {
    return NextResponse.json({ error: "Claude MCP is off in this demo." }, { status: 403 });
  }

  try {
    const body = await request.json();
    const enabled = Boolean(body.enabled);
    const settings = await prisma.mcpSettings.upsert({
      where: { id: "global" },
      update: { enabled },
      create: { id: "global", enabled },
    });
    return NextResponse.json(settings);
  } catch (err) {
    logger.error({ err }, "PATCH /api/admin/mcp failed");
    return NextResponse.json({ error: "Failed to update MCP settings" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  try {
    const id = new URL(request.url).searchParams.get("connectionId");
    if (!id) {
      return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
    }
    const now = new Date();
    const updated = await prisma.mcpConnection.update({
      where: { id },
      data: {
        revokedAt: now,
        accessTokens: { updateMany: { where: { revokedAt: null }, data: { revokedAt: now } } },
        refreshTokens: { updateMany: { where: { revokedAt: null }, data: { revokedAt: now } } },
      },
    });
    return NextResponse.json(updated);
  } catch (err) {
    logger.error({ err }, "DELETE /api/admin/mcp failed");
    return NextResponse.json({ error: "Failed to revoke MCP connection" }, { status: 500 });
  }
}
