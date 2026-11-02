import { requireOperationsSlackCronAuth } from "@/lib/cron/operations-slack-auth";
import { runOperationsSlackDelivery } from "@/lib/data/operations-slack-delivery";

export const runtime = "nodejs";
export const maxDuration = 60;
const denied = () => Response.json({ error: "method_not_allowed" }, { status: 405 });
export const GET = denied;
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;

export async function POST(req: Request): Promise<Response> {
  if (!await requireOperationsSlackCronAuth(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const result = await runOperationsSlackDelivery();
    // The response contains aggregate operational counters only. Explicit
    // failures/uncertainties must remain visible in scheduler monitoring.
    return Response.json(result, { status: result.blocked || result.failed || result.uncertain || result.expired ? 503 : 200 });
  } catch {
    console.error("[operations-slack] delivery_failed");
    return Response.json({ error: "delivery_failed" }, { status: 503 });
  }
}
