"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";
import { toast } from "sonner";
import { revokeWebhookEndpoint } from "@/server/webhooks.actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Retire an endpoint, behind an explicit confirm with a recorded reason
 * (MOBILE_FIRST §4.6).
 *
 * Revoking is the only removal there is: the delivery history points at this row, and a history whose
 * endpoint vanished cannot explain itself. The database enforces it too — `webhook_endpoint_no_delete`
 * is a trigger, not a convention — so the dialog says "revoke", never "delete", because the difference
 * matters to the person clicking it.
 *
 * The reason floor is twelve characters, the same as every other recorded reason in this wave. "Why
 * did this stop receiving events" is the question somebody asks six months later, and "no" is not an
 * answer.
 */
const REASON_MIN = 12;
const REASON_MAX = 2000;

export function WebhookRevokeDialog({
  endpointId,
  name,
  className,
}: {
  endpointId: string;
  name: string;
  className?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const uid = useId();
  const reasonId = `${uid}-reason`;
  const errorId = `${uid}-reason-error`;

  const tooShort = reason.trim().length < REASON_MIN;

  function onConfirm(): void {
    if (tooShort) {
      setError(`Please give a reason of at least ${REASON_MIN} characters. It is recorded in the audit log.`);
      return;
    }
    startTransition(async () => {
      const result = await revokeWebhookEndpoint({ endpointId, reason: reason.trim() });
      if (result.ok) {
        toast.success(`“${name}” revoked`);
        setOpen(false);
        setReason("");
        setError(null);
        router.refresh();
        return;
      }
      switch (result.code) {
        case "FORBIDDEN":
          toast.error("You do not have permission to revoke webhook endpoints.");
          return;
        case "NOT_FOUND":
          toast.error("That endpoint no longer exists — refreshing.");
          setOpen(false);
          router.refresh();
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        case "VALIDATION":
          setError(result.fieldErrors?.reason?.join(" ") ?? result.message);
          return;
        case "CONFLICT":
          toast.error(result.message);
          return;
        case "INTERNAL":
          toast.error("The endpoint could not be revoked. Nothing was changed.");
          return;
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Revoke ${name}`}
      >
        <Ban aria-hidden />
        Revoke
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        {/* MOBILE_FIRST §4.6: a dialog carrying a form needs its own scroller — an Android keyboard
            shrinks the layout viewport and would otherwise push the confirm button off-screen. */}
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops receiving events immediately and its signing secret becomes useless. The endpoint row and its
              whole delivery history stay, which is why this is a revoke and not a delete. It cannot be re-activated —
              a replacement needs a new secret anyway. This is recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={reasonId}>Reason</Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error !== null) setError(null);
              }}
              rows={3}
              maxLength={REASON_MAX}
              disabled={pending}
              placeholder="Replaced by the n8n v2 endpoint"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
            {error === null ? (
              <p className="text-xs text-muted-foreground">At least {REASON_MIN} characters. Recorded in the audit log.</p>
            ) : (
              <p id={errorId} className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              // Radix closes on select by default; the action is async, so the close is ours to do.
              onClick={(e) => {
                e.preventDefault();
                onConfirm();
              }}
              disabled={pending || tooShort}
              aria-busy={pending || undefined}
            >
              {pending ? "Working…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
