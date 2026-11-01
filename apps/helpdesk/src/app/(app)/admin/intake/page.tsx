import { notFound } from "next/navigation";
import type { QueueKey } from "@/types/domain";
import { QUEUE_KEYS } from "@/types/domain";
import { actorFromViewer, recordDenied } from "@/lib/audit";
import { getRequestContext } from "@/lib/request-context";
import { canWriteQueue } from "@/lib/rbac";
import { requireUser } from "@/lib/session";
import {
  canReviewHeldIntake,
  heldIntakeCounts,
  isHeldIntakeCursor,
  isHeldIntakeReason,
  isHeldIntakeStatus,
  listHeldIntakePage,
} from "@/server/suspended-intake";
import { HeldIntakeView } from "@/components/admin/intake/held-intake-view";

export const dynamic = "force-dynamic";

/**
 * `/admin/intake` — held inbound mail (the build record `INTAKE_RELEASED`).
 *
 * The desk refuses inbound mail by writing a `SuspendedIntake` row: an unknown mailbox, a DMARC
 * failure, a bounce, an auto-reply, spam, a loop, an unreadable or oversized body, or a reply whose
 * sender is not that thread's requester. Every one of those is a client message the desk decided not
 * to file, and before this page nothing read that table — the refusals were correct, audited, and
 * invisible. A wire instruction that fails DMARC is exactly the message that must not sit unseen.
 *
 * The gate follows `/admin/users` verbatim: authenticate, check the capability, write the
 * `AUTHZ_DENIED` row, then 404 rather than 403 so the page's existence does not leak. Middleware
 * refuses unknown `/admin/*` paths to anyone outside ops/compliance already, and the server re-checks
 * anyway — `listHeldIntakePage` makes the same check a third time.
 *
 * Filters live in the URL so a link to "every unauthenticated message on the service mailbox" is
 * shareable and the page stays a server render with no client fetch. `cursor` is in the URL for the
 * same reason and for one more: nothing in this table is ever deleted, so the list outgrows one page
 * permanently, and "Load more" has to be a navigation the server renders — not a client fetch that
 * would give the same rows a second, unaudited read path.
 */
export default async function AdminIntakePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; reason?: string; mailbox?: string; cursor?: string }>;
}): Promise<React.JSX.Element> {
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (!canReviewHeldIntake(viewer.groups)) {
    await recordDenied(actorFromViewer(viewer), ctx, "intake:review path:/admin/intake");
    notFound();
  }

  const params = await searchParams;
  const statusParam = typeof params.status === "string" ? params.status.toUpperCase() : "";
  const status = statusParam === "ALL" ? "ALL" : isHeldIntakeStatus(statusParam) ? statusParam : "NEW";
  const reasonParam = typeof params.reason === "string" ? params.reason.toUpperCase() : "";
  const reason = isHeldIntakeReason(reasonParam) ? reasonParam : undefined;
  const mailbox = typeof params.mailbox === "string" ? params.mailbox.trim().slice(0, 320) : "";
  // A hand-edited cursor is dropped rather than rejected: the reviewer gets the newest page, never an
  // error over the queue.
  const cursor =
    typeof params.cursor === "string" && isHeldIntakeCursor(params.cursor) ? params.cursor : undefined;

  // The counts run under the SAME status and mailbox filter as the list, so the reason chips can
  // never describe rows that are not on screen; the NEW backlog the banner claims comes back on the
  // same object (`waitingTotal`) and is deliberately unfiltered.
  const [page, counts] = await Promise.all([
    listHeldIntakePage(viewer, { status, reason, mailbox: mailbox || undefined, cursor }, ctx),
    heldIntakeCounts(viewer, ctx, { status, mailbox: mailbox || undefined }),
  ]);

  // The queues this reviewer could release INTO. An empty list renders the release control disabled
  // with the reason, rather than a button that always fails.
  const releasableQueues: QueueKey[] = QUEUE_KEYS.filter((q) => canWriteQueue(viewer.groups, q));

  return (
    <HeldIntakeView
      page={page}
      counts={counts}
      status={status}
      reason={reason}
      mailbox={mailbox}
      cursor={cursor}
      releasableQueues={releasableQueues}
    />
  );
}
