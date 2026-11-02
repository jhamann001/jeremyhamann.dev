import { requireTradeRequestDriftCronAuth } from "@/lib/cron/trade-request-drift-auth";
import { tradeRequestsDriftJobMode } from "@/lib/flags";
import { readServingState } from "@/lib/trade-requests/serving-state";
import { appPool } from "@/lib/trade-requests/pg-compat";
import { runDriftCheck } from "@/lib/trade-requests/drift/registry-drift-runner";
import type { DriftRunTarget } from "@/lib/trade-requests/drift/targets";
import { SnapshotLoadError } from "@/lib/trade-requests/sources/meridian-snapshot";
import { ActiveAccountsLoadError } from "@/lib/trade-requests/sources/meridian-active-accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

const HEADERS = { "Cache-Control": "no-store, private" } as const;
const denied = () => Response.json({ error: "method_not_allowed" }, { status: 405, headers: HEADERS });
export const GET = denied;
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;

const stillSender = async () => (await readServingState()).driftSender === "aoa";

// Weekday drift check (ticket), the port of the standalone POST /api/internal/drift/check. Mode off: 204, no
// work. Shadow, or live while AOA is not the drift sender: shadow tables only, nothing sent. Live while AOA is the
// drift sender: live tables, the once-per-date alert claim and the override reminders. Any failed input (or any
// other failure) answers 503 so the scheduler retries; the body carries counts or a fixed error code only.
export async function POST(req: Request): Promise<Response> {
  if (!(await requireTradeRequestDriftCronAuth(req))) return Response.json({ error: "unauthorized" }, { status: 401, headers: HEADERS });
  const mode = tradeRequestsDriftJobMode();
  if (mode === "off") return new Response(null, { status: 204, headers: HEADERS });
  const target: DriftRunTarget = mode === "live" && (await stillSender()) ? { kind: "live", stillSender } : { kind: "shadow" };
  try {
    const summary = await runDriftCheck({ pool: await appPool() }, target);
    return Response.json(
      {
        mode: target.kind,
        runDateLocal: summary.runDateLocal,
        households: summary.totalHouseholds,
        householdRowsInserted: summary.insertedRows,
        accounts: summary.accountDrift.totalAccounts,
        outAccounts: summary.accountDrift.outAccounts,
        accountRowsInserted: summary.accountDrift.insertedRows,
        alertSent: summary.accountDrift.alert.sent,
      },
      { headers: HEADERS },
    );
  } catch (err) {
    const error = err instanceof SnapshotLoadError ? "snapshot_unavailable"
      : err instanceof ActiveAccountsLoadError ? "active_accounts_unavailable"
      : "drift_check_failed";
    console.error(JSON.stringify({ event: "trade_request_drift_failed", mode: target.kind, error }));
    return Response.json({ error }, { status: 503, headers: HEADERS });
  }
}
