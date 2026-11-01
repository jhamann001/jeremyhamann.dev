import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { safeFeeScheduleFilename } from "@/lib/custodian-fee-documents";
import { custodianFeeScheduleMetadataOnlyEnabled } from "@/lib/custodian-authority-flags";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> }
) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  }
  if (custodianFeeScheduleMetadataOnlyEnabled()) {
    return NextResponse.json({ error: "Fee schedule bytes are retired" }, { status: 409, headers });
  }
  const { id, documentId } = await params;
  try {
    const document = await prisma.custodianFeeScheduleDocument.findFirst({
      where: { id: documentId, custodianId: id },
      select: { filename: true, contentType: true, content: true },
    });
    if (!document) return NextResponse.json({ error: "Fee schedule not found" }, { status: 404, headers });
    if (document.content == null) {
      return NextResponse.json({ error: "Fee schedule file is not stored" }, { status: 404, headers });
    }
    const content = Buffer.from(document.content);
    return new Response(content, {
      headers: {
        ...headers,
        "Content-Type": document.contentType,
        "Content-Length": String(content.byteLength),
        "Content-Disposition": `attachment; filename="${safeFeeScheduleFilename(document.filename)}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logger.error({ errorType: error instanceof Error ? error.name : "UnknownError", custodianId: id, documentId }, "Failed to download custodian fee schedule");
    return NextResponse.json({ error: "Could not download fee schedule" }, { status: 500, headers });
  }
}
