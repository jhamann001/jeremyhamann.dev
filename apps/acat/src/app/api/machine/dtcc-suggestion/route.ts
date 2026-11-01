import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { verifyDrawerCaller } from "@/lib/machine-auth";
import { suggestDtccNumber } from "@/lib/dtcc-suggestion";
import { drawerContractEnabled } from "@/lib/acat-drawer-contract";
import { rateLimit } from "@/lib/rate-limit-redis";

// ticket: the tracker's own custodian-plus-history DTCC suggestion for a
// trusted caller. Dark (opaque 404) unless both drawer switches are on; the
// gate runs before authentication or any database access.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const MACHINE_READ_LIMIT = { maxTokens: 120, interval: 60_000 };

export async function GET(request: Request) {
  if (!drawerContractEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const caller = await verifyDrawerCaller(request, "suggestion");
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { allowed } = await rateLimit("machine-acat-read", caller.email, MACHINE_READ_LIMIT);
  if (!allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const contra = new URL(request.url).searchParams.get("contra")?.trim() ?? "";
  if (!contra) return NextResponse.json({ status: "none", dtccNumber: null, source: null, historicalSampleSize: 0 });
  if (contra.length > 120) return NextResponse.json({ error: "Contra is too long" }, { status: 400 });

  try {
    const [records, custodians] = await Promise.all([
      prisma.acatRecord.findMany({
        where: { deletedAt: null, transferringContra: { not: null } },
        select: { transferringContra: true, dtccNumber: true },
      }),
      prisma.custodian.findMany({ select: { name: true, dtcNumber: true } }),
    ]);
    return NextResponse.json(suggestDtccNumber(records, custodians, contra));
  } catch (err) {
    logger.error({ err, caller: caller.email }, "machine DTCC suggestion failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
