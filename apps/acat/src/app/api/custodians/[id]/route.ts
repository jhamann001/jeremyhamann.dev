import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-helpers";
import {
  custodianEditBlockedResponse,
  trackerCustodianEditsRetired,
  custodianEditsRetiredResponse,
} from "@/lib/custodian-admin";
import { updateCustodianSchema, formatZodError } from "@/lib/validators";
import { logger } from "@/lib/logger";
import { toCustodianResponse } from "@/lib/custodian-serialization";
import { normalizeCustodianContactUpdate } from "@/lib/custodian-contact";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const custodian = await prisma.custodian.findUnique({
      where: { id },
      include: { fees: { orderBy: { feeType: "asc" } } },
    });
    if (!custodian) {
      return NextResponse.json(
        { error: "Custodian not found" },
        { status: 404 }
      );
    }
    // `linkedRecordCount` drives the admin "danger zone": delete when 0,
    // else merge. Count soft-deleted rows too — they still carry the FK and
    // define the `onDelete: SetDefault` blast radius. `reviewStatus` is a
    // scalar and already included automatically.
    const [linkedRecordCount, feeScheduleDocumentCount] = await Promise.all([
      prisma.acatRecord.count({ where: { custodianId: id } }),
      prisma.custodianFeeScheduleDocument.count({ where: { custodianId: id } }),
    ]);
    return NextResponse.json({
      ...toCustodianResponse(custodian),
      linkedRecordCount,
      feeScheduleDocumentCount,
    });
  } catch (err) {
    logger.error({ err, custodianId: id }, "GET /api/custodians/[id] failed");
    return NextResponse.json(
      { error: "Failed to fetch custodian" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;
  const blocked = custodianEditBlockedResponse();
  if (blocked) return blocked;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  const { email } = check;
  const { id } = await params;

  try {
    const existing = await prisma.custodian.findUnique({ where: { id } });
    if (!existing) {
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

    const parsed = updateCustodianSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }

    const data = normalizeCustodianContactUpdate(parsed.data, existing);
    const updated = await prisma.custodian.update({
      where: { id },
      data,
      include: { fees: { orderBy: { feeType: "asc" } } },
    });

    logger.info(
      { custodianId: id, by: email, fields: Object.keys(data) },
      "custodian updated"
    );
    return NextResponse.json(toCustodianResponse(updated));
  } catch (err) {
    logger.error({ err, custodianId: id }, "PATCH /api/custodians/[id] failed");
    return NextResponse.json(
      { error: "Failed to update custodian" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;
  const blocked = custodianEditBlockedResponse();
  if (blocked) return blocked;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();
  const { email } = check;
  const { id } = await params;

  try {
    const existing = await prisma.custodian.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Custodian not found" },
        { status: 404 }
      );
    }

    // Block deletion while any ACAT record still points at this custodian.
    // Count soft-deleted rows too — they carry the FK and define the
    // `onDelete: SetDefault` blast radius. When linked, the admin UI offers
    // "Merge into…" instead.
    //
    // Re-count and delete in one transaction so a record can't be linked
    // between the count and the delete (which would orphan it via
    // onDelete: SetDefault). A sentinel error carries the fresh count out to
    // the existing 409 shape.
    await prisma.$transaction(async (tx) => {
      const [linkedRecordCount, feeScheduleDocumentCount] = await Promise.all([
        tx.acatRecord.count({ where: { custodianId: id } }),
        tx.custodianFeeScheduleDocument.count({ where: { custodianId: id } }),
      ]);
      if (linkedRecordCount > 0 || feeScheduleDocumentCount > 0) {
        const err = new Error("CUSTODIAN_HAS_LINKED_RECORDS") as Error & {
          linkedRecordCount: number;
          feeScheduleDocumentCount: number;
        };
        err.linkedRecordCount = linkedRecordCount;
        err.feeScheduleDocumentCount = feeScheduleDocumentCount;
        throw err;
      }
      // No linked records — safe to delete. Fees cascade (onDelete: Cascade).
      await tx.custodian.delete({ where: { id } });
    });

    logger.info({ custodianId: id, by: email }, "custodian deleted");
    return NextResponse.json({ success: true });
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "CUSTODIAN_HAS_LINKED_RECORDS"
    ) {
      return NextResponse.json(
        {
          error:
            "Custodian has linked ACAT records or attached fee schedules. Merge it into another custodian instead of deleting.",
          linkedRecordCount: (err as Error & { linkedRecordCount: number })
            .linkedRecordCount,
          feeScheduleDocumentCount: (err as Error & { feeScheduleDocumentCount: number })
            .feeScheduleDocumentCount,
        },
        { status: 409 }
      );
    }
    // The document FK also prevents a concurrent upload from being deleted
    // between the count and delete above.
    if (typeof err === "object" && err !== null && "code" in err && err.code === "P2003") {
      return NextResponse.json({ error: "Custodian has linked records or fee schedules. Refresh and merge it into another custodian instead." }, { status: 409 });
    }
    logger.error({ err, custodianId: id }, "DELETE /api/custodians/[id] failed");
    return NextResponse.json(
      { error: "Failed to delete custodian" },
      { status: 500 }
    );
  }
}
