/**
 * Wording and small pure helpers for `/admin/suppression` — pure, no JSX
 * (the `webhook-form-support.ts` / `sla-form-support.ts` shape).
 *
 * Kept out of the components for the same reason the delivery chip's labels are: the words an operator
 * reads before stopping a client's mail are worth a unit test, and a test of them should not need a DOM.
 */
import type { SuppressionDTO, SuppressionReason } from "@/types/domain";

/** Which shadcn Badge variant a reason wears. Narrow, so a card cannot invent one. */
export type SuppressionBadgeVariant = "secondary" | "outline" | "destructive";

/**
 * A reason's visual weight.
 *
 * `HARD_BOUNCE` and `COMPLAINT` are destructive because they are the two the desk did not choose: the
 * address is gone, or somebody reported us. The other three are decisions a person made and read as
 * ordinary configuration.
 */
export const SUPPRESSION_REASON_VARIANTS: Readonly<Record<SuppressionReason, SuppressionBadgeVariant>> = {
  HARD_BOUNCE: "destructive",
  COMPLAINT: "destructive",
  MANUAL: "secondary",
  UNSUBSCRIBE_REQUEST: "secondary",
  LOOP: "outline",
};

/** One line per reason, telling an operator what it means for the client. */
export const SUPPRESSION_REASON_HELP: Readonly<Record<SuppressionReason, string>> = {
  HARD_BOUNCE:
    "The receiving server said this address does not exist. Replies to it are recorded but never handed to a sender.",
  COMPLAINT: "This address reported our mail as spam. Continuing to write to it damages every other client's delivery.",
  MANUAL: "Somebody at the desk decided to stop writing to this address.",
  UNSUBSCRIBE_REQUEST: "The client asked us to stop emailing them. Reach them another way.",
  LOOP: "Mail to this address came straight back to us. Sending again would loop.",
};

/** What a suppression currently is. `live` stops mail; `lifted` is history. */
export type SuppressionState = "live" | "lifted";

export function suppressionState(row: SuppressionDTO): SuppressionState {
  return row.removedAt === null ? "live" : "lifted";
}

export const SUPPRESSION_STATE_LABELS: Readonly<Record<SuppressionState, string>> = {
  live: "Mail stopped",
  lifted: "Writing again",
};

/**
 * An address shortened for a phone, keeping both ends.
 *
 * The local part identifies the person and the domain identifies the firm; truncating from the right
 * would leave a column of indistinguishable domains, and truncating from the left would hide who it is.
 */
export function shortAddress(email: string, max = 34): string {
  if (email.length <= max) return email;
  const at = email.lastIndexOf("@");
  if (at <= 0) return `${email.slice(0, max - 1)}…`;
  const domain = email.slice(at);
  const room = Math.max(1, max - domain.length - 1);
  const local = email.slice(0, at);
  return local.length <= room ? email : `${local.slice(0, room)}…${domain}`;
}

/** `3 hard bounces` / `1 hard bounce`. */
export function bounceCountLabel(count: number): string {
  return `${count} hard bounce${count === 1 ? "" : "s"}`;
}

/**
 * The default note offered when an operator adds an address by hand.
 *
 * Empty, on purpose. A pre-filled note is a note nobody reads and nobody replaces, and this field is
 * the only place the reason for a manual suppression will ever be written down.
 */
export const MANUAL_NOTE_PLACEHOLDER = "Client asked us to stop emailing this address on 20 September";

/** The floor on the reason for lifting a suppression. Mirrors `WAVE_B_LIMITS.reasonMinChars`. */
export const LIFT_REASON_MIN = 12;
export const LIFT_REASON_MAX = 2_000;
