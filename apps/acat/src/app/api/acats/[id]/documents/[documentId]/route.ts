import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { safeDocumentFilename } from "@/lib/transfer-documents";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; documentId: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id, documentId } = await params;
  try {
    const document = await prisma.acatDocument.findFirst({
      where: { id: documentId, acatRecordId: id, acatRecord: { deletedAt: null } },
      select: { kind: true, filename: true, content: true, inputCsv: true },
    });
    if (!document) return NextResponse.json({ error: "Document not found" }, { status: 404 });
    const input = request.nextUrl.searchParams.get("input") === "1";
    const csv = input || document.kind === "MAPPING_CSV";
    const filename = safeDocumentFilename(input ? `${document.filename.replace(/\.pdf$/i, "")}-inputs` : document.filename, csv ? "csv" : "pdf");
    return new Response(Buffer.from(input ? document.inputCsv : document.content), {
      headers: {
        "Content-Type": csv ? "text/csv; charset=utf-8" : "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    logger.error({ errorType: err instanceof Error ? err.name : "UnknownError", acatId: id, documentId }, "Failed to download transfer document");
    return NextResponse.json({ error: "Could not download saved document" }, { status: 500 });
  }
}
