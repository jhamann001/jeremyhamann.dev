import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyCustodianProjectionCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";
import { applyCustodianProjection, custodianProjectionEnabled } from "@/lib/custodian-admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function projectionFailure(error: unknown): { status: 409; reason: "gap" | "mismatch" } | { status: 500 } | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { status?: unknown }).status;
  const reason = (error as { reason?: unknown }).reason;
  if (status === 409 && (reason === "gap" || reason === "mismatch")) return { status: 409, reason };
  if (status === 500) return { status: 500 };
  return null;
}

export async function POST(request: Request) {
  if (!custodianProjectionEnabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const caller = await verifyCustodianProjectionCaller(request);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { allowed } = await rateLimit("machine-custodian-projection", caller.email, {
    maxTokens: 60, interval: 60_000, failClosed: true,
  });
  if (!allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  let body: { revision: number; previousRevision: number | null; checksum: string; body: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const decision = await prisma.$transaction((tx) => applyCustodianProjection(tx, body));
    if (decision.outcome === "accepted") {
      return NextResponse.json({ outcome: "accepted", revision: decision.revision }, { status: 200 });
    }
    if (decision.outcome === "duplicate") {
      return NextResponse.json({ outcome: "duplicate", revision: decision.revision }, { status: 200 });
    }
    return NextResponse.json(
      { outcome: "rejected", revision: decision.revision, reason: decision.reason },
      { status: 409 }
    );
  } catch (error) {
    const failure = projectionFailure(error);
    if (failure?.status === 500) {
      return NextResponse.json({ error: "internal_error" }, { status: 500 });
    }
    if (failure?.status === 409) {
      return NextResponse.json(
        { outcome: "rejected", revision: body.revision, reason: failure.reason },
        { status: 409 }
      );
    }
    throw error;
  }
}
