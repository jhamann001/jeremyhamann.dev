import { requireCustodianProjectionCronAuth } from "@/lib/cron/custodian-projection-auth";
import { runCustodianProjectionDelivery } from "@/lib/data/custodian-projection-dispatch";
import { custodianChangeDeliveryEnabled } from "@/lib/flags";

export const runtime = "nodejs";
export const maxDuration = 60;
const denied = () => Response.json({ error: "method_not_allowed" }, { status: 405 });
export const GET = denied;
export const PUT = denied;
export const PATCH = denied;
export const DELETE = denied;

const NO_STORE = { "Cache-Control": "no-store, private" };

export async function POST(req: Request): Promise<Response> {
  if (!(await requireCustodianProjectionCronAuth(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!custodianChangeDeliveryEnabled()) {
    console.info(JSON.stringify({ event: "custodian_projection", outcome: "switch_off" }));
    return Response.json({ delivered: false, reason: "switch_off" }, { status: 200, headers: NO_STORE });
  }
  try {
    const result = await runCustodianProjectionDelivery();
    console.info(JSON.stringify({
      event: "custodian_projection",
      outcome: result.reason,
      stoppedRevision: result.stoppedRevision,
    }));
    const status = result.reason === "retry" || result.reason === "unauthorized" ? 503 : 200;
    return Response.json(result, { status, headers: NO_STORE });
  } catch {
    console.error(JSON.stringify({ event: "custodian_projection", outcome: "error" }));
    return Response.json({ error: "delivery_failed" }, { status: 503, headers: NO_STORE });
  }
}
