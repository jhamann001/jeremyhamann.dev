import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";

const startTime = Date.now();

// Authenticated deep-health endpoint. Used by the admin dashboard and
// on-call to confirm the DB is reachable and inspect uptime/version.
// Keeping this behind requireAdmin() avoids leaking "DB is down" as a
// public fingerprinting signal.
export async function GET() {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  let dbStatus: "ok" | "error" = "error";
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = "ok";
  } catch {
    // DB unreachable
  }

  const uptimeMs = Date.now() - startTime;
  const status = dbStatus === "ok" ? 200 : 503;

  return NextResponse.json(
    {
      status: dbStatus === "ok" ? "healthy" : "degraded",
      db: dbStatus,
      uptime: `${Math.floor(uptimeMs / 1000)}s`,
      version: process.env.npm_package_version ?? "0.1.0",
      timestamp: new Date().toISOString(),
    },
    { status }
  );
}
