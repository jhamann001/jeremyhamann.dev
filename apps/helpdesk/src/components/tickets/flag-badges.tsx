import { AlarmClock, AlertOctagon, ArrowUpRight } from "lucide-react";
import type { TicketFlagDescriptor, TicketFlagFields, TicketFlagTone } from "@/components/tickets/flag-state";
import { ticketFlags } from "@/components/tickets/flag-state";
import { Badge } from "@/components/ui/badge";
import { formatFirmDateTime } from "@/lib/firm-time";
import { cn } from "@/lib/utils";

/**
 * Compliance flag badges — the one renderer for
 * complaint / escalated / follow-up, used by the dashboard table rows, the phone ticket cards and the
 * ticket header, so the three surfaces can never disagree about what a flag looks like or says.
 *
 * Server component: `ticketFlags` is pure and there is nothing to hydrate. It takes the flag columns
 * straight off `TicketListRow`, so no surface needs a second fetch to show them.
 *
 * TIME. The badge is rendered from both sides of the boundary — `ticket-header.tsx` and
 * `requester-history.tsx` are server components, `ticket-card.tsx`, `columns.tsx` and
 * `properties-panel.tsx` are client components — so nothing here may read the ambient clock:
 *
 *   - WHICH follow-up flag appears comes from `followUpState`, whose "start of today" is now the firm
 *     zone's midnight (src/lib/firm-time.ts), the same boundary `followUpWhere` compiles the dashboard's
 *     Overdue filter against. A card badged "Follow-up overdue" is therefore in that filter.
 *   - The instant a flag names is printed with `formatFirmDateTime`, which carries its zone ("Sep 22,
 *     2026 14:30 ET") and agrees with the follow-up picker below it in the properties panel, because
 *     that control now speaks the same clock.
 *   - The visible label is still time-DERIVED, and a client component renders once on the server for
 *     SSR and again in the browser, seconds apart. A ticket that comes due in that gap would print two
 *     different labels, so the label span carries `suppressHydrationWarning` — the same treatment every
 *     other time-derived string in this repo gets (`sla-badge.tsx`, `ticket-card.tsx`, `columns.tsx`).
 *     A server parent that wants the two renders pinned to one instant can pass `now` instead.
 *
 * Colour discipline: amber belongs to `INTERNAL_NOTE_CLASSES` and to the SLA
 * WARNING badge, so a follow-up that is merely *due* uses the neutral outline and only the hard states
 * take colour — destructive for a complaint, violet for an escalation, destructive text for an overdue
 * follow-up. Every badge carries its meaning as text: nothing here is colour-only or tooltip-only.
 */

const TONE_CLASSES: Readonly<Record<TicketFlagTone, string>> = {
  complaint:
    "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200",
  escalated:
    "border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200",
  followUpOverdue: "border-destructive/50 text-destructive",
  followUpDue: "border-border text-foreground",
  followUpScheduled: "border-dashed border-border text-muted-foreground",
};

const TONE_ICONS: Readonly<Record<TicketFlagTone, typeof AlarmClock>> = {
  complaint: AlertOctagon,
  escalated: ArrowUpRight,
  followUpOverdue: AlarmClock,
  followUpDue: AlarmClock,
  followUpScheduled: AlarmClock,
};

/**
 * Full sentence for the accessible name: the flag's own title plus the instant it refers to, on the
 * firm clock and labelled as such, so a reader in Denver is not left to guess whose 14:30 this is.
 */
function describe(flag: TicketFlagDescriptor): string {
  return flag.at ? `${flag.title} ${formatFirmDateTime(flag.at)}` : flag.title;
}

export function FlagBadge({ flag }: { flag: TicketFlagDescriptor }): React.JSX.Element {
  const Icon = TONE_ICONS[flag.tone];
  const description = describe(flag);
  return (
    <Badge
      variant="outline"
      className={cn("gap-1", TONE_CLASSES[flag.tone])}
      data-flag={flag.key}
      title={description}
      aria-label={description}
      suppressHydrationWarning
    >
      <Icon aria-hidden />
      <span suppressHydrationWarning>{flag.label}</span>
    </Badge>
  );
}

/**
 * Renders nothing when the ticket carries no flag — the common case, and an empty wrapper would still
 * take a gap in every row of the table.
 */
export function FlagBadges({
  ticket,
  includeScheduledFollowUp = false,
  now,
  className,
}: {
  ticket: TicketFlagFields;
  /** Ticket header and properties panel pass true; list rows and cards leave it false. */
  includeScheduledFollowUp?: boolean;
  /**
   * The instant the follow-up state is judged against. Defaults to "now" at render. A server parent
   * that renders the same ticket's flags next to a client component can pass its own instant to both
   * so the two never straddle a boundary; the firm-zone day boundary already keeps them agreeing on
   * everything except a follow-up that comes due between the two renders.
   */
  now?: Date;
  className?: string;
}): React.JSX.Element | null {
  const flags = ticketFlags(ticket, { includeScheduledFollowUp, now });
  if (flags.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)} data-slot="ticket-flags">
      {flags.map((flag) => (
        <FlagBadge key={flag.key} flag={flag} />
      ))}
    </span>
  );
}
