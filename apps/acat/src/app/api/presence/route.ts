import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  ACTIVE_WINDOW_MS,
  type PresenceUser,
} from "@/lib/presence";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Return every active ops/admin teammate, regardless of when they
    // last heartbeated. The popover shows the full roster; UI labels
    // them "Active now" if fresh, "Last seen X ago" otherwise, and
    // "Never signed in" for rows that have never heartbeated. ADVISOR
    // rows stay excluded (ticket — redacted portal users shouldn't
    // surface to ops-side presence).
    const rows = await prisma.allowedUser.findMany({
      where: {
        active: true,
        role: { in: ["ADMIN", "USER"] },
      },
      select: { email: true, name: true, role: true, lastSeenAt: true },
      orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }],
    });

    const now = Date.now();
    const users: PresenceUser[] = rows.map((r) => {
      const age = r.lastSeenAt ? now - r.lastSeenAt.getTime() : Infinity;
      return {
        email: r.email,
        name: r.name,
        role: r.role as PresenceUser["role"],
        lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
        status: age <= ACTIVE_WINDOW_MS ? "active" : "offline",
      };
    });

    return NextResponse.json({ users });
  } catch (err) {
    logger.error({ err }, "GET /api/presence failed");
    return NextResponse.json(
      { error: "Failed to fetch presence" },
      { status: 500 }
    );
  }
}
