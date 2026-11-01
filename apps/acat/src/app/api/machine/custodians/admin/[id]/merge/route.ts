import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit-redis";
import { mergeCustodianSchema, formatZodError } from "@/lib/validators";
import {
  authorizeCustodianAdmin,
  loadStoredCustodian,
  mergeCustodianInto,
  trackerCustodianEditsRetired,
  custodianEditsRetiredResponse,
} from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Same cap and key as the tracker's session merge route, so one admin shares
// one budget across both screens.
const MERGE_RATE_LIMIT = { maxTokens: 20, interval: 60 * 60 * 1000 };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeCustodianAdmin(request, "merge");
  if (auth instanceof NextResponse) return auth;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  const { allowed } = await rateLimit("custodian-merge", auth.actor, MERGE_RATE_LIMIT);
  if (!allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const { id: sourceId } = await params;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = mergeCustodianSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  const { targetCustodianId: targetId } = parsed.data;
  if (targetId === sourceId) {
    return NextResponse.json({ error: "Cannot merge a custodian into itself" }, { status: 400 });
  }
  try {
    const [source, target] = await Promise.all([
      prisma.custodian.findUnique({ where: { id: sourceId } }),
      prisma.custodian.findUnique({ where: { id: targetId } }),
    ]);
    if (!source) return NextResponse.json({ error: "Source custodian not found" }, { status: 404 });
    if (!target) return NextResponse.json({ error: "Target custodian not found" }, { status: 404 });
    const reassigned = await mergeCustodianInto({
      sourceId, target: { id: target.id, name: target.name }, performedBy: auth.actor,
    });
    logger.info({ sourceId, targetId, reassigned, by: auth.actor }, "machine custodian merged");
    return NextResponse.json({
      custodian: await loadStoredCustodian(targetId),
      reassigned,
      deletedCustodianId: sourceId,
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "P2003") {
      return NextResponse.json({ error: "Custodian changed during merge. Refresh and retry; records and documents were preserved." }, { status: 409 });
    }
    logger.error({ err, sourceId }, "machine custodian merge failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
