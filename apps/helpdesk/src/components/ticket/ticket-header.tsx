import Link from "next/link";
import { Link2, MailWarning } from "lucide-react";
import { BRAND_LABELS, CATEGORY_LABELS, SOURCE_LABELS, type TicketDetailDTO } from "@/types/domain";
import { formatDateTime, formatTicketNumber } from "@/lib/format";
import { FlagBadges } from "@/components/tickets/flag-badges";
import { PiiIndicator } from "@/components/tickets/pii-indicator";
import { PriorityBadge } from "@/components/tickets/priority-badge";
import { QueueBadge } from "@/components/tickets/queue-badge";
import { SlaBadge } from "@/components/tickets/sla-badge";
import { StatusBadge } from "@/components/tickets/status-badge";
import { UserAvatar } from "@/components/tickets/user-avatar";
import { EditTicketSheet } from "@/components/ticket/edit-ticket-sheet";

/**
 * Ticket page header: number, subject, the four
 * badges, the Wave A compliance flags, the PII indicator (fed the real count), requester, created by / at.
 * Server component apart from the edit sheet, which owns its own open state.
 *
 * Phone: the badge row sits ABOVE the subject and leads with the SLA badge — the loudest element, the
 * first thing an operator under a wire cutoff needs. From `md` the row returns to the right of the title.
 *
 * 
 *  - the requester is a LINK to the dashboard filtered by their email, which is the question an operator
 *    asks constantly ("has this person written before?") and previously required retyping the address
 *    into the search box. A phone-only ticket has no address to filter on, so it renders
 *    as plain text with the number — never a link that would filter on nothing, and never a bare "null".
 *  - a ticket opened from a requester's reply to a CLOSED one links back to its origin.
 *  - the pencil opens `EditTicketSheet`; it is the phone's edit affordance, since the properties panel's
 *    own Edit button is md+ only (a sheet inside the Details sheet would stack two overlays). When the
 *    ticket is read-only the control stays reachable and the sheet states the reason — a `disabled`
 *    button whose only explanation is a `title` explains nothing on a phone.
 *  - both cross-links here are bare `<Link>`s, which the global 44 px rule does not reach (it keys on
 *    shadcn's `data-slot`), so each carries `min-h-11` on phones. The requester link was the one control
 *    on this page the G2 probe reported under 44 px.
 */
export function TicketHeader({
  ticket,
  requesterEmailChangedAt = null,
}: {
  ticket: TicketDetailDTO;
  /**
   * ISO-8601 instant of the last requester-address REDIRECT, or null if the address has never been
   * re-pointed. Supplied by the page from `requesterEmailChangedAt` (`@/server/tickets`) — the ledger is
   * the only place the previous address survives, and a client-reachable component may not read it.
   * Optional so a caller that has not loaded it renders the header unchanged.
   */
  requesterEmailChangedAt?: string | null;
}): React.JSX.Element {
  /**
   * "Has this person written before?" — filtered by the OPAQUE person pointer whenever the ticket
   * carries one, and only by the address when it does not.
   *
   * A named client's address in a query string is recorded verbatim in Cloud Run's
   * `httpRequest.requestUrl` and kept in browser history and session restore — a store with its own
   * retention and access control, and none of the redaction, capability gating or hash-chained
   * accountability the rest of the design applies to that exact datum (I14; it is also the client
   * API's authorization subject, and `assertPiiLight` refuses to let a bare `@` into a Slack line for
   * the same reason). `requesterExternalId` answers the same question and means nothing outside the
   * database. See the build record
   */
  const requesterHref =
    ticket.requesterExternalId !== null && ticket.requesterExternalId.length > 0
      ? `/dashboard?${new URLSearchParams({ requesterExternalId: ticket.requesterExternalId }).toString()}`
      : ticket.requesterEmail !== null && ticket.requesterEmail.length > 0
        ? `/dashboard?${new URLSearchParams({ requesterEmail: ticket.requesterEmail.toLowerCase() }).toString()}`
        : null;

  return (
    <header className="flex flex-col gap-3" data-ticket-id={ticket.id}>
      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-start md:justify-between md:gap-3">
        <div className="order-first flex flex-wrap items-center gap-1.5 md:order-last md:justify-end" data-slot="ticket-badges">
          <SlaBadge
            timers={{
              firstResponseDueAt: ticket.firstResponseDueAt,
              resolutionDueAt: ticket.resolutionDueAt,
              firstRespondedAt: ticket.firstRespondedAt,
              resolvedAt: ticket.resolvedAt,
            }}
            initial={ticket.sla}
          />
          <PriorityBadge priority={ticket.priority} />
          <StatusBadge status={ticket.status} describe />
          <QueueBadge queueKey={ticket.queueKey} />
          <FlagBadges ticket={ticket} includeScheduledFollowUp />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono font-medium text-foreground">{formatTicketNumber(ticket.number)}</span>
            <span aria-hidden>·</span>
            <span>{CATEGORY_LABELS[ticket.category]}</span>
            <PiiIndicator count={ticket.piiRedactionCount} scope="ticket" />
          </div>
          <div className="mt-1 flex items-start gap-2">
            <h1 className="min-w-0 flex-1 text-lg font-semibold leading-tight tracking-tight break-words md:text-xl">
              {ticket.subject}
            </h1>
            <EditTicketSheet
              ticket={ticket}
              trigger="icon"
              className="shrink-0"
              requesterEmailChangedAt={requesterEmailChangedAt}
            />
          </div>
          {ticket.linkedFromTicketId !== null ? (
            <p className="mt-1 text-xs text-muted-foreground">
              <Link
                href={`/tickets/${ticket.linkedFromTicketId}`}
                prefetch={false}
                className="inline-flex min-h-11 items-center gap-1 rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-0"
              >
                <Link2 aria-hidden className="size-3.5" />
                Opened from an earlier, closed ticket
              </Link>
            </p>
          ) : null}
        </div>
      </div>

      {/*
        A redirected reply address is not a field edit: every future public reply is delivered to the new
        mailbox, and the client API authorizes on this column, so the new address can read every PUBLIC
        comment already on the thread. Standing notice rather than a timeline entry — someone opening
        this ticket in a month to answer it needs to see it without scrolling the activity feed.
      */}
      {requesterEmailChangedAt !== null ? (
        <div
          data-requester-email-changed={requesterEmailChangedAt}
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
        >
          <MailWarning aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            <span className="font-semibold">Reply address changed.</span> Correspondence on this ticket now goes to{" "}
            <span className="font-medium break-words">{ticket.requesterEmail ?? "no address on file"}</span>. Changed{" "}
            {formatDateTime(requesterEmailChangedAt)}. The audit log records who changed it and why.
          </p>
        </div>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Requester</dt>
          {/* Decision #62: a voicemail ticket has a phone and no address. Show whichever contact exists. */}
          <dd className="mt-0.5 break-words md:truncate">
            {requesterHref !== null ? (
              /*
               * R3: a bare `<Link>` carries no `data-slot`, so the global 44 px rule does not reach it and
               * this anchor measured 93×18 at 390 px — the only sub-44 control on the page. `inline-flex`
               * plus `min-h-11` gives it the height a thumb needs; md+ returns it to the line height of the
               * definition list, where a pointer does not need the padding.
               */
              <Link
                href={requesterHref}
                prefetch={false}
                title={`All tickets from ${ticket.requesterName}`}
                className="inline-flex min-h-11 items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-0"
              >
                {ticket.requesterName}
              </Link>
            ) : (
              <span className="font-medium">{ticket.requesterName}</span>
            )}
            {ticket.requesterEmail !== null || ticket.requesterPhone !== null ? (
              <span className="text-muted-foreground"> · {ticket.requesterEmail ?? ticket.requesterPhone}</span>
            ) : null}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Created by</dt>
          <dd className="mt-0.5">
            <UserAvatar user={ticket.createdBy} size="sm" />
            <span className="mt-0.5 block text-xs text-muted-foreground">
              via {SOURCE_LABELS[ticket.source]} · {BRAND_LABELS[ticket.brand]}
            </span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Created</dt>
          <dd className="mt-0.5 tabular-nums">
            <time dateTime={ticket.createdAt}>{formatDateTime(ticket.createdAt)}</time>
            {ticket.updatedAt !== ticket.createdAt ? (
              <span className="text-muted-foreground"> · updated {formatDateTime(ticket.updatedAt)}</span>
            ) : null}
          </dd>
        </div>
      </dl>
    </header>
  );
}
