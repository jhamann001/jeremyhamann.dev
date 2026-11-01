import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { getRequestContext } from "@/lib/request-context";
import { listTicketActivity } from "@/server/audit-log";
import { listComments } from "@/server/comments";
import { listMacros } from "@/server/macros";
import { getTicketDetail, listAssignableUsers, requesterEmailChangedAt } from "@/server/tickets";
import { Skeleton } from "@/components/ui/skeleton";
import { AttachmentsPanel } from "@/components/ticket/attachments/attachments-panel";
import { Composer } from "@/components/ticket/composer";
// --- Wave B mount points. Each is a compiling stub with the exact props
// its slice must keep; replace the FILE, never the props. ---
import { TicketFollowers } from "@/components/inbox/ticket-followers";
import { DuplicateBanner } from "@/components/ticket/duplicate-banner";
import { IdentityVerificationPanel } from "@/components/ticket/identity-verification";
import { TicketLinksPanel } from "@/components/ticket/links/links-panel";
import { PresenceChip } from "@/components/ticket/presence-chip";
import { ReviewStamp } from "@/components/ticket/review-stamp";
import { SlaDetailPopover } from "@/components/ticket/sla-detail-popover";
import { SwipeNav } from "@/components/ticket/swipe-nav";
import { VoidTicketSheet } from "@/components/ticket/void-ticket-sheet";
import { MarkdownRenderer } from "@/components/ticket/markdown-renderer";
import { PropertiesPanel } from "@/components/ticket/properties-panel";
import { RequesterHistory } from "@/components/ticket/requester-history";
import { TicketActionDock } from "@/components/ticket/ticket-action-dock";
import { TicketHeader } from "@/components/ticket/ticket-header";
import { Timeline } from "@/components/ticket/timeline";

export const dynamic = "force-dynamic";

/**
 * Ticket detail.
 *
 * Order matters: the prefetch guard runs before any content read (a prefetch renders a skeleton and
 * writes no audit row); `getTicketDetail(DETAIL)` re-checks RBAC and `await`s the TICKET_VIEWED row
 * before returning content (a failed insert throws into error.tsx and nothing is served); only then are
 * comments, activity, macros and assignees loaded. No AutoRefresh here — every render is an audited view.
 *
 * Layout: one column on phones (header → description → timeline) with the `TicketActionDock` owning the
 * bottom edge — Details and the Composer open as bottom sheets from it. From `md` the inline Composer
 * and PropertiesPanel return (panel below at 768–1023, two columns from `lg`) and the dock is hidden.
 * Both presentations render the same DTOs; nothing is fetched twice.
 *
 * Wave A MOUNT POINTS. Two async server components are
 * mounted here as stubs and replaced in place by their slices; this file stays foundation-owned so
 * the two slices never race each other over it:
 *   `AttachmentsPanel`  — below the timeline, in the main column, on every width.
 *   `RequesterHistory`  — `variant="inline"` in the md+ properties column; `variant="sheet"`
 *                              in the phone-only block above the dock.
 * Each owns its own data load rather than being fed by this page, because neither slice's server
 * module exists yet and this page must compile for everyone from the first commit. Neither writes a
 * view audit row: attachment metadata and list rows are not ticket content. The DOWNLOAD of an
 * attachment is audited, inside S4's route.
 *
 * Wave B MOUNT POINTS, on the same terms: this file stays
 * foundation-owned so four slices never race each other over it, and each panel that needs data owns
 * its own load behind its own `<Suspense>` boundary.
 *   `DuplicateBanner`           — above the header, full width.
 *   `PresenceChip` and `SlaDetailPopover` — in the phone-only strip under the header.
 *   `TicketLinksPanel`          — below the attachments panel, main column.
 *   `IdentityVerificationPanel` — below the links panel, main column.
 *   `TicketFollowers`           — md+ properties column, under the requester history, AND
 *                                    `variant="sheet"` in the phone-only block above the dock. Two
 *                                    mounts, because §9's single md+ placement left the follow
 *                                    control at 0x0 on every phone width and the dashboard bulk bar
 *                                    was the only way to follow a ticket from a phone
 *                                   . The
 *                                    component caches its load, so the second mount is not a second
 *                                    pair of queries.
 *   `ReviewStamp`               — per comment, through `Timeline`'s `commentSlot` seam.
 *   `VoidTicketSheet` and `SwipeNav` — beside the action dock.
 * None of them writes a view audit row: links, followers, presence and verification records carry no
 * description and no comment body, exactly like the Wave A panels (§e "What counts as a view").
 *
 * STREAMING: because those two own their loads, they are exactly what `<Suspense>` is for. Without a
 * boundary they are a THIRD sequential database wave in front of the first byte — `getTicketDetail`
 * (which awaits the TICKET_VIEWED insert), then the four parallel loads, then attachments and
 * requester history — and the operator stares at the previous screen for the whole of it. Wrapped,
 * the header, description and timeline flush as soon as they are ready and each panel fills in
 * behind its own skeleton. The audited read still happens BEFORE anything is served: it is awaited
 * above, outside every boundary, so I3 is untouched and a failed audit insert still reaches
 * error.tsx with nothing rendered. `loading.tsx` in this segment covers the part before that.
 */
/**
 * The fallback for a streamed panel: a block the size of the panel it replaces, so the column does
 * not jump when the real one arrives, plus one polite status line for a screen reader. It carries no
 * ticket data — it renders before its panel's load and has none.
 */
function PanelSkeleton({ label, className }: { label: string; className: string }): React.JSX.Element {
  return (
    <div aria-busy="true">
      <span role="status" className="sr-only">
        {label}
      </span>
      <Skeleton className={`w-full ${className}`} />
    </div>
  );
}

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }): Promise<React.JSX.Element> {
  const { id } = await params;
  const viewer = await requireUser();
  const ctx = await getRequestContext();

  if (ctx.isPrefetch) {
    // I11: no content, no audit row.
    return <Skeleton className="h-64" />;
  }

  const ticket = await getTicketDetail(viewer, id, ctx, { view: "DETAIL" });
  if (!ticket) notFound();

  const [comments, activity, macros, assignees, requesterEmailChanged] = await Promise.all([
    listComments(viewer, id, ctx),
    listTicketActivity(viewer, id, ctx),
    listMacros(viewer, ticket.queueKey, ctx),
    listAssignableUsers(ticket.queueKey),
    // Ledger-only fact: `Ticket` keeps one address, so an overwrite leaves nothing on the row. Loaded
    // here rather than inside the header because a header is a client-reachable component and may not
    // import a server module (guardrail G1). Not a view — a timestamp, no record content.
    requesterEmailChangedAt(id),
  ]);

  /**
   * One instant, read once, handed to every surface that has to agree about it: the header's banner and
   * both mounts of `EditTicketSheet`. A cleared address is still a privileged one, so the edit control
   * must offer the confirmed second step rather than a plain field
   *.
   */
  const requesterEmailChangedIso = requesterEmailChanged?.toISOString() ?? null;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 md:gap-5">
      {/* Wave B: the duplicate banner sits ABOVE the header, because it is a question about whether
          this ticket should be worked at all, and a reader who has already started reading the header
          has already started working it. */}
      <Suspense fallback={null}>
        <DuplicateBanner ticket={ticket} viewer={viewer} />
      </Suspense>

      <TicketHeader ticket={ticket} requesterEmailChangedAt={requesterEmailChangedIso} />

      {/* Wave B: the phone-only facts strip. `SlaBadge`'s detail lives in a `title` tooltip, and a
          phone has no hover (MOBILE_FIRST R10), so the popover is the visible form. */}
      <div className="flex flex-wrap items-center gap-2 md:hidden">
        <SlaDetailPopover sla={ticket.sla} ticketNumber={ticket.number} />
        <PresenceChip ticketId={ticket.id} />
      </div>

      <div className="grid gap-4 md:gap-5 lg:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-4 md:gap-5">
          <section aria-labelledby="description-heading" className="rounded-lg border bg-card p-4 text-card-foreground">
            <h2 id="description-heading" className="mb-2 text-sm font-semibold">
              Description
            </h2>
            <MarkdownRenderer source={ticket.description} />
          </section>

          <Timeline
            comments={comments}
            activity={activity}
            // Wave B (integration round 1): whether the Withdraw control is offered at all.
            // `permissions.canWrite` is `queue:write && !closed`, which is NARROWER than what
            // `retractComment` permits on the server — it allows a retraction on a closed ticket,
            // because withdrawing a message the desk already sent is a correction of correspondence
            // and closing the ticket does not make it un-sent. Offering the narrower thing is the
            // deliberate choice: the control appears where the desk is still working the ticket, and
            // the wider server rule stays available to a caller that needs it.
            canRetract={ticket.permissions.canWrite}
            // the supervisory review CONTROL, injected per comment so B3's `CommentItem` never
            // imports a B6 module. The stamps themselves ride on `comment.reviews`.
            commentSlot={(comment) => <ReviewStamp comment={comment} viewer={viewer} />}
          />

          <Suspense fallback={<PanelSkeleton label="Loading attachments…" className="h-40" />}>
            <AttachmentsPanel ticket={ticket} viewer={viewer} />
          </Suspense>

          <Suspense fallback={<PanelSkeleton label="Loading linked tickets…" className="h-24" />}>
            <TicketLinksPanel ticket={ticket} viewer={viewer} />
          </Suspense>

          <Suspense fallback={<PanelSkeleton label="Loading identity verification…" className="h-24" />}>
            <IdentityVerificationPanel ticket={ticket} viewer={viewer} />
          </Suspense>

          <div className="hidden md:block">
            <Composer ticket={ticket} macros={macros} viewer={viewer} />
          </div>
        </div>

        <div className="hidden flex-col gap-4 md:flex md:gap-5 lg:sticky lg:top-4 lg:self-start">
          <PropertiesPanel
            ticket={ticket}
            assignees={assignees}
            viewerId={viewer.id}
            requesterEmailChangedAt={requesterEmailChangedIso}
          />
          <Suspense fallback={<PanelSkeleton label="Loading requester history…" className="h-32" />}>
            <RequesterHistory ticket={ticket} viewer={viewer} variant="inline" />
          </Suspense>
          <Suspense fallback={<PanelSkeleton label="Loading followers…" className="h-20" />}>
            <TicketFollowers ticket={ticket} viewer={viewer} />
          </Suspense>
        </div>
      </div>

      <div className="flex flex-col gap-2 md:hidden">
        <Suspense fallback={<PanelSkeleton label="Loading requester history…" className="h-11" />}>
          <RequesterHistory ticket={ticket} viewer={viewer} variant="sheet" />
        </Suspense>
        <Suspense fallback={<PanelSkeleton label="Loading followers…" className="h-11" />}>
          <TicketFollowers ticket={ticket} viewer={viewer} variant="sheet" />
        </Suspense>
      </div>

      <TicketActionDock ticket={ticket} macros={macros} viewer={viewer} assignees={assignees} />

      {/* Wave B: both render null until their slice lands. `SwipeNav` takes its hrefs from the list the
          operator arrived from, so a swipe follows the order they were looking at; both produce
          ordinary, audited navigations (I3), never a prefetch (I11). */}
      <VoidTicketSheet ticket={ticket} viewer={viewer} />
      <SwipeNav prevHref={null} nextHref={null} />
    </div>
  );
}
