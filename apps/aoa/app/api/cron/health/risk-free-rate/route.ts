import type { Prisma } from "@prisma/client";
import { FEED_HEALTH, writeAudit } from "@/lib/audit";
import { checkRiskFreeFreshness } from "@/lib/data/risk-free-rate-health";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";

export const runtime = "nodejs";

const FEED = "treasury-risk-free-rate";
const err = (error: string, status: number) => Response.json({ error }, { status });
function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

async function postSlackAlert(text: string): Promise<void> {
  const webhook = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    console.error("[cron:risk-free-rate-health] slack_alert_failed");
  }
}

async function handle(req: Request): Promise<Response> {
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  let result: Awaited<ReturnType<typeof checkRiskFreeFreshness>>;
  try {
    result = await checkRiskFreeFreshness();
  } catch {
    console.error("[cron:risk-free-rate-health] check_failed");
    return err("internal", 500);
  }

  const body = {
    ok: result.ok,
    feed: FEED,
    reason: result.reason,
    expectedMinRateDate: result.expectedMinRateDate,
    maxRateDate: result.maxRateDate,
    maxSyncedAt: result.maxSyncedAt?.toISOString() ?? null,
    staleByTradingDays: result.staleByTradingDays,
    rowCount: result.rowCount,
    syncAgeHours: result.syncAgeHours,
  };
  if (result.ok) return Response.json(body, { status: 200 });

  try {
    await withIngestScope((tx) =>
      writeAudit(
        tx as Prisma.TransactionClient,
        { role: "INGEST", email: null },
        {
          action: FEED_HEALTH,
          entityType: "feed_health",
          entityId: FEED,
          detail: {
            feed: FEED,
            reason: result.reason,
            maxRateDate: result.maxRateDate,
            expectedMinRateDate: result.expectedMinRateDate,
            staleByTradingDays: result.staleByTradingDays,
            rowCount: result.rowCount,
            syncAgeHours: result.syncAgeHours,
          },
        },
      ),
    );
  } catch {
    // A monitoring-audit failure must not turn a stale verdict into a 500.
    console.error("[cron:risk-free-rate-health] audit_write_failed");
  }

  const alert =
    result.reason === "empty"
      ? "⚠️ Treasury rate feed EMPTY — no 3-month rate rows are stored. Performance reports will omit Sharpe ratios."
      : result.reason === "stale_sync"
        ? `⚠️ Treasury rate workflow looks DEAD — last stored write was ${result.syncAgeHours == null ? "unknown" : `${result.syncAgeHours.toFixed(1)}h`} ago. Performance reports may omit Sharpe ratios.`
        : `⚠️ Treasury rate feed stale: newest rate=${result.maxRateDate ?? "none"}, expected ≥ ${result.expectedMinRateDate} (${result.staleByTradingDays} trading day(s) behind). Performance reports may omit Sharpe ratios.`;
  await postSlackAlert(alert);

  // A non-200 also makes the missed/stale state visible to Cloud Scheduler or
  // any external uptime monitor even when Slack itself is unavailable.
  return Response.json(body, { status: 503 });
}

export const GET = handle;
export const POST = handle;
