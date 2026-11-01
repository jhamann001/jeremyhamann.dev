import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyCustodianLibraryCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";
import { loadObservedCustodianTimings } from "@/lib/custodian-timing-data";
import { logger } from "@/lib/logger";
import { custodianLibrarySelect, toLibraryProfile } from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const headers = { "Cache-Control": "private, no-store" };

/** OPS_PORTAL's read-only operational library. No client history, record relations,
 * retired fields or mutation methods. Keep explicit projections as the schema
 * grows; never replace them with include/spread of an entire Custodian row. */
export async function GET(request: Request) {
  const caller = await verifyCustodianLibraryCaller(request);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  }
  try {
    const { allowed } = await rateLimit("machine-custodian-library", caller.email, {
      maxTokens: 30, interval: 60_000,
    });
    if (!allowed) {
      return NextResponse.json({ error: "rate_limited" }, {
        status: 429, headers: { ...headers, "Retry-After": "60" },
      });
    }
    const [custodians, timings] = await Promise.all([
      prisma.custodian.findMany({
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: custodianLibrarySelect,
      }),
      loadObservedCustodianTimings(),
    ]);
    return NextResponse.json({
      schemaVersion: 1,
      retrievedAt: new Date().toISOString(),
      custodians: custodians.map((row) => toLibraryProfile(row, timings)),
    }, { headers });
  } catch {
    // Never log database errors, profile contents or caller tokens.
    logger.error({ status: 503 }, "machine custodian library: unavailable");
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
  }
}
