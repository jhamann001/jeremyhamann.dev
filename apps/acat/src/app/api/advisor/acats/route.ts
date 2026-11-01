import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { loadAdvisorAcats } from "@/lib/advisor-list";

// ticket: Advisor-facing list of ACAT records.
//
// Gated to ADVISOR or ADMIN sessions (admins can see what advisors see,
// useful for QA without granting them ops/admin/USER's write powers
// elsewhere). Every record passes through `redactForAdvisor` so PII,
// account numbers, fee details, and ops scratch fields never make it
// onto the wire.
//
// Deliberately read-only — no POST/PATCH/DELETE handlers. Advisors
// cannot mutate transfer state from this surface.

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user?.email || (role !== "ADVISOR" && role !== "ADMIN")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const redacted = await loadAdvisorAcats();
    return NextResponse.json(redacted);
  } catch (err) {
    logger.error({ err }, "GET /api/advisor/acats failed");
    return NextResponse.json(
      { error: "Failed to fetch advisor ACAT records" },
      { status: 500 }
    );
  }
}
