import { NextResponse } from "next/server";
import { verifyCustodianSnapshotCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";
import { logger } from "@/lib/logger";
import {
  CustodianSnapshotRefusal,
  custodianSnapshotExportEnabled,
  loadFeeScheduleBytes,
} from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  if (!custodianSnapshotExportEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers });
  }
  const caller = await verifyCustodianSnapshotCaller(request, "file");
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  const { documentId } = await params;
  try {
    const { allowed } = await rateLimit("machine-custodian-snapshot-file", caller.email, {
      maxTokens: 120, interval: 60_000,
    });
    if (!allowed) {
      return NextResponse.json({ error: "rate_limited" }, {
        status: 429, headers: { ...headers, "Retry-After": "60" },
      });
    }
    const document = await loadFeeScheduleBytes(documentId);
    if (!document) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
    return new Response(new Uint8Array(document.content), {
      headers: {
        ...headers,
        "Content-Type": document.contentType,
        "Content-Length": String(document.content.byteLength),
        "Content-Disposition": `attachment; filename="${document.filename}"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof CustodianSnapshotRefusal) {
      logger.error({ status: 409, documentId }, "machine custodian snapshot: checksum refusal");
      return NextResponse.json({ error: "snapshot_refused" }, { status: 409, headers });
    }
    logger.error({ status: 503, documentId }, "machine custodian snapshot: unavailable");
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
  }
}
