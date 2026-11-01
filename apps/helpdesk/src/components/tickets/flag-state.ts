import type { EscalationTarget } from "@/types/domain";
import { ESCALATION_TARGET_LABELS } from "@/types/domain";
import { firmDateTimeLocalToIso, isoToFirmDateTimeLocal, startOfFirmDay } from "@/lib/firm-time";

/**
 * Pure derivation behind `FlagBadges`.
 *
 * Lives in its own module for the same reason `sla-badge-label.ts` does: the repo's vitest environment
 * is `node` with no DOM and no testing-library, so anything that must be unit-tested cannot live inside
 * a `.tsx` component. `FlagBadges` renders exactly what this returns and adds no logic of its own.
 *
 * The follow-up vocabulary matches the SQL the dashboard filter compiles to (`TicketListQuery.followUp`):
 *   "due"      → followUpAt <= now
 *   "overdue"  → followUpAt <  start of today ON THE FIRM CLOCK (src/lib/firm-time.ts)
 * so "overdue" is the strictly-worse subset of "due" — a ticket whose callback date has fully passed,
 * not one that came due an hour ago.
 *
 * The day boundary is pinned to the firm's zone rather than the ambient one because `FlagBadges` is
 * rendered from BOTH sides of the server/client boundary: `ticket-header.tsx` and `requester-history.tsx`
 * are server components (the container's zone — UTC on Cloud Run) while `ticket-card.tsx`, `columns.tsx`
 * and `properties-panel.tsx` are client components (the viewer's zone). With an ambient midnight, one
 * ticket disagreed with itself between the browser's midnight and UTC's — the header badge reading
 * "Follow-up due" above a properties-panel badge reading "Follow-up overdue" — and `followUpWhere`
 * (src/server/tickets.ts), which compiles the Overdue filter, agreed with neither. Both now call
 * `startOfFirmDay`, so the badge and the filter that claims to list it cannot diverge.
 */

export type FollowUpState = "none" | "scheduled" | "due" | "overdue";

export function followUpState(followUpAt: string | null | undefined, now: Date = new Date()): FollowUpState {
  if (followUpAt === null || followUpAt === undefined || followUpAt.length === 0) return "none";
  const at = Date.parse(followUpAt);
  if (Number.isNaN(at)) return "none";
  if (at < startOfFirmDay(now).getTime()) return "overdue";
  if (at <= now.getTime()) return "due";
  return "scheduled";
}

// ---------------------------------------------------------------------------
// <input type="datetime-local"> ⇄ ISO instant, for the follow-up picker
// ---------------------------------------------------------------------------
//
// The control speaks wall-clock time to the minute ("2026-09-19T14:30") while the column holds an ISO
// instant. Both directions run on the FIRM clock, not the viewer's: the badge above the picker prints
// the same instant with `formatFirmDateTime`, and a picker reading 14:30 beside a badge reading 18:30
// is two times for one field. Re-exported from here rather than moved, so the picker
// (src/components/ticket/properties-panel.tsx) keeps importing the names the contract gave it.

/** ISO instant → "YYYY-MM-DDTHH:mm" on the firm clock. Empty string for null/unparseable. */
export function isoToDateTimeLocal(iso: string | null | undefined): string {
  return isoToFirmDateTimeLocal(iso);
}

/** "YYYY-MM-DDTHH:mm" on the firm clock → ISO instant. `null` for an empty or impossible value. */
export function dateTimeLocalToIso(value: string): string | null {
  return firmDateTimeLocalToIso(value);
}

export type TicketFlagTone = "complaint" | "escalated" | "followUpOverdue" | "followUpDue" | "followUpScheduled";

export type TicketFlagDescriptor = {
  /** Stable React key and `data-flag` value. */
  key: string;
  tone: TicketFlagTone;
  /** Visible badge text. */
  label: string;
  /** Sentence for the accessible name; the caller may append a formatted date from `at`. */
  title: string;
  /** The ISO instant this flag is about, when it has one (filed at / follow-up at). */
  at: string | null;
};

/** The subset of a ticket row the flags are derived from — satisfied by both DTOs. */
export type TicketFlagFields = {
  isComplaint: boolean;
  complaintFiledAt: string | null;
  escalationTarget: EscalationTarget;
  followUpAt: string | null;
};

/**
 * Ordered worst-first: a complaint outranks an escalation, which outranks a follow-up date. List rows and
 * cards pass `includeScheduledFollowUp: false` (a future callback is not news in a list); the ticket header
 * and the properties panel pass true, because there the date itself is the point.
 */
export function ticketFlags(
  t: TicketFlagFields,
  opts?: { now?: Date; includeScheduledFollowUp?: boolean },
): TicketFlagDescriptor[] {
  const now = opts?.now ?? new Date();
  const includeScheduled = opts?.includeScheduledFollowUp ?? false;
  const flags: TicketFlagDescriptor[] = [];

  if (t.isComplaint) {
    flags.push({
      key: "complaint",
      tone: "complaint",
      label: "Complaint",
      title: "Logged as a complaint",
      at: t.complaintFiledAt,
    });
  }

  if (t.escalationTarget !== "NONE") {
    flags.push({
      key: `escalated:${t.escalationTarget}`,
      tone: "escalated",
      label: `Escalated: ${ESCALATION_TARGET_LABELS[t.escalationTarget]}`,
      title: `Escalated to ${ESCALATION_TARGET_LABELS[t.escalationTarget]}`,
      at: null,
    });
  }

  const follow = followUpState(t.followUpAt, now);
  if (follow === "overdue") {
    flags.push({ key: "follow-up:overdue", tone: "followUpOverdue", label: "Follow-up overdue", title: "Follow-up overdue since", at: t.followUpAt });
  } else if (follow === "due") {
    flags.push({ key: "follow-up:due", tone: "followUpDue", label: "Follow-up due", title: "Follow-up due", at: t.followUpAt });
  } else if (follow === "scheduled" && includeScheduled) {
    flags.push({ key: "follow-up:scheduled", tone: "followUpScheduled", label: "Follow-up", title: "Follow-up scheduled for", at: t.followUpAt });
  }

  return flags;
}
