import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { verifyAcatReadCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";
import { loadRecordHistory } from "@/lib/record-history";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const MACHINE_READ_LIMIT = { maxTokens: 120, interval: 60_000 };

function fieldHistoryEnabled(): boolean {
  return process.env.ROLLOUT_ACAT_FIELD_HISTORY === "1";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!fieldHistoryEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const caller = await verifyAcatReadCaller(request, "history");
  if (!caller) {
    logger.warn({ status: 401 }, "machine ACAT history: unauthorized");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { allowed } = await rateLimit("machine-acat-history", caller.email, MACHINE_READ_LIMIT);
  if (!allowed) {
    logger.warn({ caller: caller.email, status: 429 }, "machine ACAT history: rate limited");
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const { id } = await params;
  if (typeof id !== "string" || id.trim() === "") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    const record = await prisma.acatRecord.findUnique({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!record) {
      logger.info({ id, caller: caller.email, status: 404 }, "machine ACAT history: not found");
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const entries = await loadRecordHistory(id);
    logger.info(
      { id, caller: caller.email, count: entries.length, status: 200 },
      "machine ACAT history: ok"
    );
    return NextResponse.json(
      entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        field: entry.field,
          oldValue: entry.oldValue,
          newValue: entry.newValue,
        performedBy: entry.performedBy,
        timestamp: entry.timestamp.toISOString(),
      })),
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    logger.error({ err, id, caller: caller.email, status: 500 }, "machine ACAT history: failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
