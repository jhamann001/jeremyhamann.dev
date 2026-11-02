import { NextResponse } from "next/server";
import { z } from "zod";
import { loadAdvisorAcats, resolveAdvisorListAccess } from "@/lib/advisor-list";
import { logger } from "@/lib/logger";
import { verifyAcatReadCaller } from "@/lib/machine-auth";
import { rateLimit } from "@/lib/rate-limit-redis";

// ticket: the tracker's advisor-redacted ACAT list for the advisor platform.
//
// A trusted machine caller names the signed-in person by work email in the
// X-OpsPortal-Actor-Email header (a header, so the email stays out of request logs).
// The tracker decides whether that person is an active advisor or admin and
// returns exactly the rows /api/advisor/acats serves. A person who is not
// allowed gets 403; an allowed person with no transfers gets 200 with an empty
// list. Read-only. User administration stays on the tracker.

export const dynamic = "force-dynamic";
export const revalidate = 0;

const emailSchema = z.string().trim().toLowerCase().email().max(254);

function enabled() {
  return process.env.ROLLOUT_ACAT_ADVISOR_LIST === "1";
}

export async function GET(request: Request) {
  if (!enabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const caller = await verifyAcatReadCaller(request, "advisor");
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { allowed } = await rateLimit("machine-advisor-acats", caller.email, {
    maxTokens: 60,
    interval: 60_000,
    failClosed: true,
  });
  if (!allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  const email = emailSchema.safeParse(request.headers.get("X-OpsPortal-Actor-Email"));
  if (!email.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  try {
    if ((await resolveAdvisorListAccess(email.data)) !== "allowed") {
      logger.info(
        { caller: caller.email, status: 403 },
        "machine advisor list: not allowed",
      );
      return NextResponse.json({ error: "not_allowed" }, { status: 403 });
    }
    const acats = await loadAdvisorAcats();
    logger.info(
      { caller: caller.email, count: acats.length, status: 200 },
      "machine advisor list: ok",
    );
    return NextResponse.json({ acats });
  } catch (err) {
    // Driver errors can echo the lookup arguments (the work email), so log only
    // the error's name and code, never the error object or its message.
    logger.error(
      {
        errorName: err instanceof Error ? err.name : "UnknownError",
        errorCode: (err as { code?: unknown } | null)?.code,
        caller: caller.email,
        status: 500,
      },
      "machine advisor list: failed",
    );
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
