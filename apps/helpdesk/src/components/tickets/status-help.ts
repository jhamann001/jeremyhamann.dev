/**
 * Status helper text — pure, no imports beyond types.
 *
 * CS is coming from the legacy help desk, where three of the six statuses do not mean what they mean here. The
 * crosswalk says so in a training table nobody has open while they are working a ticket, so the same
 * sentences live beside the status chip: one line of what it MEANS, one line of what to WATCH OUT for.
 * The wording is lifted from the build record rather than re-invented, so the training document
 * and the product cannot drift apart.
 *
 * **Home (integration round 1).** This lived under B2's `links/**` at hand-over only because CONTRACT
 * §15 gave B2 no neutral file; the build record asked for it to be
 * moved. It now sits beside `status-badge.tsx`, which is the component that renders it: the badge takes
 * a `describe` prop and quotes `statusHelpText`, so the five surfaces that show one ticket's status pass
 * that prop rather than importing from here.
 *
 * The direct importers are therefore the two places a person CHOOSES a status, where the sentence has to
 * be SEEN and not merely announced (MOBILE_FIRST R10): `dashboard/bulk-actions-bar.tsx` renders
 * `statusHelpText` as a visible sub-line under each status option, and `ticket/void-ticket-sheet.tsx`
 * prints `statusHelpFor("VOIDED")` in the sheet body.
 */
import type { TicketStatus } from "@/types/domain";

export type StatusHelp = {
  /** What the status means on THIS desk. One sentence. */
  means: string;
  /** Where it differs from the legacy help desk, or null when it does not. */
  watchOut: string | null;
};

export const STATUS_HELP: Readonly<Record<TicketStatus, StatusHelp>> = {
  NEW: {
    means: "Created, nobody has worked it yet.",
    watchOut: null,
  },
  OPEN: {
    means: "Being worked.",
    watchOut:
      "Agent-set. A client reply to a new ticket does not move it here by itself; a reply to Pending client or Resolved does.",
  },
  PENDING_CLIENT: {
    means: "Waiting on the client.",
    watchOut:
      "It sends nothing. In legacy help desk, Pending was the send trigger; here the reply is what saves and queues, and the status is a separate choice in the same save.",
  },
  PENDING_INTERNAL: {
    means: "Waiting on us, or on a third party.",
    watchOut: "The clock still runs, and a client reply does not move it — the desk is waiting on itself.",
  },
  RESOLVED: {
    means: "The work is finished; the record is still open.",
    watchOut: "A client reply reopens it to Open and is recorded as a reopen.",
  },
  CLOSED: {
    means: "Terminal. Nothing more is written to this ticket.",
    watchOut:
      "Genuinely terminal. A client reply opens a new linked ticket, and a person closes a ticket deliberately — nothing closes itself.",
  },
  VOIDED: {
    means: "Entered in error. Treated as though the ticket never happened.",
    watchOut:
      "It leaves every counter, every SLA number and every export. It is refused once the ticket carries a reply the client can see, and it cannot be undone.",
  },
};

export function statusHelpFor(status: TicketStatus): StatusHelp {
  return STATUS_HELP[status];
}

/** One string for a `title`, an `aria-description` or a sheet body. */
export function statusHelpText(status: TicketStatus): string {
  const help = STATUS_HELP[status];
  return help.watchOut === null ? help.means : `${help.means} ${help.watchOut}`;
}
