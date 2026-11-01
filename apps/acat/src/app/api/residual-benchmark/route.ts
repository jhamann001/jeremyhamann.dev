import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AcatRecord } from "@/lib/types";
import { residualFollowUpBenchmark } from "@/lib/transfer-analytics";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const contra = new URL(request.url).searchParams.get("contra")?.trim() ?? "";
  if (contra.length > 120) {
    return NextResponse.json({ error: "Contra is too long" }, { status: 400 });
  }
  try {
    const rows = await prisma.acatRecord.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        type: true,
        transferWorkflow: true,
        controlNumber: true,
        associatedControlNumber: true,
        transferringContra: true,
        apexCompletionDate: true,
      },
    });
    return NextResponse.json(
      residualFollowUpBenchmark(rows as unknown as AcatRecord[], contra)
    );
  } catch (err) {
    logger.error({ err }, "GET /api/residual-benchmark failed");
    return NextResponse.json({ error: "Failed to calculate residual benchmark" }, { status: 500 });
  }
}
