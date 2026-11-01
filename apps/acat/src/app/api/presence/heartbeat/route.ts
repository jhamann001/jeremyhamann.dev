import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Clients POST here ~every 30s while the tab is visible and the user is
// active. We use updateMany so a race where the AllowedUser row was
// deleted between auth and write doesn't 500 — it just no-ops.
export async function POST() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await prisma.allowedUser.updateMany({
      where: { email: email.toLowerCase() },
      data: { lastSeenAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "POST /api/presence/heartbeat failed");
    return NextResponse.json(
      { error: "Failed to record heartbeat" },
      { status: 500 }
    );
  }
}
