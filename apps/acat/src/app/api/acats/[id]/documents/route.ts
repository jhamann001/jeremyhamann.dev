import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const record = await prisma.acatRecord.findUnique({ where: { id, deletedAt: null }, select: { id: true } });
    if (!record) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
    const cursor = request.nextUrl.searchParams.get("cursor");
    if (cursor && !await prisma.acatDocument.findFirst({ where: { id: cursor, acatRecordId: id }, select: { id: true } })) {
      return NextResponse.json({ error: "Invalid history cursor" }, { status: 400 });
    }
    const documents = await prisma.acatDocument.findMany({
      where: { acatRecordId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: 21,
      select: {
        id: true, kind: true, filename: true, createdAt: true, createdBy: true,
        byteSize: true, positionCount: true, includedCount: true, excludedCount: true, undecidedCount: true,
      },
    });
    return NextResponse.json({ documents: documents.slice(0, 20), nextCursor: documents.length > 20 ? documents[19].id : null }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logger.error({ errorType: err instanceof Error ? err.name : "UnknownError", acatId: id }, "Failed to load transfer document history");
    return NextResponse.json({ error: "Could not load saved inputs and paperwork" }, { status: 500 });
  }
}
