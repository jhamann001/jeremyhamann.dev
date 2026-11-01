/**
 * GET /api/tickets/[id]/preview — the slide-over payload (docs/ARCHITECTURE.md §g S3 routes).
 * One successful call = one TICKET_PREVIEWED row, written and awaited inside getTicketDetail before any
 * content is returned. 404 for both "missing" and "not readable" (the denial row is written inside).
 */
import { PrefetchNotAllowedError, UnauthorizedError } from "@/lib/errors";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { requireViewerOrThrow } from "@/lib/session";
import { listComments } from "@/server/comments";
import { getTicketDetail } from "@/server/tickets";
import type { TicketPreviewDTO, Viewer } from "@/types/domain";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const PREVIEW_COMMENT_LIMIT = 5;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let viewer: Viewer;
  try {
    viewer = await requireViewerOrThrow();
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
    }
    throw e;
  }

  const { id } = await ctx.params;
  const rc = getRequestContextFromRequest(req);

  let ticket: TicketPreviewDTO["ticket"] | null;
  try {
    ticket = await getTicketDetail(viewer, id, rc, { view: "PREVIEW" });
  } catch (e) {
    // I11: a prefetch never reads content and never writes a view row — answer with nothing.
    if (e instanceof PrefetchNotAllowedError) return new Response(null, { status: 204, headers: NO_STORE });
    throw e;
  }
  if (!ticket) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const comments = await listComments(viewer, id, rc, { limit: PREVIEW_COMMENT_LIMIT });
  const body: TicketPreviewDTO = { ticket, comments };
  return Response.json(body, { status: 200, headers: NO_STORE });
}
