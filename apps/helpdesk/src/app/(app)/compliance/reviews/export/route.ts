/**
 * GET /compliance/reviews/export — CSV of the supervisory review queue.
 *
 * The Wave A export pattern, verbatim in its ORDER, which is the control: authenticate (401) →
 * authorize `review:stamp` (denial recorded, 403) → parse the filters → count → write the export
 * audit row → ONLY THEN stream. The row is awaited before the first byte, so a download can never
 * exist without its ledger entry. Cells go through `csvCell`, the same RFC 4180 +
 * formula-injection guard the audit and ticket exports use.
 *
 * TWO DELIBERATE DEPARTURES, both recorded in the build record:
 *
 *  1. **It lives under `/compliance/reviews/` rather than `/api/…`.** CONTRACT §8 lists no route for
 *     this export and §15 gives B6 `src/app/(app)/compliance/reviews/**` and no `src/app/api/**`
 *     path. Putting it inside the owned subtree keeps the file ownership honest and puts it behind the
 *     middleware rule that already gates the page (`isPathAllowed` matches `/compliance/reviews/`
 *     BEFORE the audit-only `/compliance` branch), so the coarse gate and the server gate agree.
 *     `src/app/(app)/tickets/wm/[number]/route.ts` is the Wave A precedent for a route handler inside
 *     `(app)`.
 *  2. **The audit row is `REPORT_EXPORTED`.** `AuditAction` is foundation-owned and has no
 *     `REVIEW_QUEUE_EXPORTED`; `REPORT_EXPORTED` is the catalog's row for "a bounded, filtered set of
 *     rows left the system as a file", its shape (null / null / the row count, `metadata.filters`)
 *     fits exactly, and `entityId` carries the report key `compliance-reply-reviews` so it can never
 *     be confused with one of B7's. The dedicated action is requested in the notes.
 *
 * THE FILE CARRIES NO REPLY BODIES. It is the evidence INDEX — which replies went out, when, on which
 * ticket, supervised by whom, with what verdict — not a copy of client correspondence. A CSV of client
 * correspondence is a copy nobody can audit once it is on a laptop, and the question this file answers
 * does not need one. `REVIEW_CSV_COLUMNS` in `src/server/reviews.ts` is the whole of it.
 */
import { actorFromViewer, recordDenied, writeAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { UnauthorizedError } from "@/lib/errors";
import { csvExportFilename } from "@/lib/export-filename";
import { canStampReview } from "@/lib/rbac";
import { getRequestContextFromRequest } from "@/lib/request-context";
import { requireViewerOrThrow } from "@/lib/session";
import {
  countRepliesForReview,
  listRepliesForReview,
  parseReviewQuery,
  reviewExportFilters,
  reviewRowsToCsv,
} from "@/server/reviews";
import type { Viewer } from "@/types/domain";

export const dynamic = "force-dynamic";

/**
 * The `entityId` on the export's audit row. Namespaced so it can never collide with a B7 report key.
 * NOT exported: a Next route file may export only its handlers and the segment config, and an extra
 * export is a build-time error waiting for whoever runs `next build` first.
 */
const REVIEW_EXPORT_KEY = "compliance-reply-reviews" as const;

const NO_STORE = { "Cache-Control": "no-store" } as const;

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

  const ctx = getRequestContextFromRequest(req);
  const actor = actorFromViewer(viewer);

  if (!canStampReview(viewer.groups)) {
    // I5: every denial is evidence. If the denial row cannot be written the request fails (500)
    // rather than answering with an unrecorded 403.
    await recordDenied(actor, ctx, "review:stamp export");
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const now = new Date();
  const query = parseReviewQuery(new URL(req.url).searchParams);

  // Count and rows are read against the SAME `now`, so the number on the ledger row is the number of
  // replies the window covers — not a count taken a second earlier against a slightly wider window.
  const total = await countRepliesForReview(viewer, query, now);
  const rows = await listRepliesForReview(viewer, query, now);

  // I14: recorded BEFORE any CSV byte is produced.
  await writeAudit(prisma, actor, ctx, {
    action: "REPORT_EXPORTED",
    entityType: "REPORT",
    entityId: REVIEW_EXPORT_KEY,
    newValue: String(total),
    metadata: { report: REVIEW_EXPORT_KEY, filters: reviewExportFilters(query, now), returned: rows.length },
  });

  // Rows are already capped at `REVIEW_MAX_ROWS` by the reader, so the whole file is one string: this
  // is a bounded evidence index, not the ticket export's unbounded keyset walk.
  const body = reviewRowsToCsv(rows, true);
  const filename = csvExportFilename("reply-reviews", query.state.toLowerCase(), now);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      ...NO_STORE,
    },
  });
}
