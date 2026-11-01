import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit-redis";
import { mergeCustodianSchema, formatZodError } from "@/lib/validators";
import { logger } from "@/lib/logger";
import {
  custodianEditBlockedResponse,
  mergeCustodianInto,
  trackerCustodianEditsRetired,
  custodianEditsRetiredResponse,
} from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Mirror DELETE /api/acats/[id]'s admin-destructive rate limit: merges delete
// the source card and repoint many records, so they warrant the same cap.
const MERGE_RATE_LIMIT = {
  maxTokens: 20,
  interval: 60 * 60 * 1000,
};

/**
 * POST /api/custodians/[id]/merge
 *
 * Repoint every ACAT record from a source (dupe) custodian onto a canonical
 * target, aligning both the FK (`custodianId`) and the denormalized display
 * fields (`custodianName`, `transferringContra`) with the target, then delete
 * the source. Source fees cascade; the target keeps its own.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;
  const blocked = custodianEditBlockedResponse();
  if (blocked) return blocked;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  const { email } = check;
  const { allowed } = await rateLimit("custodian-merge", rateLimitKey(email, request.headers.get("x-forwarded-for")), MERGE_RATE_LIMIT);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many merge requests. Please try again later." },
      { status: 429 }
    );
  }
  const { id: sourceId } = await params;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = mergeCustodianSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const { targetCustodianId: targetId } = parsed.data;

    if (targetId === sourceId) {
      return NextResponse.json(
        { error: "Cannot merge a custodian into itself" },
        { status: 400 }
      );
    }

    const [source, target] = await Promise.all([
      prisma.custodian.findUnique({ where: { id: sourceId } }),
      prisma.custodian.findUnique({ where: { id: targetId } }),
    ]);
    if (!source) {
      return NextResponse.json(
        { error: "Source custodian not found" },
        { status: 404 }
      );
    }
    if (!target) {
      return NextResponse.json(
        { error: "Target custodian not found" },
        { status: 404 }
      );
    }

    const reassigned = await mergeCustodianInto({
      sourceId, target: { id: target.id, name: target.name }, performedBy: email,
    });

    logger.info(
      { sourceId, targetId, reassigned, by: email },
      "custodian merged"
    );
    return NextResponse.json({ reassigned, deletedCustodianId: sourceId });
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "P2003") {
      return NextResponse.json({ error: "This custodian changed during the merge. Refresh and try again; its records and documents have been preserved." }, { status: 409 });
    }
    logger.error(
      { err, sourceId },
      "POST /api/custodians/[id]/merge failed"
    );
    return NextResponse.json(
      { error: "Failed to merge custodian" },
      { status: 500 }
    );
  }
}
