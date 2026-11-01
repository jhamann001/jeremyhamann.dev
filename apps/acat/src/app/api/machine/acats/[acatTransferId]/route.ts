import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { verifyAcatReadCaller } from "@/lib/machine-auth";
import { redactAcatForMachine } from "@/lib/mcp/redaction";
import { rateLimit } from "@/lib/rate-limit-redis";

// Authenticated + live: never cache. The gate is per-request OIDC
// verification, not a session, so there is nothing to statically render.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Keyed per verified caller email (not IP) once auth succeeds.
const MACHINE_READ_LIMIT = { maxTokens: 120, interval: 60_000 };

/**
 * GET /api/machine/acats/[acatTransferId]
 *
 * Server-to-server read of a single ACAT record's status, authenticated by a
 * Google OIDC ID token (see `verifyAcatReadCaller`). Returns a trimmed,
 * redacted projection (`redactAcatForMachine`) — account identifiers masked,
 * client PII omitted. NOT gated by NextAuth; this is a separate machine path.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ acatTransferId: string }> }
) {
  const { acatTransferId } = await params;

  const caller = await verifyAcatReadCaller(request, "transfer");
  if (!caller) {
    // Opaque 401 — no reason, no caller, nothing that helps probe the gate.
    logger.warn({ acatTransferId, status: 401 }, "machine ACAT read: unauthorized");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { allowed } = await rateLimit("machine-acat-read", caller.email, MACHINE_READ_LIMIT);
  if (!allowed) {
    logger.warn(
      { acatTransferId, caller: caller.email, status: 429 },
      "machine ACAT read: rate limited"
    );
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Defense-in-depth: a blank/undefined id must NEVER reach Prisma. Next.js
  // guarantees a non-empty dynamic segment today, but this makes the
  // "never drops the where filter / never matches a null-valued row" invariant
  // explicit and refactor-proof — an `undefined` value would drop the filter
  // and `findFirst` would then return an arbitrary client's record.
  if (typeof acatTransferId !== "string" || acatTransferId.trim() === "") {
    logger.warn(
      { caller: caller.email, status: 404 },
      "machine ACAT read: blank acatTransferId"
    );
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    // `acatTransferId` is nullable and NOT @unique on AcatRecord, so we use
    // findFirst (not findUnique). Exclude soft-deleted rows to match the rest
    // of the app's read surface. Deterministic orderBy so a hypothetical
    // duplicate acatTransferId can't silently return a DB-arbitrary row.
    const record = await prisma.acatRecord.findFirst({
      where: { acatTransferId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: { assets: true },
    });

    if (!record) {
      logger.info(
        { acatTransferId, caller: caller.email, status: 404 },
        "machine ACAT read: not found"
      );
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    logger.info(
      { acatTransferId, caller: caller.email, status: 200 },
      "machine ACAT read: ok"
    );
    return NextResponse.json(redactAcatForMachine(record));
  } catch (err) {
    logger.error(
      { err, acatTransferId, caller: caller.email, status: 500 },
      "machine ACAT read: failed"
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
