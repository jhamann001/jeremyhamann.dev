import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createOpaqueToken } from "@/lib/mcp/crypto";
import { DEFAULT_MCP_SCOPES, MCP_SCOPES, type McpScope } from "@/lib/mcp/scopes";
import { logger } from "@/lib/logger";
import { canUseMcp, lockMcpUser } from "@/lib/mcp/user-access";
import { OAuthError } from "@/lib/mcp/oauth";
import { demoMode } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const tokens = await prisma.mcpPersonalToken.findMany({
      where: { userEmail: session.user.email },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(
      tokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        lastFour: t.lastFour,
        scopes: t.scopes,
        revokedAt: t.revokedAt,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
      }))
    );
  } catch (err) {
    logger.error({ err }, "GET /api/mcp/pat failed");
    return NextResponse.json({ error: "Failed to load tokens" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (demoMode()) {
    return NextResponse.json({ error: "Claude MCP is off in this demo." }, { status: 403 });
  }
  try {
    const user = await prisma.allowedUser.findUnique({
      where: { email: session.user.email },
    });
    if (!canUseMcp(user)) {
      return NextResponse.json({ error: "MCP access not enabled for your account" }, { status: 403 });
    }

    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const rawScopes: unknown = body.scopes;
    let scopes: McpScope[];
    if (Array.isArray(rawScopes) && rawScopes.length > 0) {
      if (rawScopes.some((s) => !(MCP_SCOPES as readonly string[]).includes(s))) {
        return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
      }
      scopes = rawScopes as McpScope[];
    } else {
      scopes = DEFAULT_MCP_SCOPES;
    }

    const { token, hash, publicPrefix, lastFour } = createOpaqueToken("mcp_pat");

    await prisma.$transaction(async (tx) => {
      if (!canUseMcp(await lockMcpUser(tx, session.user.email!))) {
        throw new OAuthError("access_denied", "MCP access not enabled for your account", 403);
      }
      await tx.mcpPersonalToken.create({
        data: {
          tokenHash: hash,
          prefix: publicPrefix,
          lastFour,
          name,
          userEmail: session.user.email,
          scopes,
        },
      });
    });

    return NextResponse.json({ token, name, scopes }, { status: 201 });
  } catch (err) {
    if (err instanceof OAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logger.error({ err }, "POST /api/mcp/pat failed");
    return NextResponse.json({ error: "Failed to create token" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const result = await prisma.mcpPersonalToken.updateMany({
      where: { id, userEmail: session.user.email, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      return NextResponse.json({ error: "Token not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "DELETE /api/mcp/pat failed");
    return NextResponse.json({ error: "Failed to revoke token" }, { status: 500 });
  }
}
