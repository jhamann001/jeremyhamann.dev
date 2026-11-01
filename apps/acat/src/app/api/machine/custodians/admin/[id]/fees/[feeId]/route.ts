import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { updateCustodianFeeSchema, formatZodError } from "@/lib/validators";
import {
  authorizeCustodianAdmin,
  loadStoredCustodian,
  trackerCustodianEditsRetired,
  custodianEditsRetiredResponse,
} from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type FeeParams = { params: Promise<{ id: string; feeId: string }> };

async function resolveFee(custodianId: string, feeId: string) {
  const fee = await prisma.custodianFee.findUnique({ where: { id: feeId } });
  // Guard: prevent cross-custodian edits via URL manipulation.
  return fee && fee.custodianId === custodianId ? fee : null;
}

export async function PATCH(request: Request, { params }: FeeParams) {
  const auth = await authorizeCustodianAdmin(request, "fee-update");
  if (auth instanceof NextResponse) return auth;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  const { id, feeId } = await params;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = updateCustodianFeeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  try {
    if (!(await resolveFee(id, feeId))) {
      return NextResponse.json({ error: "Fee not found" }, { status: 404 });
    }
    await prisma.custodianFee.update({ where: { id: feeId }, data: parsed.data });
    logger.info(
      { custodianId: id, feeId, by: auth.actor, fields: Object.keys(parsed.data) },
      "machine custodian fee updated"
    );
    return NextResponse.json({ custodian: await loadStoredCustodian(id) });
  } catch (err) {
    logger.error({ err, custodianId: id, feeId }, "machine custodian fee update failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: FeeParams) {
  const auth = await authorizeCustodianAdmin(request, "fee-delete");
  if (auth instanceof NextResponse) return auth;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  const { id, feeId } = await params;
  try {
    if (!(await resolveFee(id, feeId))) {
      return NextResponse.json({ error: "Fee not found" }, { status: 404 });
    }
    await prisma.custodianFee.delete({ where: { id: feeId } });
    logger.info({ custodianId: id, feeId, by: auth.actor }, "machine custodian fee deleted");
    return NextResponse.json({ custodian: await loadStoredCustodian(id) });
  } catch (err) {
    logger.error({ err, custodianId: id, feeId }, "machine custodian fee delete failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
