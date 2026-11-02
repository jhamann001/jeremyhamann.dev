import { requireReviewQueueCronAuth } from "@/lib/cron/review-queue-auth";
import { reviewQueueMaterializationEnabled } from "@/lib/flags";
import {
  REVIEW_QUEUE_BATCH_MAX,
  REVIEW_QUEUE_CRM_BATCH_MAX,
  REVIEW_QUEUE_MATERIALIZATION_BUSY,
} from "@/lib/data/review-queue-materialize";
import { runReviewQueueSweepStep } from "@/lib/data/review-queue-sweep";

export const runtime = "nodejs";
export const maxDuration = 300;

const error = (message: string, status: number) =>
  Response.json({ error: message }, { status });
const methodNotAllowed = () => error("method_not_allowed", 405);
export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

function boundedInt(value: string | null, max: number): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return undefined;
  return parsed;
}

export async function POST(req: Request): Promise<Response> {
  if (!(await requireReviewQueueCronAuth(req))) return error("unauthorized", 401);
  if (!reviewQueueMaterializationEnabled()) {
    return Response.json({ materialized: 0, skipped: "flag_off" });
  }

  const params = new URL(req.url).searchParams;
  const limit = boundedInt(params.get("limit"), REVIEW_QUEUE_BATCH_MAX);
  const crmLimit = boundedInt(params.get("crmLimit"), REVIEW_QUEUE_CRM_BATCH_MAX);
  if ((params.has("limit") && !limit) || (params.has("crmLimit") && !crmLimit)) {
    return error("invalid_limit", 400);
  }

  try {
    const result = await runReviewQueueSweepStep({ limit, crmLimit });
    const body = {
      materialized: result.changes.opened + result.changes.refreshed,
      trade: {
        processed: result.trade.processed,
        failed: result.trade.failed,
        hasMore: result.trade.hasMore,
      },
      crm: {
        processed: result.crm.processed,
        failed: result.crm.failed,
        hasMore: result.crm.hasMore,
      },
      changes: result.changes,
      sweep: result.sweep,
    };
    // A source-level failure is not a successful scheduler execution. Returning
    // 503 makes the failure visible in Cloud Scheduler while the persisted
    // checkpoint prevents unsafe source-clears and permits the next retry.
    return Response.json(body, {
      status: result.sweep.failed ? 503 : 200,
    });
  } catch (caught) {
    if (caught instanceof Error && caught.message === REVIEW_QUEUE_MATERIALIZATION_BUSY) {
      return Response.json({ materialized: 0, skipped: "already_running" }, { status: 202 });
    }
    console.error("[review-queue] materialization_failed");
    return error("internal", 500);
  }
}
