import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
const selectionSchema = z.object({
  assets: z.array(z.object({
    id: z.string().min(1).max(100),
    includeInTransfer: z.boolean().nullable(),
  }).strict()).min(1).max(500),
}).strict();

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const record = await prisma.acatRecord.findUnique({
      where: { id, deletedAt: null },
      select: { assets: { orderBy: { id: "asc" }, select: { id: true, symbol: true, description: true, expectedQty: true, includeInTransfer: true } } },
    });
    if (!record) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
    return NextResponse.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    logger.error({ err, acatId: id }, "Failed to load paperwork selections");
    return NextResponse.json({ error: "Could not load saved selections" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  try {
    const parsed = selectionSchema.safeParse(await request.json());
    if (!parsed.success || new Set(parsed.data.assets.map((asset) => asset.id)).size !== parsed.data.assets.length) {
      return NextResponse.json({ error: "Invalid transfer selections" }, { status: 400 });
    }
    // Validate ownership and write through the parent in one transaction. This
    // edits decisions only; quantities and recon work are never replaced.
    const result = await prisma.$transaction(async (tx) => {
      const record = await tx.acatRecord.findUnique({ where: { id, deletedAt: null }, select: { assets: { select: { id: true } } } });
      if (!record) return 404;
      const ids = new Set(record.assets.map((asset) => asset.id));
      if (parsed.data.assets.some((asset) => !ids.has(asset.id))) return 409;
      await tx.acatRecord.update({
        where: { id, deletedAt: null },
        data: {
          assets: { update: parsed.data.assets.map(({ id: assetId, includeInTransfer }) => ({ where: { id: assetId }, data: { includeInTransfer } })) },
          lastUpdated: new Date().toISOString(), updatedBy: session.user.email,
          auditLogs: { create: {
            action: "paperwork-selections-save", field: "includeInTransfer",
            newValue: JSON.stringify(parsed.data.assets), performedBy: session.user.email,
          } },
        },
      });
      return 200;
    });
    if (result === 404) return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
    if (result === 409) return NextResponse.json({ error: "The holdings changed. Reload before saving selections." }, { status: 409 });
    return NextResponse.json({ saved: true });
  } catch (err) {
    logger.error({ err, acatId: id }, "Failed to save paperwork selections");
    return NextResponse.json({ error: "Could not save transfer selections" }, { status: err instanceof SyntaxError ? 400 : 500 });
  }
}
