import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { verifyTransferLinkageCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";
import { LinkageError } from "./contract";
import { readLinkagePoint, readLinkageSnapshot } from "./repository";

const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Authorization" };
export async function linkageResponse(request: Request, recordId?: string) {
  const caller = await verifyTransferLinkageCaller(request, recordId === undefined ? "snapshot" : "record");
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  if (new URL(request.url).search || (recordId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(recordId))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers });
  }
  const limit = await rateLimit("machine-transfer-linkage", caller.email, { maxTokens: 30, interval: 60_000 });
  if (!limit.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers });
  try {
    const result = recordId === undefined ? await readLinkageSnapshot() : await readLinkagePoint(recordId);
    return NextResponse.json(result, { headers });
  } catch (error) {
    const code = error instanceof LinkageError ? error.code : "SOURCE_UNAVAILABLE";
    // Database errors may contain source identifiers: log only the stable code.
    logger.warn({ code }, "machine Transfer linkage read unavailable");
    return NextResponse.json({ error: "source_unavailable", code }, { status: 503, headers });
  }
}
