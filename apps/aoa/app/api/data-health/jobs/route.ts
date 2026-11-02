import { auth } from "@/auth";
import { canReadJobs, readJobList } from "@/lib/data-jobs/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user) return response({ error: "unauthorized" }, 401);
  const identity = { role: (session.user as { role?: string }).role, email: session.user.email };
  if (!canReadJobs(identity)) return response({ error: "not_found" }, 404);
  const params = new URL(req.url).searchParams;
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const cursor = params.get("cursor") ?? "0";
  if (q.length > 100 || !/^\d{1,4}$/.test(cursor) || Number(cursor) > 200
    || (status && !["UNKNOWN", "HEALTHY", "FAILED", "RUNNING", "OVERDUE", "STALLED", "PAUSED", "SOURCE_ATTENTION"].includes(status))) {
    return response({ error: "invalid_filters" }, 400);
  }
  try { return response(await readJobList(identity, { q, status, offset: Number(cursor) })); }
  catch { return response({ error: "job_monitoring_unavailable" }, 503); }
}
