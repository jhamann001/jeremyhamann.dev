import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { suggestDtccNumber } from "@/lib/dtcc-suggestion";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const contra = new URL(request.url).searchParams.get("contra")?.trim() ?? "";
  if (!contra) return NextResponse.json({ status: "none", dtccNumber: null, source: null, historicalSampleSize: 0 });
  if (contra.length > 120) {
    return NextResponse.json({ error: "Contra is too long" }, { status: 400 });
  }

  try {
    const [records, custodians] = await Promise.all([
      prisma.acatRecord.findMany({
        where: { deletedAt: null, transferringContra: { not: null } },
        select: { transferringContra: true, dtccNumber: true },
      }),
      prisma.custodian.findMany({
        select: { name: true, dtcNumber: true },
      }),
    ]);
    return NextResponse.json(suggestDtccNumber(records, custodians, contra));
  } catch (err) {
    logger.error({ err, contra }, "GET /api/dtcc-suggestion failed");
    return NextResponse.json({ error: "Failed to calculate DTC suggestion" }, { status: 500 });
  }
}
