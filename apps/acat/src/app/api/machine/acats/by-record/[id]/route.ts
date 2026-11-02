import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { verifyAcatReadCaller, verifyAcatWriteCaller } from "@/lib/machine-auth";
import { redactAcatForMachine } from "@/lib/mcp/redaction";
import { applyAcatPatch } from "@/lib/acat-record-write";
import { RECON_DERIVED_STATUSES, type AcatStatus } from "@/lib/types";
import { rateLimit } from "@/lib/rate-limit-redis";
import { drawerRedactionOptions } from "@/lib/acat-drawer-contract";

// Authenticated + live: never cache. The gate is per-request OIDC
// verification, not a session, so there is nothing to statically render.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Keyed per verified caller email (not IP) once auth succeeds.
const MACHINE_READ_LIMIT = { maxTokens: 120, interval: 60_000 };

/**
 * GET /api/machine/acats/by-record/[id]
 *
 * Server-to-server read of a single ACAT record BY ITS RECORD `id` — the PK
 * (`@id @default(cuid())`), which is UNIQUE and ALWAYS present. Authenticated by
 * a Google OIDC ID token (see `verifyAcatReadCaller`). Returns the same trimmed,
 * redacted projection (`redactAcatForMachine`) as the sibling
 * `/api/machine/acats/[acatTransferId]` read — account identifiers masked,
 * client PII omitted. NOT gated by NextAuth; this is a separate machine path.
 *
 * WHY A SEPARATE ROUTE: the `[acatTransferId]` read keys on `acatTransferId`,
 * which is NULLABLE and NON-UNIQUE — many real records share a placeholder
 * ("N/A") or null value, so a by-acatTransferId findFirst returns the single
 * newest match for every one of them (the advisor platform ACAT Tracking drawer bug). The
 * record `id` is the reliable per-record key: `findUnique` on it returns EXACTLY
 * that record or nothing. The `by-record` static segment sits alongside the
 * dynamic `[acatTransferId]` segment, so there is no routing ambiguity.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const caller = await verifyAcatReadCaller(request, "record");
  if (!caller) {
    // Opaque 401 — no reason, no caller, nothing that helps probe the gate.
    logger.warn({ id, status: 401 }, "machine ACAT read by record: unauthorized");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { allowed } = await rateLimit("machine-acat-read", caller.email, MACHINE_READ_LIMIT);
  if (!allowed) {
    logger.warn(
      { id, caller: caller.email, status: 429 },
      "machine ACAT read by record: rate limited"
    );
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // Defense-in-depth: a blank/undefined id must NEVER reach Prisma. Next.js
  // guarantees a non-empty dynamic segment today, but this makes the invariant
  // explicit and refactor-proof — an `undefined` value passed to findUnique
  // would be a type/runtime error, and a blank id can never match a real row.
  if (typeof id !== "string" || id.trim() === "") {
    logger.warn(
      { caller: caller.email, status: 404 },
      "machine ACAT read by record: blank id"
    );
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  try {
    // `id` is the PK (@id @default(cuid())) — GUARANTEED unique — so findUnique
    // returns exactly that record or null (never a DB-arbitrary row, unlike the
    // by-acatTransferId findFirst). Exclude soft-deleted rows to match the rest
    // of the app's read surface (an extra non-unique filter alongside the unique
    // `id`, supported by Prisma's findUnique where).
    const record = await prisma.acatRecord.findUnique({
      where: { id, deletedAt: null },
      include: { assets: true },
    });

    if (!record) {
      logger.info(
        { id, caller: caller.email, status: 404 },
        "machine ACAT read by record: not found"
      );
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    logger.info(
      { id, caller: caller.email, status: 200 },
      "machine ACAT read by record: ok"
    );
    return NextResponse.json(redactAcatForMachine(record, drawerRedactionOptions()));
  } catch (err) {
    logger.error(
      { err, id, caller: caller.email, status: 500 },
      "machine ACAT read by record: failed"
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

const MACHINE_WRITE_REJECTED = [
  "assets",
  "newAssets",
  "reconCompletedAt",
  "apexSource",
  "feeApexTicket",
  "feeCreditRequestId",
] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const caller = await verifyAcatWriteCaller(request, "update");
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { allowed } = await rateLimit("machine-acat-write", caller.email, {
    maxTokens: 60,
    interval: 60_000,
    failClosed: true,
  });
  if (!allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const body = await request.json();
  if (body && typeof body === "object") {
    if (MACHINE_WRITE_REJECTED.some((key) => key in body)) {
      return NextResponse.json({ error: "Field is not accepted on this path" }, { status: 400 });
    }
    const status = (body as { status?: unknown }).status;
    if (typeof status === "string" && RECON_DERIVED_STATUSES.has(status as AcatStatus)) {
      return NextResponse.json({ error: "Status is not a lifecycle status" }, { status: 400 });
    }
  }

  const result = await applyAcatPatch({ id, body, performedBy: caller.email });
  if (result.kind === "response") return result.response;
  return NextResponse.json(redactAcatForMachine(result.record, drawerRedactionOptions()));
}
