import Link from "next/link";
import { Copy, GitMerge } from "lucide-react";
import type { TicketDetailDTO, Viewer } from "@/types/domain";
import { formatDateTime, formatTicketNumber } from "@/lib/format";
import { canWriteLinks } from "@/lib/rbac";
import { findDuplicateCandidates } from "@/server/duplicates";
import { DuplicateCandidateList } from "@/components/ticket/links/duplicate-candidates";

/**
 * The possible-duplicate banner.
 *
 * An async SERVER component that owns its own load, mounted ABOVE the header: it asks whether this
 * ticket should be worked at all, and a reader who has started on the header has already started
 * working it.
 *
 * **The banner OFFERS, a person DECIDES.** Nothing here merges automatically — a false positive that
 * silently merged two clients' tickets would put one client's correspondence on another's record,
 * which is the one failure this desk cannot walk back. The scorer is in `src/server/duplicates.ts`,
 * pure and tested, so the rule that decides what an operator is shown about two clients is readable
 * without a database.
 *
 * NOT A VIEW: candidates are list rows the viewer can already list. No `TICKET_VIEWED` row, and
 * every link is `prefetch={false}` so hovering one does not become an audited read of another ticket
 *.
 *
 * Two states, in priority order:
 *  1. **Already merged.** The ticket points at a survivor. That is a fact, not a suggestion, and it is
 *     what a reader most needs to know — so it replaces the suggestion entirely.
 *  2. **Candidates found.** Ranked, capped at five, each with one-tap Link and Duplicate.
 * Otherwise the banner renders nothing at all, rather than an empty "no duplicates" shell.
 */
export type DuplicateBannerProps = { ticket: TicketDetailDTO; viewer: Viewer };

export async function DuplicateBanner({ ticket, viewer }: DuplicateBannerProps): Promise<React.JSX.Element> {
  if (ticket.mergedIntoId !== null) {
    const number = ticket.mergedIntoNumber === null ? null : formatTicketNumber(ticket.mergedIntoNumber);
    return (
      <div
        role="status"
        data-slice="B2-duplicate-banner"
        data-state="merged"
        className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 p-3 text-sm"
      >
        <GitMerge aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1">
          <span className="font-medium">Merged as a duplicate{number === null ? "" : ` of ${number}`}.</span>{" "}
          <span className="text-muted-foreground">
            This ticket keeps its own record and its own history; the work continues on the other one
            {ticket.mergedAt === null ? "" : ` (merged ${formatDateTime(ticket.mergedAt)})`}.
          </span>
        </p>
        <Link
          href={`/tickets/${ticket.mergedIntoId}`}
          prefetch={false}
          className="inline-flex min-h-11 shrink-0 items-center rounded-md border px-3 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-8"
        >
          Open {number ?? "the other ticket"}
        </Link>
      </div>
    );
  }

  const candidates = await findDuplicateCandidates(viewer, ticket.id);
  if (candidates.length === 0) return <></>;

  const canWrite = canWriteLinks(viewer.groups, ticket.queueKey) && ticket.status !== "CLOSED" && ticket.status !== "VOIDED";

  return (
    <div
      role="status"
      data-slice="B2-duplicate-banner"
      data-state="candidates"
      data-candidate-count={candidates.length}
      className="rounded-lg border border-amber-300 bg-amber-50/60 p-3 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Copy aria-hidden className="size-4 shrink-0" />
        {candidates.length === 1
          ? "This may be a duplicate of another ticket"
          : `${candidates.length} other tickets may be the same request`}
      </p>
      <p className="mt-0.5 text-xs">
        Nothing has been merged. Open one to compare; marking a duplicate resolves this ticket, links the
        two and asks you why — comments never move.
      </p>
      <DuplicateCandidateList
        ticketId={ticket.id}
        version={ticket.version}
        candidates={candidates}
        canWrite={canWrite}
      />
    </div>
  );
}
