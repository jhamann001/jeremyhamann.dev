import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  custodianEditBlockedResponse,
  trackerCustodianEditsRetired,
  custodianEditsRetiredResponse,
} from "@/lib/custodian-admin";
import { updateCustodianFeeSchema, formatZodError } from "@/lib/validators";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function resolveFee(custodianId: string, feeId: string) {
  const fee = await prisma.custodianFee.findUnique({ where: { id: feeId } });
  if (!fee) return null;
  // Guard: prevent cross-custodian edits via URL manipulation.
  if (fee.custodianId !== custodianId) return null;
  return fee;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; feeId: string }> }
) {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;
  const blocked = custodianEditBlockedResponse();
  if (blocked) return blocked;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  const { email } = check;
  const { id: custodianId, feeId } = await params;

  try {
    const existing = await resolveFee(custodianId, feeId);
    if (!existing) {
      return NextResponse.json({ error: "Fee not found" }, { status: 404 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = updateCustodianFeeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }

    const updated = await prisma.custodianFee.update({
      where: { id: feeId },
      data: parsed.data,
    });

    logger.info(
      { custodianId, feeId, by: email, fields: Object.keys(parsed.data) },
      "custodian fee updated"
    );
    return NextResponse.json(updated);
  } catch (err) {
    logger.error(
      { err, custodianId, feeId },
      "PATCH /api/custodians/[id]/fees/[feeId] failed"
    );
    return NextResponse.json(
      { error: "Failed to update fee" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; feeId: string }> }
) {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;
  const blocked = custodianEditBlockedResponse();
  if (blocked) return blocked;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  const { email } = check;
  const { id: custodianId, feeId } = await params;

  try {
    const existing = await resolveFee(custodianId, feeId);
    if (!existing) {
      return NextResponse.json({ error: "Fee not found" }, { status: 404 });
    }

    await prisma.custodianFee.delete({ where: { id: feeId } });

    logger.info(
      { custodianId, feeId, by: email },
      "custodian fee deleted"
    );
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error(
      { err, custodianId, feeId },
      "DELETE /api/custodians/[id]/fees/[feeId] failed"
    );
    return NextResponse.json(
      { error: "Failed to delete fee" },
      { status: 500 }
    );
  }
}
