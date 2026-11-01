"use client";

import Link from "next/link";
import { listContextFor, ticketHref } from "@/components/dashboard/ticket-link";
import type { TicketListContext } from "@/components/dashboard/ticket-link";
import { useQuery } from "@tanstack/react-query";
import { Cog, ExternalLink, Inbox, Lock, Send } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AssigneeOption, CommentDTO, QueueKey, TicketListRow, TicketPreviewDTO } from "@/types/domain";
import { CATEGORY_LABELS } from "@/types/domain";
import { formatDateTime, formatRelative, formatTicketNumber } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
  ResponsiveSheetHeader,
} from "@/components/shell/responsive-sheet";
import { AssigneeSelect } from "@/components/tickets/assignee-select";
import { DeliveryChip, DeliveryFailureNote } from "@/components/tickets/delivery-chip";
import {
  INTERNAL_BADGE_CLASSES,
  INTERNAL_NOTE_CLASSES,
  commentChannel,
  commentChannelLabel,
  type CommentChannel,
} from "@/components/tickets/internal-note-styles";
import { PiiIndicator } from "@/components/tickets/pii-indicator";
import { PriorityBadge } from "@/components/tickets/priority-badge";
import { QueueBadge } from "@/components/tickets/queue-badge";
import { SlaBadge } from "@/components/tickets/sla-badge";
import { StatusBadge } from "@/components/tickets/status-badge";
import { UserAvatar } from "@/components/tickets/user-avatar";
import { cn } from "@/lib/utils";

type PreviewResult = { kind: "ok"; data: TicketPreviewDTO } | { kind: "not-found" };

async function fetchPreview(ticketId: string): Promise<PreviewResult> {
  const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/preview`, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });
  // 404 covers both "missing" and "not readable" (no existence leak); 204 is the prefetch answer.
  if (res.status === 404 || res.status === 204) return { kind: "not-found" };
  if (!res.ok) throw new Error(`preview request failed (${res.status})`);
  return { kind: "ok", data: (await res.json()) as TicketPreviewDTO };
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</dt>
      <dd className="min-w-0 text-sm break-words md:truncate">{children}</dd>
    </div>
  );
}

/**
 * Same four channels the timeline prints, from the same helper: a requester's inbound reply is a PUBLIC
 * row, so branching on `visibility` alone badged a client's own message as an outbound firm message
 * (`CommentItem` carries the full reasoning). The preview must tell the same story as the timeline.
 */
const CHANNEL_ICON: Readonly<Record<CommentChannel, LucideIcon>> = {
  INTERNAL: Lock,
  OUTBOUND: Send,
  INBOUND: Inbox,
  SYSTEM: Cog,
};

function CommentCard({ comment }: { comment: CommentDTO }): React.JSX.Element {
  const internal = comment.visibility === "INTERNAL";
  const channel = commentChannel(comment.visibility, comment.authorKind);
  const ChannelIcon = CHANNEL_ICON[channel];
  return (
    <li
      className={cn("rounded-md border p-2.5 text-sm", internal ? INTERNAL_NOTE_CLASSES : "bg-card")}
      data-visibility={comment.visibility}
      data-author-kind={comment.authorKind}
      data-comment-channel={channel}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs">
        <Badge
          variant={channel === "OUTBOUND" ? "secondary" : "outline"}
          className={cn("gap-1", internal && cn("border-transparent", INTERNAL_BADGE_CLASSES))}
        >
          <ChannelIcon aria-hidden />
          {commentChannelLabel(channel)}
        </Badge>
        {/*
          The preview must tell the same story as the timeline: the badge above names the audience,
          this chip names the delivery state. Without it the card claimed a reply had reached the
          client while the outbound copy was still Queued or had Failed (CONTRACT §10 S3).
        */}
        {!internal && comment.delivery ? <DeliveryChip delivery={comment.delivery} /> : null}
        {/* Wave A: `author` is null for REQUESTER and SYSTEM rows; `authorLabel` names them instead. */}
        <span className="truncate font-medium">
          {comment.author ? comment.author.name?.trim() || comment.author.email : comment.authorLabel}
        </span>
        <time dateTime={comment.createdAt} title={formatDateTime(comment.createdAt)} className="text-muted-foreground" suppressHydrationWarning>
          {formatRelative(comment.createdAt)}
        </time>
        {comment.macroTitle ? <span className="text-muted-foreground">· macro: {comment.macroTitle}</span> : null}
        <PiiIndicator count={comment.piiRedactionCount} scope="comment" />
      </div>
      {/* Plain text on purpose: S5 never imports S6's MarkdownRenderer (§g layering). */}
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed">{comment.body}</p>
      <DeliveryFailureNote delivery={internal ? null : comment.delivery} className="mt-1.5" />
    </li>
  );
}

function PreviewSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading preview">
      {/* The sheet carries no `title` prop: every PreviewBody state owns its own SheetTitle (a11y). */}
      <SheetTitle className="sr-only">Loading preview</SheetTitle>
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-6 w-4/5" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-28" />
      </div>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

/**
 * The body is mounted only while the sheet is open, so the observer unmounts on close and `gcTime: 0`
 * drops the cache entry immediately: every open fetches once → exactly one TICKET_PREVIEWED row.
 * React Query dedupes Strict-Mode double invocation.
 */
function PreviewBody({
  ticketId,
  assigneesByQueue,
  liveRow,
  listContext,
}: {
  ticketId: string;
  assigneesByQueue: Partial<Record<QueueKey, AssigneeOption[]>>;
  liveRow: TicketListRow | undefined;
  /** The neighbours of this ticket in the list behind the sheet, for the "Open ticket" link. */
  listContext: TicketListContext | null;
}): React.JSX.Element {
  const query = useQuery<PreviewResult>({
    queryKey: ["ticket-preview", ticketId],
    queryFn: () => fetchPreview(ticketId),
    staleTime: 0,
    gcTime: 0,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    retry: false,
  });

  if (query.isPending) return <PreviewSkeleton />;

  if (query.isError) {
    return (
      <div className="p-4 text-sm">
        <SheetHeader className="p-0">
          <SheetTitle>Preview unavailable</SheetTitle>
          <SheetDescription>
            The preview could not be loaded because the view could not be recorded. Nothing was changed.
          </SheetDescription>
        </SheetHeader>
      </div>
    );
  }

  if (query.data.kind === "not-found") {
    return (
      <div className="p-4 text-sm">
        <SheetHeader className="p-0">
          <SheetTitle>Not available</SheetTitle>
          <SheetDescription>This ticket does not exist or is not in a queue you can read.</SheetDescription>
        </SheetHeader>
      </div>
    );
  }

  const { ticket, comments } = query.data.data;
  // The list re-renders after every mutation (router.refresh) while this fetch is deliberately made
  // once; display fields — and the OCC token `version` (amendment #46) — come from the fresher list
  // row when it is present, content from the fetch. Without the live version a second assignment from an
  // open sheet would always CONFLICT against the token of the first fetch.
  const status = liveRow?.status ?? ticket.status;
  const priority = liveRow?.priority ?? ticket.priority;
  const assignee = liveRow ? liveRow.assignee : ticket.assignee;
  const version = liveRow?.version ?? ticket.version;
  const timers = liveRow ?? ticket;
  const canAssign = ticket.permissions.canWrite && status !== "CLOSED";
  const options = assigneesByQueue[ticket.queueKey] ?? [];
  const number = formatTicketNumber(ticket.number);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResponsiveSheetHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-mono font-medium text-muted-foreground">{number}</span>
          <QueueBadge queueKey={ticket.queueKey} />
          <StatusBadge status={status} describe />
          <PriorityBadge priority={priority} />
          <PiiIndicator count={liveRow?.piiRedactionCount ?? ticket.piiRedactionCount} scope="ticket" />
        </div>
        <SheetTitle className="leading-snug">{ticket.subject}</SheetTitle>
        <SheetDescription className="sr-only">Preview of ticket {number}</SheetDescription>
        <div className="flex flex-wrap items-center gap-2">
          <SlaBadge
            timers={{
              firstResponseDueAt: timers.firstResponseDueAt,
              resolutionDueAt: timers.resolutionDueAt,
              firstRespondedAt: timers.firstRespondedAt,
              resolvedAt: timers.resolvedAt,
            }}
            initial={liveRow?.sla ?? ticket.sla}
          />
          <span className="text-xs text-muted-foreground">
            {ticket.slaFirstResponseMinutes}m first response · {ticket.slaResolutionMinutes}m resolution
          </span>
        </div>
      </ResponsiveSheetHeader>

      <ResponsiveSheetBody>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 rounded-md border bg-muted/30 p-3">
          <Field label="Requester">
            <span title={ticket.requesterEmail ?? ticket.requesterPhone ?? undefined}>{ticket.requesterName}</span>
          </Field>
          <Field label="Category">{CATEGORY_LABELS[ticket.category]}</Field>
          <Field label="Created">
            <time dateTime={ticket.createdAt} suppressHydrationWarning>
              {formatDateTime(ticket.createdAt)}
            </time>
          </Field>
          <Field label="Created by">{ticket.createdBy.name?.trim() || ticket.createdBy.email}</Field>
          {ticket.clientReference ? <Field label="Client reference">{ticket.clientReference}</Field> : null}
          <div className="col-span-2 flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground uppercase tracking-wide">Assignee</span>
            {canAssign ? (
              <AssigneeSelect
                ticketId={ticket.id}
                version={version}
                value={assignee}
                options={options}
                disabled={!canAssign}
              />
            ) : (
              <UserAvatar user={assignee} size="sm" />
            )}
          </div>
        </dl>

        <section aria-label="Description" className="mt-4">
          <h3 className="mb-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Description</h3>
          {/* Plain text on purpose: S5 never imports S6's MarkdownRenderer (§g layering). */}
          <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md border p-3 text-[13px] leading-relaxed">
            {ticket.description}
          </p>
        </section>

        <Separator className="my-4" />

        <section aria-label="Recent comments">
          <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
            Latest comments{comments.length > 0 ? ` (${comments.length})` : ""}
          </h3>
          {comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No comments yet.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {comments.map((c) => (
                <CommentCard key={c.id} comment={c} />
              ))}
            </ol>
          )}
        </section>
      </ResponsiveSheetBody>

      <ResponsiveSheetFooter className="flex-col items-stretch gap-2 md:flex-row md:items-center md:justify-between">
        <span className="text-center text-[11px] text-muted-foreground md:text-left">This preview was recorded as a view.</span>
        <Button asChild size="sm" className="w-full md:w-auto">
          <Link href={ticketHref(ticket.id, listContext)} prefetch={false}>
            Open ticket
            <ExternalLink aria-hidden />
          </Link>
        </Button>
      </ResponsiveSheetFooter>
    </div>
  );
}

/**
 * Ticket preview: a bottom sheet (90 svh) on phones, the 560 px right-hand slide-over from `md`
 * (`ResponsiveSheet size="lg" height="full"`, docs/MOBILE_FIRST.md §4.3 item 5). Opening it fetches
 * GET /api/tickets/[id]/preview exactly once (staleTime 0, gcTime 0, no refetch, body unmounted on close),
 * which writes one TICKET_PREVIEWED row server-side.
 *
 * `assigneesByQueue` and `rows` are S5-internal optional props (the contract signature stays valid):
 * assignees feed the `AssigneeSelect`; `rows` lets status/priority/assignee — and the OCC `version`
 * (amendment #46) — reflect the latest RSC render without a refetch.
 */
export function TicketPreviewSheet({
  ticketId,
  open,
  onOpenChange,
  assigneesByQueue = {},
  rows = [],
  backHref = null,
}: {
  ticketId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  assigneesByQueue?: Partial<Record<QueueKey, AssigneeOption[]>>;
  rows?: readonly TicketListRow[];
  /**
   * Where the list behind this sheet lives (integration round 1). The sheet's "open the full ticket"
   * link carries `?prev=&next=&back=` from `rows`, so the gesture on the ticket page walks the SAME
   * list the reader was looking at rather than falling back to a session snapshot.
   */
  backHref?: string | null;
}): React.JSX.Element {
  const liveRow = ticketId ? rows.find((r) => r.id === ticketId) : undefined;
  // No `title` prop on purpose: PreviewBody owns the SheetTitle in every state (skeleton, error, not-found, loaded).
  return (
    <ResponsiveSheet open={open && ticketId !== null} onOpenChange={onOpenChange} size="lg" height="full" className="w-full">
      {open && ticketId ? (
        <PreviewBody
          key={ticketId}
          ticketId={ticketId}
          assigneesByQueue={assigneesByQueue}
          liveRow={liveRow}
          listContext={listContextFor(
            rows.map((r) => r.id),
            ticketId,
            backHref,
          )}
        />
      ) : null}
    </ResponsiveSheet>
  );
}
