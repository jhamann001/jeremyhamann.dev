import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { canStampReview, readableQueues } from "@/lib/rbac";
import {
  countRepliesForReview,
  listRepliesForReview,
  parseReviewQuery,
  REVIEW_DEFAULT_WINDOW_DAYS,
  REVIEW_MAX_ROWS,
  reviewWindow,
} from "@/server/reviews";
import { ReviewsView } from "@/app/(app)/compliance/reviews/reviews-view";

export const dynamic = "force-dynamic";

/**
 * Reply reviews — slice B6.
 *
 * The GATE below is the foundation's and is kept VERBATIM, exactly as Wave A's admin pages keep
 * theirs: authenticate, check the capability, write the `AUTHZ_DENIED` row, then `notFound()` rather
 * than a 403 so the page's existence does not leak to someone who may not use it. Middleware refuses
 * this path too (`isPathAllowed`), but middleware is a coarse UX gate and the server is authoritative
 * — and the server module behind the body re-checks a third time.
 *
 * This page sits under /compliance but is NOT an audit surface — `isPathAllowed` matches it BEFORE the
 * audit-only branch, and its audience is wider (ops_team supervises too).
 *
 * NO AUDIT ROW FOR THE RENDER, deliberately. The list carries ticket metadata and a bounded,
 * PII-sanitised EXCERPT of each reply, which puts it on the same side of §e's view line as
 * `listHeldIntake`'s snippet. Reading a reply IN FULL is a separate act with its own
 * row: `openReplyForReview` writes `TICKET_PREVIEWED` before it returns the body. The CSV export has
 * its own pre-stream `REPORT_EXPORTED` row. So the ledger answers "did the reviewer read what they
 * signed off" without charging a view row to every glance at the queue.
 */
export default async function ComplianceReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canStampReview(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "review:stamp path:/compliance/reviews");
    notFound();
  }

  const query = parseReviewQuery(await searchParams);
  const now = new Date();
  const [rows, total] = await Promise.all([
    listRepliesForReview(viewer, query, now),
    countRepliesForReview(viewer, query, now),
  ]);
  const window = reviewWindow(query, now);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex min-w-0 items-center gap-2">
        <ShieldCheck aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Reply reviews</h1>
          <p className="text-xs text-muted-foreground">
            Public replies awaiting a supervisory review. Oldest first — the reply that has waited
            longest is the one this control exists for.
          </p>
        </div>
      </header>

      <ReviewsView
        rows={rows}
        total={total}
        query={query}
        queues={readableQueues(viewer.groups)}
        viewerId={viewer.id}
        capped={rows.length >= REVIEW_MAX_ROWS}
        maxRows={REVIEW_MAX_ROWS}
        defaultWindowDays={REVIEW_DEFAULT_WINDOW_DAYS}
        windowStart={window.gte.toISOString()}
      />

      <footer className="border-t pt-3 text-xs text-muted-foreground">
        A review cannot be edited or withdrawn; a second opinion is a second stamp. Opening a reply in
        full, and exporting this list, are both recorded.
      </footer>
    </div>
  );
}
