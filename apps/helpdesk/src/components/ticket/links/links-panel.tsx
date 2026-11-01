import Link from "next/link";
import { Link2 } from "lucide-react";
import type { TicketDetailDTO, TicketLinkDTO, Viewer } from "@/types/domain";
import { formatRelative, formatTicketNumber } from "@/lib/format";
import { canWriteLinks } from "@/lib/rbac";
import { listTicketLinks } from "@/server/ticket-links";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/tickets/status-badge";
import { LinkKindIcon } from "@/components/ticket/links/link-kind-icon";
import { linkKindLabel } from "@/components/ticket/links/link-kind-label";
import { AddLinkButton, RemoveLinkButton } from "@/components/ticket/links/links-panel-controls";

/**
 * Linked tickets.
 *
 * An async SERVER component that owns its own load — the ticket page is foundation-owned and cannot
 * import B2's server module on the panel's behalf (guardrail G1's mount-point allowlist).
 *
 * NOT A VIEW: a link is a number, a subject and a status of a ticket the
 * viewer can already list, with no description and no comment body, so the panel writes no
 * `TICKET_VIEWED` row — exactly like `listTicketsByRequester`. Opening the other ticket is the audited
 * read, and that link carries `prefetch={false}` so hovering it is not one.
 *
 * Direction is rendered, never assumed. The SAME stored row reads "Duplicate of HD-9" here and "Has
 * duplicate HD-12" on the other ticket (`TICKET_LINK_INVERSE_LABELS`), which is why a merge writes one
 * row rather than two that could disagree.
 *
 * `links:write` gates the controls, and the server re-checks it on BOTH tickets. A compliance officer
 * therefore reads the panel and is never shown a control they would be refused.
 *
 * Fix round 2: this file may import a COMPONENT from `link-kind-icon.tsx` (a client reference is what a
 * client component is for) but never a plain function from it. `linkKindLabel` now lives in
 * `link-kind-label.ts`, which carries no `"use client"` directive, because calling it here threw at
 * render and replaced this whole page with the error boundary.
 */
export type TicketLinksPanelProps = { ticket: TicketDetailDTO; viewer: Viewer };

/** Groups render in the order an operator asks about them: what blocks me, what is the same, what is near. */
const KIND_ORDER: Readonly<Record<string, number>> = { BLOCKS: 0, DUPLICATE_OF: 1, RELATED: 2 };

function sortLinks(links: readonly TicketLinkDTO[]): TicketLinkDTO[] {
  return [...links].sort(
    (a, b) =>
      (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.otherTicketNumber - a.otherTicketNumber,
  );
}

function LinkRow({ link, canWrite }: { link: TicketLinkDTO; canWrite: boolean }): React.JSX.Element {
  const number = formatTicketNumber(link.otherTicketNumber);
  return (
    <li className="flex items-start gap-2 p-2 sm:p-3" data-link-id={link.id} data-link-kind={link.kind}>
      <LinkKindIcon kind={link.kind} inbound={link.inbound} className="mt-2.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{linkKindLabel(link.kind, link.inbound)}</span>
          {/* `describe` puts the crosswalk sentence on the badge's accessible name, not only on a
              `title` — the interim `<span title=…>` wrapper this replaces was the tooltip-only form
              MOBILE_FIRST R10 forbids, and a phone could never reach it. */}
          <StatusBadge status={link.otherTicketStatus} describe />
        </p>
        <Link
          href={`/tickets/${link.otherTicketId}`}
          prefetch={false}
          className="mt-0.5 flex min-h-11 flex-col justify-center rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-8"
          aria-label={`Open ticket ${number}: ${link.otherTicketSubject}`}
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{number}</span>
            <span className="min-w-0 truncate text-sm font-medium">{link.otherTicketSubject}</span>
          </span>
        </Link>
        {link.note !== null && link.note.length > 0 ? (
          <p className="mt-0.5 text-xs break-words text-muted-foreground">{link.note}</p>
        ) : null}
        <p className="mt-0.5 text-xs text-muted-foreground">
          Linked by {link.createdBy.name?.trim() || link.createdBy.email}{" "}
          <time dateTime={link.createdAt} suppressHydrationWarning>
            {formatRelative(link.createdAt)}
          </time>
        </p>
      </div>
      {canWrite ? <RemoveLinkButton linkId={link.id} otherTicketNumber={link.otherTicketNumber} /> : null}
    </li>
  );
}

export async function TicketLinksPanel({ ticket, viewer }: TicketLinksPanelProps): Promise<React.JSX.Element> {
  const links = sortLinks(await listTicketLinks(viewer, ticket.id));
  // The same rule `addTicketLink` enforces, so the visible control and the server check cannot disagree:
  // WRITE on this queue, and the ticket is not terminal.
  const canWrite = canWriteLinks(viewer.groups, ticket.queueKey) && ticket.status !== "CLOSED" && ticket.status !== "VOIDED";

  return (
    <section
      aria-labelledby="links-heading"
      data-slice="B2-links"
      data-link-count={links.length}
      className="rounded-lg border bg-card p-4 text-card-foreground"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link2 aria-hidden className="size-4 text-muted-foreground" />
        <h2 id="links-heading" className="text-sm font-semibold">
          Linked tickets
        </h2>
        <Badge variant="secondary" className="tabular-nums">
          {links.length}
          <span className="sr-only"> linked</span>
        </Badge>
        {canWrite ? <AddLinkButton ticketId={ticket.id} /> : null}
      </div>

      {links.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {canWrite
            ? "Nothing linked yet. Link a ticket this one relates to, or one it is waiting on — comments never move between them."
            : "Nothing linked yet."}
        </p>
      ) : (
        <ul className="mt-3 divide-y rounded-md border">
          {links.map((link) => (
            <LinkRow key={link.id} link={link} canWrite={canWrite} />
          ))}
        </ul>
      )}
    </section>
  );
}
