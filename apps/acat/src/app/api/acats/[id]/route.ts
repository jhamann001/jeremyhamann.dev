import { NextRequest, NextResponse } from "next/server";
import { applyAcatPatch } from "@/lib/acat-record-write";
import { demoLimitResponse } from "@/lib/demo/limits";
import { personaSignInEnabled } from "@/lib/demo/personas";
import { prisma } from "@/lib/prisma";
import { acatClientLinksSelection, toOperationalAcat } from "@/lib/acat-identity-dto";
import { directoryErrorResponse } from "@/lib/client-identity-http";
import { auth } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-helpers";
import { rateLimit, rateLimitKey } from "@/lib/rate-limit-redis";
import { deleteAcatSchema, formatZodError } from "@/lib/validators";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DELETE_RATE_LIMIT = {
  maxTokens: 20,
  interval: 60 * 60 * 1000,
};


export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const record = await prisma.acatRecord.findUnique({
      where: { id, deletedAt: null },
      // ticket / ticket: eager-load the linked custodian so the detail
      // drawer can render per-record aging + expected completion without
      // an extra fetch. Keeps the shape consistent with GET /api/acats.
      include: {
        assets: true,
        clientLinks: acatClientLinksSelection,
        custodian: { omit: { requiresManualReview: true } },
      },
    });

    if (!record) {
      return NextResponse.json(
        { error: "ACAT record not found" },
        { status: 404 }
      );
    }

    // Phase 3.3: write-side audit trail for single-record reads.
    // We deliberately do NOT audit the list endpoint (GET /api/acats)
    // — that would add one row per listed record on every page load
    // and drown out the signal. Drill-down reads on a specific ACAT
    // are what matter for forensics ("who looked at this client's
    // transfer?"). Errors inside the audit write must never fail
    // the read itself.
    const session = await auth();
    const viewer = session?.user?.email ?? null;
    // Not in the demo: every visitor is one of three shared accounts, so "who looked" says nothing,
    // and each drawer open would add to the demo's capped history.
    if (viewer && !personaSignInEnabled()) {
      // Wrap with Promise.resolve so tests using a bare vi.fn() mock
      // (which returns undefined) don't explode on `.catch`. In prod
      // Prisma always returns a thenable.
      Promise.resolve(
        prisma.auditLog.create({
          data: {
            acatRecordId: id,
            action: "read",
            performedBy: viewer,
          },
        })
      ).catch((err) => {
        logger.warn(
          { err, acatId: id, viewer },
          "failed to write read audit log (read still returned)"
        );
      });
    }

    return NextResponse.json(toOperationalAcat(record));
  } catch (err) {
    logger.error({ err, acatId: id }, "GET /api/acats/[id] failed");
    return NextResponse.json(
      { error: "Failed to fetch ACAT record" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = await auth();
    const performedBy = session?.user?.email ?? null;
    const body = await request.json();
    const result = await applyAcatPatch({ id, body, performedBy });
    if (result.kind === "response") return result.response;
    return NextResponse.json(toOperationalAcat(result.record));
  } catch (err) {
    const identityResponse = directoryErrorResponse(err);
    if (identityResponse) return identityResponse;
    const limitResponse = demoLimitResponse(err);
    if (limitResponse) return limitResponse;
    logger.error({ err, acatId: id }, "PATCH /api/acats/[id] failed");
    return NextResponse.json(
      { error: "Failed to update ACAT record" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;
  const email = check.email;

  const { allowed } = await rateLimit("acat-delete", rateLimitKey(email, request.headers.get("x-forwarded-for")), DELETE_RATE_LIMIT);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many delete requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const parsed = deleteAcatSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: formatZodError(parsed.error) },
        { status: 400 }
      );
    }
    const { reason } = parsed.data;

    const existing = await prisma.acatRecord.findUnique({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "ACAT record not found" },
        { status: 404 }
      );
    }

    await prisma.$transaction([
      prisma.acatRecord.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          acatRecordId: id,
          action: "DELETE",
          newValue: reason,
          performedBy: email,
        },
      }),
    ]);

    logger.info(
      { acatId: id, deletedBy: email, reason },
      "ACAT soft-deleted"
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error({ err, acatId: id }, "DELETE /api/acats/[id] failed");
    return NextResponse.json(
      { error: "Failed to delete ACAT record" },
      { status: 500 }
    );
  }
}
