import { auth } from "@/auth";
import { canReadJobs, parseHistoryCursor, readJobHistory } from "@/lib/data-jobs/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
export async function GET(req: Request, context: { params: Promise<{ jobId: string }> }): Promise<Response> {
  const session = await auth();
  if (!session?.user) return response({ error: "unauthorized" }, 401);
  const identity = { role: (session.user as { role?: string }).role, email: session.user.email };
  if (!canReadJobs(identity)) return response({ error: "not_found" }, 404);
  const { jobId } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(jobId)) return response({ error: "not_found" }, 404);
  let cursor;
  try { cursor = parseHistoryCursor(new URL(req.url).searchParams.get("cursor")); }
  catch { return response({ error: "invalid_cursor" }, 400); }
  try { return response(await readJobHistory(identity, jobId, cursor)); }
  catch (error) { return response({ error: "job_history_unavailable" }, error instanceof Error && error.message === "jobs_forbidden" ? 404 : 503); }
}
