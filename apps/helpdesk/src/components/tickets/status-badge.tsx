import type { TicketStatus } from "@/types/domain";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS } from "@/lib/format";
import { statusHelpText } from "@/components/tickets/status-help";
import { cn } from "@/lib/utils";

/**
 * Calm, low-saturation tints; each status stays legible in both themes. Neutral palette on purpose:
 * SLA badges carry the alarming colours, status should not compete with them.
 */
const STATUS_CLASSES: Readonly<Record<TicketStatus, string>> = {
  NEW: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200",
  OPEN: "border-transparent bg-primary text-primary-foreground",
  PENDING_CLIENT:
    "border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200",
  PENDING_INTERNAL: "border-border bg-muted text-foreground",
  RESOLVED:
    "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
  CLOSED: "border-dashed border-border bg-transparent text-muted-foreground",
  // Wave B. Struck-through, muted and dashed: a voided ticket is present in the record and absent from
  // the work. It must not read like CLOSED (real work, finished) or like an alarm (nothing went wrong —
  // somebody corrected a mistake).
  VOIDED: "border-dashed border-border bg-transparent text-muted-foreground line-through",
};

/**
 * `describe` (integration round 1; actually wired at the call sites in round 2) adds the crosswalk's
 * one-line explanation of what this status means on THIS desk, and what to watch out for coming from
 * legacy help desk — as a `title` AND on the accessible name, because MOBILE_FIRST R10 is explicit that a
 * `title` is not a visible explanation on a phone, so the accessible name is the only form a screen
 * reader or a touch device actually gets.
 *
 * Off by default, deliberately. On a board of fifty rows the same sentence fifty times is noise, so the
 * list surfaces render the chip bare: `dashboard/columns.tsx`, `dashboard/ticket-card.tsx`,
 * `dashboard/ticket-table.tsx` and `ticket/requester-history.tsx`. It earns its place where a person is
 * reading ONE ticket, and these five pass it: `ticket/ticket-header.tsx`, `ticket/properties-panel.tsx`
 * (the read-only chip a CLOSED ticket shows in place of the Select), `dashboard/ticket-preview-sheet.tsx`,
 * `ticket/links/links-panel.tsx` and `ticket/links/duplicate-candidates.tsx`.
 *
 * Those last two used to wrap this badge in `<span title={statusHelpText(...)}>` as an interim, which is
 * what the build record asked to replace. That wrapper was exactly
 * the tooltip-only form R10 forbids and was unreachable on a touch device; `status-badge.probe.test.ts`
 * asserts the prop is passed and that no surface reintroduces the wrapper.
 *
 * Where a person CHOOSES a status the help is *visible* instead, not on the chip: the bulk bar prints it
 * as a sub-line under each option and the void sheet prints it in the sheet body.
 *
 * The wording comes from `status-help.ts`, which is lifted verbatim from the build record so the
 * training document and the product cannot drift.
 */
export function StatusBadge({
  status,
  describe = false,
}: {
  status: TicketStatus;
  describe?: boolean;
}): React.JSX.Element {
  const help = describe ? statusHelpText(status) : null;
  return (
    <Badge
      variant="outline"
      className={cn(STATUS_CLASSES[status])}
      data-status={status}
      title={help ?? undefined}
      aria-label={help === null ? `Status: ${STATUS_LABELS[status]}` : `Status: ${STATUS_LABELS[status]} — ${help}`}
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}
