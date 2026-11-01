import { NextRequest, NextResponse } from "next/server";
import { applyAcatCreate } from "@/lib/acat-record-write";
import { demoLimitResponse } from "@/lib/demo/limits";
import { prisma } from "@/lib/prisma";
import { acatClientLinksSelection, toOperationalAcat } from "@/lib/acat-identity-dto";
import { directoryErrorResponse } from "@/lib/client-identity-http";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/auth-helpers";
import { logger } from "@/lib/logger";
import { MAX_PAGE_SIZE } from "@/lib/acat-query-limits";

// Cross-user updates propagate via SWR polling + focus revalidation on the
// client. Mark this route dynamic so Next.js never data-caches the response
// and every client-side revalidation sees the latest DB state.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Read-surface hardening: bound how much a single request can pull. When the
// client passes ?limit=N we respect it (up to MAX_PAGE_SIZE). When it
// doesn't, we apply HARD_CAP — a backstop that keeps the un-paginated
// list view working while preventing a malicious/buggy client from asking
// for every row in the table.
const HARD_CAP = 5000;
const MAX_QUERY_LEN = 200;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const rawQ = searchParams.get("q");
  const includeDeleted = searchParams.get("includeDeleted") === "true";
  const limitParam = searchParams.get("limit");
  const cursor = searchParams.get("cursor"); // record id to start after

  if (includeDeleted) {
    const check = await requireAdmin();
    if (check instanceof NextResponse) return check;
  }

  if (rawQ != null && rawQ.length > MAX_QUERY_LEN) {
    return NextResponse.json(
      { error: `Query too long (max ${MAX_QUERY_LEN} chars)` },
      { status: 400 }
    );
  }
  const q = rawQ ?? undefined;

  let take: number;
  if (limitParam) {
    const parsed = Number.parseInt(limitParam, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return NextResponse.json(
        { error: "limit must be a positive integer" },
        { status: 400 }
      );
    }
    take = Math.min(parsed, MAX_PAGE_SIZE);
  } else {
    take = HARD_CAP;
  }

  const where: Prisma.AcatRecordWhereInput = includeDeleted
    ? {}
    : { deletedAt: null };

  if (status && status !== "All") {
    where.status = status as Prisma.EnumAcatStatusFilter;
  }

  if (q) {
    const query = q.toLowerCase();
    where.OR = [
      { clientName: { contains: query, mode: "insensitive" } },
      { cedarRidgeUserId: { contains: query, mode: "insensitive" } },
      { clientLinks: { some: { OR: [
        { cedarRidgeUserId: { contains: query, mode: "insensitive" } },
        { client: { canonicalName: { contains: query, mode: "insensitive" } } },
      ] } } },
      { crmDealId: { contains: query, mode: "insensitive" } },
      { apexAccountId: { contains: query, mode: "insensitive" } },
      { custodianName: { contains: query, mode: "insensitive" } },
      { controlNumber: { contains: query, mode: "insensitive" } },
      { acatTransferId: { contains: query, mode: "insensitive" } },
      { transferringContra: { contains: query, mode: "insensitive" } },
      { tradeRequestId: { contains: query, mode: "insensitive" } },
      { wealthAdvisor: { contains: query, mode: "insensitive" } },
      { direction: { contains: query, mode: "insensitive" } },
    ];
  }

  try {
    const results = await prisma.acatRecord.findMany({
      where,
      // ticket / ticket: eager-load the linked custodian so per-record
      // aging tier and expected-completion derivations can run client-side
      // without a second fetch round-trip. `Custodian.fees` is intentionally
      // not pulled — it's larger and only the detail page's FeesTab needs
      // it (which loads it separately via /api/custodians/[id]).
      include: {
        assets: true,
        clientLinks: acatClientLinksSelection,
        custodian: { omit: { requiresManualReview: true } },
      },
      // Tie-break on id so pages are stable when createdAt collides.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (limitParam) {
      // Paginated caller — return the structured shape so it can loop.
      const nextCursor = results.length === take ? results[results.length - 1]?.id ?? null : null;
      return NextResponse.json({ items: results.map(toOperationalAcat), nextCursor });
    }
    // Legacy unpaginated caller: return a plain array (existing UI contract).
    return NextResponse.json(results.map(toOperationalAcat));
  } catch (err) {
    logger.error({ err }, "GET /api/acats failed");
    return NextResponse.json(
      { error: "Failed to fetch ACAT records" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await applyAcatCreate({ body, performedBy: null });
    if (result.kind === "response") return result.response;
    return NextResponse.json(toOperationalAcat(result.record), { status: 201 });
  } catch (err) {
    const identityResponse = directoryErrorResponse(err);
    if (identityResponse) return identityResponse;
    const limitResponse = demoLimitResponse(err);
    if (limitResponse) return limitResponse;
    logger.error({ err }, "POST /api/acats failed");
    if (err instanceof SyntaxError) {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create ACAT record" },
      { status: 500 }
    );
  }
}
