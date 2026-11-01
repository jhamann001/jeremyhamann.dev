"use client";

import Link from "next/link";
import { ticketHref } from "@/components/dashboard/ticket-link";
import type { TicketListContext } from "@/components/dashboard/ticket-link";
import { ArrowRight } from "lucide-react";
import type { AssigneeOption, TicketListRow, Viewer } from "@/types/domain";
import { CATEGORY_LABELS } from "@/types/domain";
import { canWriteQueue } from "@/lib/rbac";
import { formatDateTime, formatRelative, formatTicketNumber } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { MobileCard } from "@/components/shell/mobile-card";
import { AssigneeSelect } from "@/components/tickets/assignee-select";
import { FlagBadges } from "@/components/tickets/flag-badges";
import { ticketFlags } from "@/components/tickets/flag-state";
import { PiiIndicator } from "@/components/tickets/pii-indicator";
import { PriorityBadge } from "@/components/tickets/priority-badge";
import { QueueBadge } from "@/components/tickets/queue-badge";
import { SlaBadge } from "@/components/tickets/sla-badge";
import { StatusBadge } from "@/components/tickets/status-badge";
import { UserAvatar } from "@/components/tickets/user-avatar";

/**
 * Phone presentation of one `TicketListRow` (docs/MOBILE_FIRST.md §4.3 item 4). Rendered by `TicketTable`
 * from the SAME `table.getRowModel()` rows as the desktop table — never from a second fetch.
 *
 * Body tap = preview (the `MobileCard` `role="button"` region); the explicit **Open** link = detail; the inline
 * `AssigneeSelect` and the Open link live in the card's `actions` strip, OUTSIDE the tappable region, so a
 * Select tap never opens the preview and the region stays valid for screen readers. No inline text links on the
 * card: zero mis-taps between preview and detail.
 *
 * The SLA badge sits top-right as the glance target (loudest element); `tone="alarm"` on a BREACHED non-closed
 * ticket uses the destructive ring — the amber left edge stays reserved for `INTERNAL_NOTE_CLASSES`.
 */
export function TicketCard({
  row,
  viewer,
  assignees,
  showQueue,
  onPreview,
  listContext,
}: {
  row: TicketListRow;
  viewer: Viewer;
  assignees: AssigneeOption[];
  showQueue: boolean;
  onPreview: (id: string) => void;
  /**
   * The neighbours of this card in the list it was rendered from, and where that list lives
   * (integration round 1). Passed through to the href as `?prev=&next=&back=`, which is what
   * `SwipeNav` reads on the ticket page — CONTRACT §9 fixes its props at null, so the URL is the
   * contract's own "list context in the link". Optional: a card rendered outside a list links plainly.
   */
  listContext?: TicketListContext | null;
}): React.JSX.Element {
  const number = formatTicketNumber(row.number);
  const closed = row.status === "CLOSED";
  const tone = row.sla.status === "BREACHED" && !closed ? "alarm" : closed ? "muted" : "default";
  // §b.9: inline assignment only when the viewer writes this queue and the ticket is not CLOSED. `row.version`
  // is the OCC token (amendment #46); the control's own router.refresh() re-renders the list on success.
  const editable = canWriteQueue(viewer.groups, row.queueKey) && !closed;
  const hasFlags = ticketFlags(row).length > 0;

  return (
    <MobileCard
      as="li"
      label={`Ticket ${number}: ${row.subject}`}
      onActivate={() => onPreview(row.id)}
      tone={tone}
      data-ticket-id={row.id}
      data-status={row.status}
      data-sla-status={row.sla.status}
      actions={
        <>
          <div className="min-w-0 flex-1">
            {editable ? (
              <AssigneeSelect
                ticketId={row.id}
                version={row.version}
                value={row.assignee}
                options={assignees}
                disabled={!editable}
              />
            ) : (
              <UserAvatar user={row.assignee} size="sm" />
            )}
          </div>
          <Button asChild variant="outline" size="sm" className="min-w-11 shrink-0">
            <Link href={ticketHref(row.id, listContext)} prefetch={false} aria-label={`Open ticket ${number}`}>
              Open
              <ArrowRight aria-hidden />
            </Link>
          </Button>
        </>
      }
    >
      {/* Row 1 — number · SLA (the glance target, right-aligned) */}
      <div className="flex items-start justify-between gap-2">
        <span className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">{number}</span>
        <SlaBadge
          timers={{
            firstResponseDueAt: row.firstResponseDueAt,
            resolutionDueAt: row.resolutionDueAt,
            firstRespondedAt: row.firstRespondedAt,
            resolvedAt: row.resolvedAt,
          }}
          initial={row.sla}
        />
      </div>

      {/* Row 2 — subject + compliance flags + PII */}
      <div className="flex flex-col gap-1">
        <p className="line-clamp-2 text-[15px] leading-snug font-medium break-words">{row.subject}</p>
        {row.piiRedactionCount > 0 || hasFlags ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Wave A flags (complaint / escalated / follow-up) come off the same list row — no second fetch. */}
            <FlagBadges ticket={row} />
            <PiiIndicator count={row.piiRedactionCount} scope="ticket" />
          </div>
        ) : null}
      </div>

      {/* Row 3 — priority / status / queue … updated */}
      <div className="flex flex-wrap items-center gap-1.5">
        <PriorityBadge priority={row.priority} />
        <StatusBadge status={row.status} />
        {showQueue ? <QueueBadge queueKey={row.queueKey} /> : null}
        <time
          dateTime={row.updatedAt}
          title={formatDateTime(row.updatedAt)}
          className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
          suppressHydrationWarning
        >
          {formatRelative(row.updatedAt)}
        </time>
      </div>

      {/* Row 4 — requester · category */}
      <span className="truncate text-xs text-muted-foreground">
        {row.requesterName} · {CATEGORY_LABELS[row.category]}
      </span>
    </MobileCard>
  );
}
