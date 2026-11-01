import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { inviteUserSchema, updateUserSchema, formatZodError } from "@/lib/validators";
import { logger } from "@/lib/logger";
import { demoLimitResponse, withDemoQuota } from "@/lib/demo/limits";
import { canUseMcp, lockMcpUser, revokeUserMcpCredentials } from "@/lib/mcp/user-access";
import { isPersonaEmail, personaSignInEnabled } from "@/lib/demo/personas";
import { demoMode } from "@/lib/demo/mode";

const ALLOWED_DOMAINS = ["example.com", "example.org"];

// Demo: the sign-in personas stay as seeded for every visitor. The check runs on the row the route
// itself looked up by id, so it covers exactly the account the write would change.
function personaLocked(email: string): NextResponse | null {
  if (!personaSignInEnabled() || !isPersonaEmail(email)) return null;
  return NextResponse.json(
    { error: "Demo sign-in accounts can't be changed." },
    { status: 403 }
  );
}

export async function GET() {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  try {
    const users = await prisma.allowedUser.findMany({
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(users);
  } catch (err) {
    logger.error({ err }, "GET /api/admin/users failed");
    return NextResponse.json(
      { error: "Failed to fetch users" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  try {
    const body = await request.json();
    const parsed = inviteUserSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }

    const email = parsed.data.email.toLowerCase();
    const domain = email.split("@")[1];
    if (!domain || !ALLOWED_DOMAINS.includes(domain)) {
      return NextResponse.json(
        { error: `Only ${ALLOWED_DOMAINS.join(", ")} emails are allowed` },
        { status: 400 }
      );
    }

    const existing = await prisma.allowedUser.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: "User with this email already exists" },
        { status: 409 }
      );
    }

    const user = await withDemoQuota({ users: 1 }, (db) =>
      db.allowedUser.create({
        data: {
          email,
          name: parsed.data.name ?? null,
          role: parsed.data.role,
          invitedBy: check.email,
        },
      })
    );

    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    const limitResponse = demoLimitResponse(err);
    if (limitResponse) return limitResponse;
    logger.error({ err }, "POST /api/admin/users failed");
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to invite user" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  try {
    const body = await request.json();
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }

    const { id, ...data } = parsed.data;
    if (demoMode() && data.mcpEnabled !== undefined) {
      return NextResponse.json({ error: "Claude MCP is off in this demo." }, { status: 403 });
    }
    const existing = await prisma.allowedUser.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }
    const locked = personaLocked(existing.email);
    if (locked) return locked;

    const updated = await prisma.$transaction(async (tx) => {
      const current = await lockMcpUser(tx, existing.email);
      const user = await tx.allowedUser.update({ where: { id }, data });
      if (
        current?.role !== user.role ||
        current?.active !== user.active ||
        current?.mcpEnabled !== user.mcpEnabled ||
        !canUseMcp(user)
      ) {
        await revokeUserMcpCredentials(tx, user.email);
      }
      return user;
    });

    return NextResponse.json(updated);
  } catch (err) {
    logger.error({ err }, "PATCH /api/admin/users failed");
    return NextResponse.json(
      { error: "Failed to update user" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json(
        { error: "User ID is required" },
        { status: 400 }
      );
    }

    const existing = await prisma.allowedUser.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "User not found" },
        { status: 404 }
      );
    }

    if (existing.email === check.email) {
      return NextResponse.json(
        { error: "Cannot deactivate your own account" },
        { status: 400 }
      );
    }
    const locked = personaLocked(existing.email);
    if (locked) return locked;

    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.allowedUser.update({
        where: { id },
        data: { active: false },
      });
      await revokeUserMcpCredentials(tx, user.email);
      return user;
    });

    return NextResponse.json(updated);
  } catch (err) {
    logger.error({ err }, "DELETE /api/admin/users failed");
    return NextResponse.json(
      { error: "Failed to deactivate user" },
      { status: 500 }
    );
  }
}
