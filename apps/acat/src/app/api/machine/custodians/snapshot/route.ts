import { NextResponse } from "next/server";
import { verifyCustodianSnapshotCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";
import { logger } from "@/lib/logger";
import {
  CustodianSnapshotRefusal,
  custodianSnapshotExportEnabled,
  loadCustodianSnapshot,
} from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  if (!custodianSnapshotExportEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers });
  }
  const caller = await verifyCustodianSnapshotCaller(request, "snapshot");
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  try {
    const { allowed } = await rateLimit("machine-custodian-snapshot", caller.email, {
      maxTokens: 30, interval: 60_000,
    });
    if (!allowed) {
      return NextResponse.json({ error: "rate_limited" }, {
        status: 429, headers: { ...headers, "Retry-After": "60" },
      });
    }
    return NextResponse.json(await loadCustodianSnapshot(), { headers });
  } catch (error) {
    if (error instanceof CustodianSnapshotRefusal) {
      logger.error({ status: 409 }, "machine custodian snapshot: checksum refusal");
      return NextResponse.json({ error: "snapshot_refused" }, { status: 409, headers });
    }
    logger.error({ status: 503 }, "machine custodian snapshot: unavailable");
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
  }
}
