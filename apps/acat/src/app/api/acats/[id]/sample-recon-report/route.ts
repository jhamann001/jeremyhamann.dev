import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { demoMode } from "@/lib/demo/mode";
import { sampleReconReportCsv } from "@/lib/demo/sample-recon-report";

// Demo only: uploads are off, so the security reconciliation loads this instead of a file. It is
// Apex's ACAT Output for the transfer, built from the transfer's own positions.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  if (!demoMode()) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers });
  }
  const { id } = await params;
  const record = await prisma.acatRecord.findFirst({
    where: { id, deletedAt: null },
    select: { assets: { select: { symbol: true, description: true, cusip: true, expectedQty: true, amount: true, assetClass: true }, orderBy: { symbol: "asc" } } },
  });
  if (!record) return NextResponse.json({ error: "Transfer not found" }, { status: 404, headers });
  if (record.assets.length === 0) {
    return NextResponse.json({ error: "Sync the positions from asset mapping first. The sample report follows them." }, { status: 409, headers });
  }
  return new Response(sampleReconReportCsv(record.assets), {
    headers: {
      ...headers,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="apex-acat-output-sample.csv"',
      "X-Content-Type-Options": "nosniff",
    },
  });
}
