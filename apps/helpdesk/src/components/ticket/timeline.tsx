import { Fragment } from "react";
import type { ActivityItem, CommentDTO } from "@/types/domain";
import { ActivityRow } from "@/components/ticket/activity-row";
import { CommentItem } from "@/components/ticket/comment-item";

/**
 * Chronological merge of comments (both channels — this is a staff surface) and audited system events
 *. Server component; the page passes the two lists it loaded.
 */

type Entry =
  | { kind: "comment"; at: number; key: string; comment: CommentDTO }
  | { kind: "activity"; at: number; key: string; item: ActivityItem };

function timeOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Comments first on an exact tie so a note reads before the system rows its write emitted (macro, PII). */
function merge(comments: CommentDTO[], activity: ActivityItem[]): Entry[] {
  const entries: Entry[] = [
    ...comments.map((comment): Entry => ({ kind: "comment", at: timeOf(comment.createdAt), key: `c-${comment.id}`, comment })),
    ...activity.map((item): Entry => ({ kind: "activity", at: timeOf(item.occurredAt), key: `a-${item.id}`, item })),
  ];
  // Array.prototype.sort is stable, so equal timestamps keep the comment-before-activity order above.
  return entries.sort((a, b) => a.at - b.at);
}

/**
 * Wave B seam. `commentSlot` renders UNDER each comment, and it exists so a control owned by one slice
 * can appear on a comment rendered by another without either importing the other: the ticket page fills
 * it with B6's `<ReviewStamp>`, and `CommentItem` stays free of compliance code.
 *
 * The review stamps and the retraction THEMSELVES need no slot — both ride on `CommentDTO`
 * (`comment.reviews`, `comment.retraction`), so `CommentItem` renders them from data it already has.
 * What needs a seam is the ACTION, which is capability-gated and slice-owned.
 *
 * CONTRACT: the slot lands as a SIBLING of `CommentItem` inside the timeline's `<ol>`, so whatever it
 * returns must be an `<li>` (or null). `CommentItem` renders its own `<li>`, and nesting one inside
 * another is invalid HTML that screen readers announce as a list of one.
 */
export type TimelineProps = {
  /**
   * Whether the viewer may withdraw one of the desk's own outbound replies (integration round 1,
   * B3's note §1.2). It is the PAGE's answer, not the composer's: `CommentItem` is a client component
   * and may not import `@/lib/session` or `@/lib/rbac`, and `Timeline` hands it nothing but a
   * `CommentDTO`. Passing it explicitly replaces a store bridge — a fact travelling through two
   * client components that both happen to be mounted — with an ordinary prop.
   *
   * It decides only what is SHOWN. `retractComment` re-checks the capability server-side on every
   * call, and refuses regardless of what any surface rendered.
   */
  canRetract?: boolean;
  comments: CommentDTO[];
  activity: ActivityItem[];
  commentSlot?: (comment: CommentDTO) => React.ReactNode;
};

export function Timeline({ comments, activity, commentSlot, canRetract }: TimelineProps): React.JSX.Element {
  const entries = merge(comments, activity);

  return (
    <section aria-labelledby="timeline-heading" className="flex flex-col gap-2">
      <h2 id="timeline-heading" className="text-sm font-semibold">
        Activity
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {comments.length} {comments.length === 1 ? "comment" : "comments"} · {activity.length}{" "}
          {activity.length === 1 ? "event" : "events"}
        </span>
      </h2>
      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          No activity yet.
        </p>
      ) : (
        <ol className="flex flex-col gap-2" data-slot="timeline">
          {entries.map((entry) =>
            entry.kind === "comment" ? (
              <Fragment key={entry.key}>
                <CommentItem comment={entry.comment} canRetract={canRetract} />
                {commentSlot?.(entry.comment)}
              </Fragment>
            ) : (
              <ActivityRow key={entry.key} item={entry.item} />
            ),
          )}
        </ol>
      )}
    </section>
  );
}
