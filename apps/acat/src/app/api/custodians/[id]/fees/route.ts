import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  custodianEditBlockedResponse,
  trackerCustodianEditsRetired,
  custodianEditsRetiredResponse,
} from "@/lib/custodian-admin";
import { createCustodianFeeSchema, formatZodError } from "@/lib/validators";
import { logger } from "@/lib/logger";
import { demoLimitResponse, withDemoQuota } from "@/lib/demo/limits";

export const dynamic = "force-dynamic";
export const revalidate = 0;

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
  const { id: custodianId } = await params;

  try {
    const custodian = await prisma.custodian.findUnique({ where: { id: custodianId } });
    if (!custodian) {
      return NextResponse.json(
        { error: "Custodian not found" },
        { status: 404 }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = createCustodianFeeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }

    const fee = await withDemoQuota({ custodianFees: 1 }, (db) =>
      db.custodianFee.create({
        data: {
          custodianId,
          ...parsed.data,
        },
      })
    );

    logger.info(
      { custodianId, feeId: fee.id, by: email },
      "custodian fee created"
    );
    return NextResponse.json(fee, { status: 201 });
  } catch (err) {
    const limitResponse = demoLimitResponse(err);
    if (limitResponse) return limitResponse;
    logger.error(
      { err, custodianId },
      "POST /api/custodians/[id]/fees failed"
    );
    return NextResponse.json(
      { error: "Failed to create fee" },
      { status: 500 }
    );
  }
}
