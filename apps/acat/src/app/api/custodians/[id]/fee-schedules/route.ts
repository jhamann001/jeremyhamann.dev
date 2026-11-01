import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import {
  FeeScheduleUploadError,
  feeScheduleMetadataSelect,
  readFeeScheduleUpload,
} from "@/lib/custodian-fee-documents";
import { custodianEditBlockedResponse } from "@/lib/custodian-admin";
import { custodianFeeScheduleMetadataOnlyEnabled } from "@/lib/custodian-authority-flags";
import { demoMode } from "@/lib/demo/mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  }
  const { id } = await params;
  try {
    const custodian = await prisma.custodian.findUnique({ where: { id }, select: { id: true } });
    if (!custodian) return NextResponse.json({ error: "Custodian not found" }, { status: 404, headers });
    const cursor = new URL(request.url).searchParams.get("cursor");
    if (cursor !== null && (
      !/^[a-zA-Z0-9_-]{1,200}$/.test(cursor) ||
      !await prisma.custodianFeeScheduleDocument.findFirst({
        where: { id: cursor, custodianId: id }, select: { id: true },
      })
    )) {
      return NextResponse.json({ error: "Invalid fee schedule cursor" }, { status: 400, headers });
    }
    const documents = await prisma.custodianFeeScheduleDocument.findMany({
      where: { custodianId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: 21,
      select: feeScheduleMetadataSelect,
    });
    return NextResponse.json({
      documents: documents.slice(0, 20),
      nextCursor: documents.length > 20 ? documents[19].id : null,
    }, { headers });
  } catch (error) {
    logger.error({ errorType: error instanceof Error ? error.name : "UnknownError", custodianId: id }, "Failed to list custodian fee schedules");
    return NextResponse.json({ error: "Could not load fee schedules" }, { status: 500, headers });
  }
}

export async function POST(request: Request, { params }: Context) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  if (demoMode()) return NextResponse.json({ error: "Uploads are off in this demo." }, { status: 403, headers });
  if (custodianFeeScheduleMetadataOnlyEnabled()) {
    return NextResponse.json({ error: "Fee schedule bytes are retired" }, { status: 409, headers });
  }
  const blocked = custodianEditBlockedResponse();
  if (blocked) return blocked;
  const { id } = await params;
  try {
    const custodian = await prisma.custodian.findUnique({ where: { id }, select: { id: true } });
    if (!custodian) return NextResponse.json({ error: "Custodian not found" }, { status: 404, headers });
    const upload = await readFeeScheduleUpload(request);
    // A retry normally returns the existing attachment. This is deliberately
    // best-effort: concurrent uploads may both survive, and merges preserve
    // every original document rather than deleting same-content attachments.
    const existing = await prisma.custodianFeeScheduleDocument.findFirst({
      where: { custodianId: id, sha256: upload.sha256 },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: feeScheduleMetadataSelect,
    });
    if (existing) return NextResponse.json({ document: existing, duplicate: true }, { status: 200, headers });
    const document = await prisma.custodianFeeScheduleDocument.create({
      data: { ...upload, custodianId: id, createdBy: session.user.email },
      select: feeScheduleMetadataSelect,
    });
    return NextResponse.json({ document, duplicate: false }, { status: 201, headers });
  } catch (error) {
    if (error instanceof FeeScheduleUploadError) {
      return NextResponse.json({ error: error.message }, { status: error.status, headers });
    }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2003") {
      try {
        const stillExists = await prisma.custodian.findUnique({ where: { id }, select: { id: true } });
        if (!stillExists) return NextResponse.json({ error: "Custodian not found" }, { status: 404, headers });
      } catch {
        // Preserve the generic storage failure below if the recheck fails.
      }
    }
    logger.error({ errorType: error instanceof Error ? error.name : "UnknownError", custodianId: id }, "Failed to store custodian fee schedule");
    return NextResponse.json({ error: "Could not save fee schedule" }, { status: 500, headers });
  }
}
