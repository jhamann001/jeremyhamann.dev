import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { createCustodianSchema, formatZodError } from "@/lib/validators";
import {
  authorizeCustodianAdmin,
  loadStoredCustodian,
  trackerCustodianEditsRetired,
  custodianEditsRetiredResponse,
} from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: Request) {
  const auth = await authorizeCustodianAdmin(request, "create");
  if (auth instanceof NextResponse) return auth;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = createCustodianSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: formatZodError(parsed.error) }, { status: 400 });
  }
  try {
    const name = parsed.data.name.trim();
    const { contactEmail, avgProcessingDays } = parsed.data;
    // Same upsert as the tracker's admin add: a re-add of an existing name marks it reviewed.
    const created = await prisma.custodian.upsert({
      where: { name },
      update: { reviewStatus: "VERIFIED" },
      create: {
        name, reviewStatus: "VERIFIED",
        ...(contactEmail !== undefined ? { contactEmail } : {}),
        ...(avgProcessingDays !== undefined ? { avgProcessingDays } : {}),
      },
    });
    logger.info({ custodianId: created.id, by: auth.actor }, "machine custodian created");
    return NextResponse.json({ custodian: await loadStoredCustodian(created.id) }, { status: 201 });
  } catch (err) {
    logger.error({ err }, "machine custodian create failed");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
