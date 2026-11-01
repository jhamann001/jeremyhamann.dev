import { NextResponse } from "next/server";

// Public liveness endpoint. Intentionally leaks zero operational detail
// (no DB status, no uptime, no version) so an attacker probing the
// service can't fingerprint us or tell whether the DB is up. Detailed
// checks have moved to /api/health/detailed behind admin auth.
export async function GET() {
  return NextResponse.json({ ok: true });
}
