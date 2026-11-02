import type { Prisma } from "@prisma/client";
import { FEED_HEALTH, writeAudit } from "@/lib/audit";
import { checkAumFreshness } from "@/lib/data/feed-health";
import { requireIngestToken } from "@/lib/ingest/auth";
import { withIngestScope } from "@/lib/ingest/scope";

// Node runtime: crypto (auth) + Prisma. A data-FRESHNESS / health monitor for
// the account-AUM feed (mirror.client_account_aum). Both GET and POST are
// allowed — an uptime/n8n/scheduler monitor may probe with either — and every
// other verb is 405. Auth REUSES the ingest bearer token (requireIngestToken →
// INGEST_TOKEN); the /api/cron/* subtree is already middleware-excluded. No new
// secret. This route READS the feed only; it never writes mirror.*.
export const runtime = "nodejs";

const FEED = "account-aum";

const err = (error: string, status: number) =>
  Response.json({ error }, { status });

function methodNotAllowed(): Response {
  return err("method_not_allowed", 405);
}
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

/**
 * Best-effort Slack alert on a STALE verdict. NEVER throws, NEVER changes the
 * HTTP response, and NEVER logs the webhook URL or the token. If the env var is
 * unset we skip silently (the monitor still returns 503 + writes the audit row).
 */
async function postSlackAlert(text: string): Promise<void> {
  const webhook = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!webhook) return; // no webhook configured → skip silently
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    // Swallow — a Slack outage must not fail the health check. Static marker
    // only; never echo the webhook URL.
    console.error("[cron:aum-freshness] slack_alert_failed");
  }
}

async function handle(req: Request): Promise<Response> {
  // 1. Auth — same bearer gate the ingest routes use. Never logs the token.
  if (!requireIngestToken(req).ok) return err("unauthorized", 401);

  // 2. Read the feed stats + evaluate freshness. A DB failure here is a genuine
  //    500 (the check couldn't run) — distinct from a 503 "feed is stale".
  let result: Awaited<ReturnType<typeof checkAumFreshness>>;
  try {
    result = await checkAumFreshness();
  } catch {
    console.error("[cron:aum-freshness] check_failed");
    return err("internal", 500);
  }

  const body = {
    ok: result.ok,
    feed: FEED,
    reason: result.reason,
    expectedMinAsOf: result.expectedMinAsOf,
    maxAsOf: result.maxAsOf,
    maxSyncedAt: result.maxSyncedAt ? result.maxSyncedAt.toISOString() : null,
    staleByTradingDays: result.staleByTradingDays,
    rowCount: result.rowCount,
    syncAgeHours: result.syncAgeHours,
    openAccountCount: result.openAccountCount,
    currentOpenAccountCount: result.currentOpenAccountCount,
    corporateCurrentCount: result.corporateCurrentCount,
    missingCloseDateCount: result.missingCloseDateCount,
    reconciliationFailureCount: result.reconciliationFailureCount,
    expectedRowCount: result.expectedRowCount,
  };

  // 3. Healthy → 200 and done. No audit row on a non-event.
  if (result.ok) {
    return Response.json(body, { status: 200 });
  }

  // 4. STALE → write a counts/reason-only audit row (no PII, no secrets), via
  //    withIngestScope like the ingest routes' audit. An audit-write failure
  //    must not mask the stale verdict, so it is caught and logged, not thrown.
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
            maxAsOf: result.maxAsOf,
            expectedMinAsOf: result.expectedMinAsOf,
            staleByTradingDays: result.staleByTradingDays,
            rowCount: result.rowCount,
            openAccountCount: result.openAccountCount,
            currentOpenAccountCount: result.currentOpenAccountCount,
            corporateCurrentCount: result.corporateCurrentCount,
            missingCloseDateCount: result.missingCloseDateCount,
            reconciliationFailureCount: result.reconciliationFailureCount,
            expectedRowCount: result.expectedRowCount,
          },
        },
      ),
    );
  } catch {
    console.error("[cron:aum-freshness] audit_write_failed");
  }

  // 5. Best-effort Slack (never throws, never changes the response). Reason-aware
  //    copy — "0 trading days behind" reads wrong for an empty/dead-cron feed.
  const alert =
    result.reason === "empty"
      ? `⚠️ AUM feed EMPTY — no rows in mirror.client_account_aum (expected data ≥ ${result.expectedMinAsOf}). The daily pull likely never populated the table.`
      : result.reason === "stale_sync"
        ? `⚠️ AUM feed pull looks DEAD — last sync ${result.syncAgeHours}h ago (freshest as_of=${result.maxAsOf ?? "none"}). Check the daily cron.`
        : result.reason === "incomplete_coverage"
          ? `⚠️ AUM snapshot coverage failed — ${result.currentOpenAccountCount ?? 0}/${result.openAccountCount ?? 0} open accounts current; ${result.corporateCurrentCount ?? 0}/${4} corporate accounts current.`
          : result.reason === "reconciliation_failed"
            ? `⚠️ AUM balance reconciliation failed for ${result.reconciliationFailureCount ?? 0} account(s).`
            : result.reason === "close_date_missing"
              ? `⚠️ AUM lifecycle coverage failed — ${result.missingCloseDateCount ?? 0} closed account(s) lack a close date.`
              : `⚠️ AUM feed stale: freshest as_of=${result.maxAsOf ?? "none"}, expected ≥ ${result.expectedMinAsOf} (${result.staleByTradingDays} trading day(s) behind).`;
  await postSlackAlert(alert);

  // 503 so an uptime/n8n/scheduler check triggers on the non-200.
  return Response.json(body, { status: 503 });
}

export const GET = handle;
export const POST = handle;
