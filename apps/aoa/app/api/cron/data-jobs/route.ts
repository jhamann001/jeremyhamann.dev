import { requireDataJobsCollectorAuth } from "@/lib/data-jobs/auth";
import { collectDataJobs } from "@/lib/data-jobs/collector";
export const runtime = "nodejs";
export const maxDuration = 300;
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function POST(req: Request): Promise<Response> {
  if (!(await requireDataJobsCollectorAuth(req))) return response({ error: "unauthorized" }, 401);
  try {
    const result = await collectDataJobs();
    // An external watchdog must never count a disabled/empty collection as success.
    return response(result, result.skipped || result.unavailable > 0 ? 503 : result.busy ? 202 : result.collected > 0 ? 200 : 503);
  } catch { return response({ error: "job_collection_failed" }, 503); }
}
export const GET = () => response({ error: "method_not_allowed" }, 405);
