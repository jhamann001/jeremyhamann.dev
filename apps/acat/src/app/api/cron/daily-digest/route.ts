import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { postToSlack, SlackWebhookError } from "@/lib/slack-webhook";
import { buildDigestSnapshot, formatDigestMessage } from "@/lib/daily-digest";
import type { AcatRecord } from "@/lib/types";

// ticket: Daily-digest cron endpoint.
//
// Triggered once a day by the `daily-digest.yml` GitHub Action (or
// any caller that holds the bearer secret — Cloud Scheduler is a
// future-proof alternative if GHA cron drift becomes a problem).
//
// Auth model: the route is exempted from session auth in Proxy
// and validates a bearer token (`DIGEST_CRON_TOKEN`) itself. This
// avoids carrying around a service-account session and keeps the
// secret rotatable with a single Secret Manager update.
//
// Behavior:
//   1. Load all live ACAT records (deletedAt: null) — current row
//      count is well under the 5k cap, no pagination needed.
//   2. Build the snapshot + Slack message via the pure helpers.
//   3. POST to Slack.
//   4. Return a small JSON summary so the GHA log shows what we sent.
//
// Failure modes:
//   - Missing/incorrect bearer → 401, no Slack post, no DB read.
//   - DB error → 500, no Slack post (so we don't ping the channel
//     with a half-empty digest).
//   - Slack 4xx/5xx → 502 with the underlying status surfaced.

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const expected = process.env.DIGEST_CRON_TOKEN?.trim();
  if (!expected) {
    logger.error("DIGEST_CRON_TOKEN is not configured");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (!constantTimeEqual(auth, `Bearer ${expected}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let records: AcatRecord[];
  try {
    records = (await prisma.acatRecord.findMany({
      where: { deletedAt: null },
      include: { assets: true },
    })) as unknown as AcatRecord[];
  } catch (err) {
    logger.error({ err }, "daily-digest: DB read failed");
    return NextResponse.json(
      { error: "Failed to load ACAT records" },
      { status: 500 }
    );
  }

  const now = Date.now();
  const snapshot = buildDigestSnapshot(records, now);
  const message = formatDigestMessage(snapshot, now);

  try {
    await postToSlack(message);
  } catch (err) {
    if (err instanceof SlackWebhookError) {
      logger.error(
        { err: { message: err.message, status: err.status } },
        "daily-digest: Slack post failed"
      );
      return NextResponse.json(
        { error: "Slack post failed", status: err.status ?? null },
        { status: 502 }
      );
    }
    logger.error({ err }, "daily-digest: unexpected error posting to Slack");
    return NextResponse.json(
      { error: "Slack post failed" },
      { status: 502 }
    );
  }

  logger.info(
    {
      active: snapshot.active,
      aging: snapshot.aging,
      withIssues: snapshot.withIssues,
      completed: snapshot.completed,
      openedYesterday: snapshot.openedYesterday.length,
      completedYesterday: snapshot.completedYesterday.length,
    },
    "daily-digest: posted"
  );

  return NextResponse.json({
    ok: true,
    sent: {
      active: snapshot.active,
      aging: snapshot.aging,
      withIssues: snapshot.withIssues,
      completed: snapshot.completed,
      openedYesterday: snapshot.openedYesterday.length,
      completedYesterday: snapshot.completedYesterday.length,
      stalest: snapshot.stalest.length,
    },
  });
}

/**
 * Constant-time string compare to avoid leaking the bearer token
 * one byte at a time via timing. Falls back to length mismatch on
 * obviously-bad input.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
