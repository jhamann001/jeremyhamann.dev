import { cache } from "react";
import Link from "next/link";
import { History } from "lucide-react";
import type { TicketDetailDTO, TicketListRow, Viewer } from "@/types/domain";
import { formatRelative, formatTicketNumber } from "@/lib/format";
import { listTicketsByRequester } from "@/server/tickets";
import { Badge } from "@/components/ui/badge";
import { FlagBadges } from "@/components/tickets/flag-badges";
import { SlaBadge } from "@/components/tickets/sla-badge";
import { StatusBadge } from "@/components/tickets/status-badge";
import { RequesterHistorySheet } from "@/components/ticket/requester-history-sheet";

/**
 * "Has this person written before?" — the question an operator asks on almost every ticket and, before
 * Wave A, could only answer by retyping the requester's address into the dashboard search.
 *
 * An ASYNC SERVER COMPONENT that owns its own load: the ticket page is
 * foundation-owned and cannot import S6's `listTicketsByRequester` on this panel's behalf.
 *
 * NO AUDIT ROW, deliberately (docs/ARCHITECTURE.md §e "What counts as a view", restated in contract §3
 * rule 3): these are list rows — number, subject, status, SLA — carrying no record content, exactly like
 * the dashboard's own rows. Opening one of them is the audited view.
 *
 * Household rows are a separate group and labelled as such, because "another ticket from this person"
 * and "another ticket from this household" are different claims and an operator must not confuse them.
 * The pointer is an opaque advisor platform id; nothing here renders it.
 *
 * `variant="inline"` is the md+ properties column; `variant="sheet"` is the phone block above the action
 * dock, where the rows go inside a bottom sheet behind a 44 px trigger.
 */

/** Enough to answer "is this a repeat caller?" without turning the panel into a second dashboard. */
const HISTORY_LIMIT = 10;

/**
 * One heading for both presentations: the md+ `<h2>`, the phone sheet trigger and the phone empty
 * state all name the panel the same way, so nothing the operator reads depends on the width.
 */
const REQUESTER_HISTORY_HEADING = "Other tickets from this requester" as const;

/**
 * The ticket page mounts this component TWICE (inline at md+, sheet on phones) and only CSS decides
 * which one is visible, so both run on the server for every render. `cache` collapses the two identical
 * loads into one query for the request. The arguments are primitives plus the page's single `viewer`
 * reference, which is what makes the second call a cache hit rather than a miss on a fresh object.
 */
const loadRequesterHistory = cache(
  async (
    viewer: Viewer,
    email: string | null,
    requesterExternalId: string | null,
    householdId: string | null,
    excludeTicketId: string,
    limit: number,
  ): Promise<{ requester: TicketListRow[]; household: TicketListRow[] }> =>
    listTicketsByRequester(viewer, { email, requesterExternalId, householdId }, excludeTicketId, limit),
);

export type RequesterHistoryVariant = "inline" | "sheet";

export type RequesterHistoryProps = {
  ticket: TicketDetailDTO;
  viewer: Viewer;
  variant: RequesterHistoryVariant;
};

/**
 * The badges sit OUTSIDE the `<Link>` on purpose: `SlaBadge` and the PII indicator are Radix tooltip
 * triggers, and an interactive trigger nested inside an anchor is both invalid and unusable with a
 * keyboard. The link covers the number and the subject — a 44 px target on its own.
 */
function HistoryRow({ row }: { row: TicketListRow }): React.JSX.Element {
  return (
    <li className="flex flex-col gap-1 rounded-md px-2 py-2 hover:bg-muted/60">
      <Link
        href={`/tickets/${row.id}`}
        prefetch={false}
        className="flex min-h-11 flex-col gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label={`Open ticket ${formatTicketNumber(row.number)}: ${row.subject}`}
      >
        <span className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{formatTicketNumber(row.number)}</span>
          <time
            dateTime={row.updatedAt}
            className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
            suppressHydrationWarning
          >
            {formatRelative(row.updatedAt)}
          </time>
        </span>
        <span className="line-clamp-2 text-sm leading-snug break-words">{row.subject}</span>
      </Link>
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={row.status} />
        <SlaBadge
          timers={{
            firstResponseDueAt: row.firstResponseDueAt,
            resolutionDueAt: row.resolutionDueAt,
            firstRespondedAt: row.firstRespondedAt,
            resolvedAt: row.resolvedAt,
          }}
          initial={row.sla}
          compact
        />
        <FlagBadges ticket={row} />
      </div>
    </li>
  );
}

function Group({
  heading,
  rows,
}: {
  heading: string;
  rows: readonly TicketListRow[];
}): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{heading}</p>
      <ul className="-mx-2 flex flex-col">
        {rows.map((row) => (
          <HistoryRow key={row.id} row={row} />
        ))}
      </ul>
    </div>
  );
}

export async function RequesterHistory({ ticket, viewer, variant }: RequesterHistoryProps): Promise<React.JSX.Element> {
  const { requester, household } = await loadRequesterHistory(
    viewer,
    ticket.requesterEmail,
    ticket.requesterExternalId,
    ticket.householdId,
    ticket.id,
    HISTORY_LIMIT,
  );
  const total = requester.length + household.length;

  const body =
    total === 0 ? (
      <p className="text-xs text-muted-foreground">
        {ticket.requesterEmail === null && ticket.requesterExternalId === null
          ? "This ticket has no email or client record to match on, so there is nothing to compare it with."
          : "No other tickets from this requester. First time they have written in."}
      </p>
    ) : (
      <div className="flex flex-col gap-3">
        <Group heading="From this requester" rows={requester} />
        <Group heading="From this household" rows={household} />
        {total >= HISTORY_LIMIT ? (
          <p className="px-2 text-xs text-muted-foreground">
            Showing the {HISTORY_LIMIT} most recent. Use the requester link in the header for the full list.
          </p>
        ) : null}
      </div>
    );

  if (variant === "sheet") {
    if (total === 0) {
      /**
       * The empty state keeps the framing the trigger it replaces would have given it (R7: same data,
       * same state, both presentations). Returning the bare sentence left a lone line of muted text
       * between the Attachments card and the sticky dock with nothing on screen saying what "this
       * requester" was being compared against — the md+ variant renders the identical sentence under a
       * heading, so the two presentations of one DTO made different claims.
       */
      return (
        <div data-slice="S7-requester-history" data-variant="sheet" data-empty="true">
          <div className="flex flex-col gap-1 rounded-md border border-dashed px-3 py-2.5">
            <p className="flex items-center gap-2 text-sm font-medium">
              <History aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              {REQUESTER_HISTORY_HEADING}
              <Badge variant="secondary" className="ml-auto tabular-nums">
                0
              </Badge>
            </p>
            {body}
          </div>
        </div>
      );
    }
    return (
      <div data-slice="S7-requester-history" data-variant="sheet">
        <RequesterHistorySheet count={total} label={REQUESTER_HISTORY_HEADING}>
          {body}
        </RequesterHistorySheet>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="requester-history-heading"
      data-slice="S7-requester-history"
      data-variant="inline"
      className="rounded-lg border bg-card p-4 text-card-foreground"
    >
      <h2 id="requester-history-heading" className="mb-2 text-sm font-semibold">
        {REQUESTER_HISTORY_HEADING}
      </h2>
      {body}
    </section>
  );
}
