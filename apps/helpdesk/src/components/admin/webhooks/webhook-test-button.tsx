"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { recordTestDelivery } from "@/server/webhooks.actions";
import { Button } from "@/components/ui/button";
import { validationToastMessage } from "@/components/admin/webhooks/webhook-form-support";

/**
 * "Record a test delivery".
 *
 * It RECORDS one; it does not send one. The send belongs to the dispatch job, which is the only path
 * that re-runs the SSRF guard, signs, retries and backs off — a test button that took a shortcut would
 * be testing something other than what production does, which is the usual reason a test button lies.
 *
 * So this queues a PENDING delivery carrying the payload SHAPE a receiver will see, with no ticket
 * attached, and the next dispatch run picks it up like any other. Today no run will: `WEBHOOKS_ENABLED`
 * is unset everywhere, so the row sits PENDING and the toast says exactly that rather than implying
 * something left the building.
 */
export function WebhookTestButton({
  endpointId,
  name,
  disabled,
  webhooksEnabled,
  className,
}: {
  endpointId: string;
  name: string;
  disabled?: boolean;
  /** Resolved server-side and passed as a prop — a client component may not read `@/lib/env`. */
  webhooksEnabled: boolean;
  className?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick(): void {
    startTransition(async () => {
      const result = await recordTestDelivery({ endpointId });
      if (result.ok) {
        toast.success(
          webhooksEnabled
            ? `Test delivery queued for “${name}” — the next dispatch run will attempt it.`
            : `Test delivery recorded for “${name}”. Nothing will be sent until WEBHOOKS_ENABLED is set.`,
        );
        router.refresh();
        return;
      }
      switch (result.code) {
        case "FORBIDDEN":
          toast.error("You do not have permission to test webhook endpoints.");
          return;
        case "NOT_FOUND":
          toast.error("That endpoint no longer exists — refreshing.");
          router.refresh();
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        case "VALIDATION":
          // Same reason as the edit sheet: `result.message` is the generic "Invalid input", and the
          // sentence worth reading is in `fieldErrors`. One helper so the two cannot drift.
          toast.error(validationToastMessage(result.fieldErrors, result.message));
          return;
        case "CONFLICT":
          toast.error(result.message);
          return;
        case "INTERNAL":
          toast.error("The test delivery could not be recorded.");
          return;
      }
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={onClick}
      disabled={pending || disabled}
      aria-busy={pending || undefined}
      aria-label={`Record a test delivery for ${name}`}
    >
      <FlaskConical aria-hidden />
      {pending ? "Recording…" : "Test"}
    </Button>
  );
}
