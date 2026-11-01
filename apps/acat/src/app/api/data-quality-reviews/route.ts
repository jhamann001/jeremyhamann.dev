import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { dataQualityReviewSchema, formatZodError } from "@/lib/validators";
import { logger } from "@/lib/logger";
import { demoLimitResponse, withDemoQuota } from "@/lib/demo/limits";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const reviews = await prisma.dataQualityReview.findMany({
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json(reviews);
  } catch (err) {
    logger.error({ err }, "GET /api/data-quality-reviews failed");
    return NextResponse.json({ error: "Failed to load data-quality reviews" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  const reviewedBy = session?.user?.email;
  if (!reviewedBy) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const parsed = dataQualityReviewSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
    }
    const value = parsed.data;
    const record = await prisma.acatRecord.findFirst({
      where: { id: value.acatRecordId, deletedAt: null },
      select: { id: true },
    });
    if (!record) {
      return NextResponse.json({ error: "Transfer record not found" }, { status: 404 });
    }
    const key = {
      acatRecordId_ruleKey_fingerprint: {
        acatRecordId: value.acatRecordId,
        ruleKey: value.ruleKey,
        fingerprint: value.fingerprint,
      },
    };
    // Closing or reopening an existing review adds nothing.
    const isNew = async (db: Prisma.TransactionClient) =>
      (await db.dataQualityReview.findUnique({ where: key, select: { id: true } })) ? 0 : 1;
    const review = await withDemoQuota({ reviews: isNew }, (db) => db.dataQualityReview.upsert({
      where: key,
      create: {
        ...value,
        reviewedBy,
        reviewedAt: new Date(),
      },
      update: {
        status: value.status,
        resolution: value.resolution,
        note: value.note,
        reviewedBy,
        reviewedAt: new Date(),
      },
    }));
    return NextResponse.json(review);
  } catch (err) {
    const limitResponse = demoLimitResponse(err);
    if (limitResponse) return limitResponse;
    logger.error({ err }, "POST /api/data-quality-reviews failed");
    return NextResponse.json({ error: "Failed to save data-quality review" }, { status: 500 });
  }
}
