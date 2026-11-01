import { AlertTriangle, CheckCheck, Clock, Send } from "lucide-react";
import type { CommentDeliveryDTO } from "@/types/domain";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  deliveryChipAriaLabel,
  deliveryChipStyle,
  deliveryDetail,
  deliveryFailureNote,
  type DeliveryChipIconKey,
} from "@/components/tickets/delivery-chip-label";

/**
 * The outbound state of one PUBLIC comment: Queued / Sending / Sent / Failed.
 *
 * Lives in `components/tickets` (the shared leaf layer both S5's preview sheet and S6's timeline
 * import, exactly like `internal-note-styles.ts`) rather than inside `comment-item.tsx`, so the
 * dashboard preview can tell the same story as the ticket page without S5 importing S6 (§g layering).
 *
 * It is the ONE thing in the app that prints "Sent", and it prints it only when a sender has reported a
 * result (binding). Rendering it is not a read of client material — the
 * body is the comment the viewer already has — so it writes no audit row (§3 rule 3).
 */

const ICONS: Readonly<Record<DeliveryChipIconKey, React.ComponentType<{ className?: string }>>> = {
  sent: CheckCheck,
  failed: AlertTriangle,
  sending: Send,
  queued: Clock,
};

export function DeliveryChip({ delivery }: { delivery: CommentDeliveryDTO }): React.JSX.Element {
  const style = deliveryChipStyle(delivery.status);
  const Icon = ICONS[style.icon];
  return (
    <Badge
      variant={style.variant}
      className={cn("gap-1 font-normal", style.className)}
      title={deliveryDetail(delivery)}
      aria-label={deliveryChipAriaLabel(delivery)}
      data-delivery-status={delivery.status}
    >
      <Icon aria-hidden />
      {style.label}
    </Badge>
  );
}

/**
 * The failure line under a FAILED comment. Renders nothing unless the delivery actually carries a
 * reason, so a caller can drop it in unconditionally.
 */
export function DeliveryFailureNote({
  delivery,
  className,
}: {
  delivery: CommentDeliveryDTO | null;
  className?: string;
}): React.JSX.Element | null {
  const note = delivery ? deliveryFailureNote(delivery) : null;
  if (!note) return null;
  return (
    <p className={cn("text-xs text-destructive", className)} data-slot="delivery-error">
      {note}
    </p>
  );
}
