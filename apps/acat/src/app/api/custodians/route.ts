import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { createCustodianSchema, formatZodError } from "@/lib/validators";
import { logger } from "@/lib/logger";
import { demoLimitResponse, withDemoQuota } from "@/lib/demo/limits";
import { loadObservedCustodianTimings } from "@/lib/custodian-timing-data";
import { toCustodianResponse } from "@/lib/custodian-serialization";
import {
  custodianEditBlockedResponse,
  trackerCustodianEditsRetired,
  custodianEditsRetiredResponse,
} from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  // Callers that want the fee schedule pass `?includeFees=1`. Default omits
  // the join so the dropdown list stays lean.
  const includeFees = searchParams.get("includeFees") === "1";
  // ticket: only the admin custodian-library page needs the inbound aggregate
  // (`?withInbound=1`). The ACAT/merge dropdowns never read it, so the extra
  // groupBy over AcatRecord stays off their path.
  const withInbound = searchParams.get("withInbound") === "1";

  try {
    if (id) {
      const custodian = await prisma.custodian.findUnique({
        where: { id },
        include: includeFees ? { fees: { orderBy: { feeType: "asc" } } } : undefined,
      });
      if (!custodian) {
        return NextResponse.json(
          { error: "Custodian not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(toCustodianResponse(custodian));
    }

    const custodians = await prisma.custodian.findMany({
      orderBy: { name: "asc" },
      include: includeFees ? { fees: { orderBy: { feeType: "asc" } } } : undefined,
    });

    const safeCustodians = custodians.map(toCustodianResponse);

    if (!withInbound) return NextResponse.json(safeCustodians);

    // ticket: a custodian "needs a playbook" only if we've actually received
    // assets from it — i.e. it has >=1 linked ACAT with direction "In". This
    // read-only aggregate drives the landing flag so outbound-only and
    // zero-record contras (Apex / Interactive Brokers / Northwestern Mutual)
    // aren't nagged. Match "In"/"Out" case-insensitively.
    const [inbound, timingByCustodian] = await Promise.all([
      prisma.acatRecord.groupBy({
        by: ["custodianId"],
        where: {
          direction: { equals: "In", mode: "insensitive" },
          deletedAt: null,
          custodianId: { not: null },
        },
        _count: { _all: true },
      }),
      loadObservedCustodianTimings(),
    ]);
    const inboundIds = new Set(inbound.map((r) => r.custodianId));
    const annotated = safeCustodians.map((c) => {
      const timing = timingByCustodian.get(c.id);
      return {
        ...c,
        hasInboundRecords: inboundIds.has(c.id),
        observedAvgProcessingBusinessDays:
          timing?.observedAvgProcessingBusinessDays ?? null,
        observedCompletedTransfers: timing?.observedCompletedTransfers ?? 0,
      };
    });
    return NextResponse.json(annotated);
  } catch (err) {
    logger.error({ err }, "GET /api/custodians failed");
    return NextResponse.json(
      { error: "Failed to fetch custodians" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const blocked = custodianEditBlockedResponse();
  if (blocked) return blocked;
  if (trackerCustodianEditsRetired()) return custodianEditsRetiredResponse();

  try {
    const body = await request.json();
    const parsed = createCustodianSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }

    const name = parsed.data.name.trim();
    const { contactEmail, avgProcessingDays } = parsed.data;
    // A re-add of an existing name only marks it reviewed, so it adds nothing.
    const isNew = async (db: Prisma.TransactionClient) =>
      (await db.custodian.findUnique({ where: { name }, select: { id: true } })) ? 0 : 1;
    const custodian = await withDemoQuota({ custodians: isNew }, (db) => db.custodian.upsert({
      where: { name },
      // A deliberate admin re-add of an existing name marks it reviewed —
      // clears NEEDS_SETUP if the card was auto-created from ingest.
      update: { reviewStatus: "VERIFIED" },
      create: {
        name,
        // A deliberate admin add is pre-verified — it never enters the
        // NEEDS_SETUP review queue (unlike auto-created contras from ingest).
        reviewStatus: "VERIFIED",
        ...(contactEmail !== undefined ? { contactEmail } : {}),
        ...(avgProcessingDays !== undefined ? { avgProcessingDays } : {}),
      },
    }));

    return NextResponse.json(toCustodianResponse(custodian), { status: 201 });
  } catch (err) {
    const limitResponse = demoLimitResponse(err);
    if (limitResponse) return limitResponse;
    logger.error({ err }, "POST /api/custodians failed");
    if (err instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to create custodian" },
      { status: 500 }
    );
  }
}
