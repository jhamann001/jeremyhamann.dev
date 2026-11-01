import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { loadRecordHistory } from "@/lib/record-history";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  try {
    const record = await prisma.acatRecord.findUnique({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!record) {
      return NextResponse.json({ error: "ACAT record not found" }, { status: 404 });
    }

    const entries = await loadRecordHistory(id);

    return NextResponse.json(entries);
  } catch (err) {
    logger.error({ err, acatId: id }, "GET /api/acats/[id]/history failed");
    return NextResponse.json(
      { error: "Failed to fetch record history" },
      { status: 500 }
    );
  }
}
