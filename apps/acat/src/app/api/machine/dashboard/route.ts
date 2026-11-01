import { NextResponse } from "next/server";
import { acatClientLinksSelection, toOperationalAcat } from "@/lib/acat-identity-dto";
import { composeDashboardContract } from "@/lib/dashboard-contract";
import { logger } from "@/lib/logger";
import { verifyDashboardCaller } from "@/lib/machine-auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit-redis";
import type { AcatRecord } from "@/lib/types";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function enabled() {
  return (
    process.env.EPIC_ACAT_TRANSFER_DASHBOARD === "1" &&
    process.env.SHOW_ACAT_TRANSFER_DASHBOARD === "1"
  );
}

export async function GET(request: Request) {
  if (!enabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const caller = await verifyDashboardCaller(request, "read");
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { allowed } = await rateLimit(
    "machine-acat-dashboard",
    caller.email,
    { maxTokens: 30, interval: 60_000, failClosed: true },
  );
  if (!allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  try {
    const [rows, reviews] = await Promise.all([
      prisma.acatRecord.findMany({
        where: { deletedAt: null },
        include: {
          assets: true,
          clientLinks: acatClientLinksSelection,
          custodian: { omit: { requiresManualReview: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 5000,
      }),
      prisma.dataQualityReview.findMany({ orderBy: { updatedAt: "desc" } }),
    ]);
    const records = rows.map(toOperationalAcat);
    const dashboard = composeDashboardContract(
      records as unknown as AcatRecord[],
      reviews,
    );
    logger.info(
      { caller: caller.email, count: records.length, status: 200 },
      "machine ACAT dashboard: ok",
    );
    return NextResponse.json(dashboard);
  } catch (err) {
    logger.error(
      { err, caller: caller.email, status: 500 },
      "machine ACAT dashboard: failed",
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
