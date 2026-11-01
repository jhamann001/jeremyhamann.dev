import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { demoMode } from "@/lib/demo/flags";
import { listOutbox } from "@/lib/demo/outbox";

// Demo only: what the app would have sent to Slack, for the Outbox screen.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
  if (!demoMode()) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  }
  return NextResponse.json({ messages: await listOutbox(prisma, 50) }, { headers });
}
