/**
 * GET /api/queues/summary — queue counters for the dashboard poll (docs/ARCHITECTURE.md §g S3 routes).
 * Counters carry no record content and are not views (§e "what counts as a view").
 */
import { requireViewerOrThrow } from "@/lib/session";
import { UnauthorizedError } from "@/lib/errors";
import { getQueueSummaries } from "@/server/queues";
import type { QueueSummaryResponse, Viewer } from "@/types/domain";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// The contract fixes the handler signature as GET(req: Request); this route needs nothing from it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function GET(req: Request): Promise<Response> {
  let viewer: Viewer;
  try {
    viewer = await requireViewerOrThrow();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
    }
    throw e;
  }

  const now = new Date();
  const queues = await getQueueSummaries(viewer, now);
  const body: QueueSummaryResponse = { queues, generatedAt: now.toISOString() };
  return Response.json(body, { status: 200, headers: NO_STORE });
}
