import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { formatZodError } from "@/lib/validators";
import { normalizeCustodianContactUpdate } from "@/lib/custodian-contact";
import {
  authorizeCustodianAdmin,
  loadStoredCustodian,
  machineUpdateCustodianSchema,
  trackerCustodianEditsRetired,
  custodianEditsRetiredResponse,
} from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeCustodianAdmin(request, "update");
  if (auth instanceof NextResponse) return auth;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  const { id } = await params;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = machineUpdateCustodianSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  try {
    const existing = await prisma.custodian.findUnique({
      where: { id },
      select: { id: true, contactMethod: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Custodian not found" }, { status: 404 });
    }
    const data = normalizeCustodianContactUpdate(parsed.data, existing);
    await prisma.custodian.update({ where: { id }, data });
    logger.info(
      { custodianId: id, by: auth.actor, fields: Object.keys(data) },
      "machine custodian updated"
    );
    return NextResponse.json({ custodian: await loadStoredCustodian(id) });
  } catch (err) {
    logger.error({ err, custodianId: id }, "machine custodian update failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
