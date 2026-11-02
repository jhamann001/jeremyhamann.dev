import { prisma } from "@/lib/db";

// Unauthenticated liveness/readiness endpoint (TDD ADR-7). Excluded from the auth
// middleware (see middleware.ts) so the Cloud Run / uptime probe and the deploy
// smoke-check can reach it without a session. Exposes NO data — only `{ ok, db }`
// booleans (no version/host/error leakage). Node runtime because it touches Prisma
// (which cannot run on the edge); force-dynamic so it is never statically cached
// and always performs a fresh DB round-trip.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let db = false;
  try {
    // Cheap DB round-trip: no table access, no rows, no data returned.
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    // App is up but the DB is unreachable — report db:false, still HTTP 200 so
    // liveness stays green while readiness (db) is visible to the probe.
    db = false;
  }
  return Response.json({ ok: true, db });
}
