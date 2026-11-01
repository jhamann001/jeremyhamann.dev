import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { demoMode } from "@/lib/demo/mode";
import {
  importAssetMappingSpreadsheet,
  syncAssetMappingFromGcp,
  syncFailure,
  importFailure,
  type MappingRefusal,
} from "@/lib/asset-mapping-actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function refusal(result: MappingRefusal) {
  return NextResponse.json(
    { error: result.message, ...(result.code ? { code: result.code } : {}) },
    { status: result.status }
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const acatId = searchParams.get("acatId");

  if (!acatId) {
    return NextResponse.json(
      { error: "acatId is required" },
      { status: 400 }
    );
  }

  try {
    const acat = await prisma.acatRecord.findUnique({
      where: { id: acatId, deletedAt: null },
      include: { assets: true },
    });

    if (!acat) {
      return NextResponse.json(
        { error: "ACAT not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      acatId: acat.id,
      mappingSource: acat.mappingSource,
      apexSource: acat.apexSource,
      assets: acat.assets,
      lastSynced: acat.mappingSyncedAt ?? null,
      sourceAccount: acat.mappingAccountSummary ?? null,
    });
  } catch (err) {
    logger.error({ err }, "GET /api/asset-mapping failed");
    return NextResponse.json(
      { error: "Failed to fetch asset mapping" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "USER" && session.user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const body = await request.json();
    const acatId = body.acatId;

    if (!acatId) {
      return NextResponse.json(
        { error: "acatId is required" },
        { status: 400 }
      );
    }

    if (body.sourceAccountId !== undefined && !z.string().uuid().safeParse(body.sourceAccountId).success) {
      return NextResponse.json({ error: "Choose a valid source account." }, { status: 400 });
    }

    const acat = await prisma.acatRecord.findUnique({
      where: { id: acatId, deletedAt: null },
      include: { assets: true },
    });

    if (!acat) {
      return NextResponse.json(
        { error: "ACAT not found" },
        { status: 404 }
      );
    }

    if (body.source === "spreadsheet") {
      if (demoMode()) {
        return NextResponse.json({ error: "Uploads are off in this demo. Sync the positions from asset mapping instead." }, { status: 403 });
      }
      const result = await importAssetMappingSpreadsheet(acat, body, session.user.email);
      if (result.kind === "refused") return refusal(result);
      try {
        const updated = await prisma.acatRecord.findUnique({
          where: { id: acatId },
          include: { assets: true },
        });
        return NextResponse.json({
          acatId: updated!.id,
          mappingSource: updated!.mappingSource,
          apexSource: updated!.apexSource,
          assets: updated!.assets,
          lastSynced: updated!.mappingSyncedAt ?? null,
        });
      } catch (err) {
        return refusal(importFailure(err));
      }
    }

    const result = await syncAssetMappingFromGcp(acat, body.sourceAccountId);
    if (result.kind === "refused") return refusal(result);

    const updated = await prisma.acatRecord.findUnique({
      where: { id: acatId },
      include: { assets: true },
    });

    return NextResponse.json({
      acatId: updated!.id,
      mappingSource: updated!.mappingSource,
      apexSource: updated!.apexSource,
      assets: updated!.assets,
      lastSynced: updated!.mappingSyncedAt ?? null,
      sourceAccount: updated!.mappingAccountSummary ?? null,
    });
  } catch (err) {
    // Failures before the mapping action runs (body parse, record lookup, or
    // the re-read after it) map exactly as a thrown sync error does.
    return refusal(syncFailure(err));
  }
}
