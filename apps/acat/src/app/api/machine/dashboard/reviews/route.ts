import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { verifyDashboardCaller } from "@/lib/machine-auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit-redis";
import { dataQualityReviewSchema, formatZodError } from "@/lib/validators";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function enabled() {
  return (
    process.env.EPIC_ACAT_TRANSFER_DASHBOARD === "1" &&
    process.env.SHOW_ACAT_TRANSFER_DASHBOARD === "1"
  );
}

export async function POST(request: Request) {
  if (!enabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const caller = await verifyDashboardCaller(request, "write");
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { allowed } = await rateLimit(
    "machine-acat-dashboard-write",
    caller.email,
    { maxTokens: 30, interval: 60_000, failClosed: true },
  );
  if (!allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  try {
    const parsed = dataQualityReviewSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatZodError(parsed.error) },
        { status: 400 },
      );
    }
    const value = parsed.data;
    const record = await prisma.acatRecord.findFirst({
      where: { id: value.acatRecordId, deletedAt: null },
      select: { id: true },
    });
    if (!record) {
      return NextResponse.json(
        { error: "transfer_not_found" },
        { status: 404 },
      );
    }
    const review = await prisma.dataQualityReview.upsert({
      where: {
        acatRecordId_ruleKey_fingerprint: {
          acatRecordId: value.acatRecordId,
          ruleKey: value.ruleKey,
          fingerprint: value.fingerprint,
        },
      },
      create: {
        ...value,
        reviewedBy: caller.email,
        reviewedAt: new Date(),
      },
      update: {
        status: value.status,
        resolution: value.resolution,
        note: value.note,
        reviewedBy: caller.email,
        reviewedAt: new Date(),
      },
    });
    logger.info(
      { caller: caller.email, status: 200 },
      "machine ACAT dashboard review: ok",
    );
    return NextResponse.json(review);
  } catch (err) {
    logger.error(
      { err, caller: caller.email, status: 500 },
      "machine ACAT dashboard review: failed",
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
