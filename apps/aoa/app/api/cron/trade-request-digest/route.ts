import { requireTradeRequestDigestCronAuth } from "@/lib/cron/trade-request-digest-auth";
import { tradeRequestsDigestJobEnabled } from "@/lib/flags";
import { runDailyDigest } from "@/lib/trade-requests/native/digest";
import { readServingState } from "@/lib/trade-requests/serving-state";

export const runtime = "nodejs";
export const maxDuration = 60;
const denied = () => Response.json({ error: "method_not_allowed" }, { status: 405 });
export const GET = denied;
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;

const NO_STORE = { "Cache-Control": "no-store, private" };

function skipped(reason: "switch_off" | "not_sender"): Response {
  console.info(JSON.stringify({ event: "trade_request_digest", outcome: reason }));
  return Response.json({ sent: false, reason }, { status: 200, headers: NO_STORE });
}

/** Cloud Scheduler target (weekdays 08:00 America/New_York). Posts only while AOA is the digest sender. */
export async function POST(req: Request): Promise<Response> {
  if (!(await requireTradeRequestDigestCronAuth(req))) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!tradeRequestsDigestJobEnabled()) return skipped("switch_off");
  if ((await readServingState()).digestSender !== "aoa") return skipped("not_sender");
  try {
    const result = await runDailyDigest();
    // A failed post keeps its claim (no retry); 503 keeps it visible in scheduler monitoring.
    return Response.json(result, { status: !result.sent && result.reason === "post_failed" ? 503 : 200, headers: NO_STORE });
  } catch {
    console.error(JSON.stringify({ event: "trade_request_digest", outcome: "error" }));
    return Response.json({ error: "digest_failed" }, { status: 503, headers: NO_STORE });
  }
}
