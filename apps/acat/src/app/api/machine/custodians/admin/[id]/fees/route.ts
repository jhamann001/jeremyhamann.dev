import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { createCustodianFeeSchema, formatZodError } from "@/lib/validators";
import {
  authorizeCustodianAdmin,
  loadStoredCustodian,
  trackerCustodianEditsRetired,
  custodianEditsRetiredResponse,
} from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeCustodianAdmin(request, "fee-create");
  if (auth instanceof NextResponse) return auth;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  const { id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = createCustodianFeeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  try {
    const custodian = await prisma.custodian.findUnique({ where: { id }, select: { id: true } });
    if (!custodian) {
      return NextResponse.json({ error: "Custodian not found" }, { status: 404 });
    }
    const fee = await prisma.custodianFee.create({ data: { custodianId: id, ...parsed.data } });
    logger.info({ custodianId: id, feeId: fee.id, by: auth.actor }, "machine custodian fee created");
    return NextResponse.json({ custodian: await loadStoredCustodian(id) }, { status: 201 });
  } catch (err) {
    logger.error({ err, custodianId: id }, "machine custodian fee create failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
