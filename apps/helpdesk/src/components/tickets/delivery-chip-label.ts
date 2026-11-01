/**
 * The words and visual family of the delivery chip — the ONLY place in the app that prints "Sent"
 * (the build record S3 composer copy rule, binding: nothing says "sent" until a delivery
 * result exists).
 *
 * Pure on purpose, in the `sla-badge-label.ts` / `sla-badge.tsx` shape: the chip component is JSX and
 * the wording is not, so the wording is unit-testable without a DOM. The channel badge beside it
 * (`PUBLIC_REPLY_LABEL`) names the AUDIENCE of a comment; these labels name its DELIVERY STATE. The two
 * must never be able to contradict each other, which is why the audience badge no longer says "Sent".
 */
import type { CommentDeliveryDTO, MessageDeliveryStatus } from "@/types/domain";
import { MESSAGE_DELIVERY_STATUS_LABELS } from "@/types/domain";
import { formatDateTime } from "@/lib/format";

/** Which shadcn Badge variant a status wears. Kept narrow so the chip cannot invent a new one. */
export type DeliveryChipVariant = "secondary" | "outline" | "destructive";

/** Which icon the chip draws. The component maps this to a lucide component; the mapping is not JSX. */
export type DeliveryChipIconKey = "sent" | "failed" | "sending" | "queued";

export type DeliveryChipStyle = {
  label: string;
  icon: DeliveryChipIconKey;
  variant: DeliveryChipVariant;
  className?: string;
};

/** Visual family per delivery status. Labels come from the shared map — the UI never prints a raw enum. */
export function deliveryChipStyle(status: MessageDeliveryStatus): DeliveryChipStyle {
  const label = MESSAGE_DELIVERY_STATUS_LABELS[status];
  switch (status) {
    case "SENT":
      return { label, icon: "sent", variant: "secondary" };
    case "FAILED":
      return { label, icon: "failed", variant: "destructive" };
    case "LEASED":
      return { label, icon: "sending", variant: "outline" };
    case "QUEUED":
      return { label, icon: "queued", variant: "outline", className: "text-muted-foreground" };
    // --- Wave B. BOUNCED is the only new alarm: a provider accepted the message and then could not
    // deliver it, which is a client who did not hear back. CANCELLED and FAILED_SUPPRESSED are quiet —
    // in both cases the desk decided not to send, deliberately, and said so elsewhere. ---
    case "BOUNCED":
      return { label, icon: "failed", variant: "destructive" };
    case "CANCELLED":
      return { label, icon: "queued", variant: "outline", className: "text-muted-foreground line-through" };
    case "FAILED_SUPPRESSED":
      return { label, icon: "queued", variant: "outline", className: "text-muted-foreground" };
  }
}

/** What the chip's `title` says when a pointer rests on it — and what a screen reader reads. */
export function deliveryDetail(delivery: CommentDeliveryDTO): string {
  const parts = [`To ${delivery.toAddress}`];
  if (delivery.status === "SENT" && delivery.sentAt) parts.push(`Sent ${formatDateTime(delivery.sentAt)}`);
  if (delivery.status === "FAILED") {
    parts.push(`${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"}`);
    if (delivery.lastError) parts.push(delivery.lastError);
  }
  if (delivery.status === "QUEUED") parts.push("Waiting for the sender to pick it up");
  if (delivery.status === "LEASED") parts.push("A sender is delivering it now");
  return parts.join(" · ");
}

/** The chip's accessible name: status first (the fact), then the detail line. */
export function deliveryChipAriaLabel(delivery: CommentDeliveryDTO): string {
  return `Delivery: ${MESSAGE_DELIVERY_STATUS_LABELS[delivery.status]}. ${deliveryDetail(delivery)}`;
}

/**
 * The one-line failure note a surface prints under a FAILED comment. Null whenever there is nothing
 * concrete to say, so a caller renders the element only when this returns a string.
 */
export function deliveryFailureNote(delivery: CommentDeliveryDTO): string | null {
  if (delivery.status !== "FAILED" || !delivery.lastError) return null;
  const attempts = `${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"}`;
  return `Delivery failed after ${attempts}: ${delivery.lastError}`;
}
