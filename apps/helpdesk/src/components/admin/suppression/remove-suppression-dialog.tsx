"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MailCheck } from "lucide-react";
import { toast } from "sonner";
import { removeSuppression } from "@/server/suppression.actions";
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
import { LIFT_REASON_MAX, LIFT_REASON_MIN } from "@/components/admin/suppression/suppression-form-support";

/**
 * Start writing to a suppressed address again (MOBILE_FIRST §4.6).
 *
 * Behind a confirm with a recorded reason, like every other reversal in this wave. The floor is twelve
 * characters because "why is it safe to write to this address again" is a real question — the address
 * bounced, or somebody reported us as spam — and the answer belongs on the row, not in somebody's
 * memory.
 *
 * The dialog says "start writing again", never "delete". Nothing is deleted: `removedAt` is stamped and
 * the row stays, because the history of who stopped and who restarted is the point of the table. The
 * database enforces it too (`requester_suppression_no_delete` is a trigger, not a convention).
 *
 * It also says plainly what does NOT happen: the replies that were refused while the suppression was
 * live are terminal and are not resent. A comment is immutable, so answering the client is a new reply.
 */
export function RemoveSuppressionDialog({
  suppressionId,
  email,
  className,
}: {
  suppressionId: string;
  email: string;
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

  const tooShort = reason.trim().length < LIFT_REASON_MIN;

  function onConfirm(): void {
    if (tooShort) {
      setError(`Please give a reason of at least ${LIFT_REASON_MIN} characters. It is recorded in the audit log.`);
      return;
    }
    startTransition(async () => {
      const result = await removeSuppression({ suppressionId, reason: reason.trim() });
      if (result.ok) {
        toast.success(`The desk will write to ${email} again`);
        setOpen(false);
        setReason("");
        setError(null);
        router.refresh();
        return;
      }
      switch (result.code) {
        case "FORBIDDEN":
          toast.error("You do not have permission to change the suppression list.");
          return;
        case "NOT_FOUND":
          toast.error("That suppression no longer exists — refreshing.");
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
          toast.error("The suppression could not be lifted. Nothing was changed.");
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
        aria-label={`Start writing to ${email} again`}
      >
        <MailCheck aria-hidden />
        Write again
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        {/* MOBILE_FIRST §4.6: a dialog carrying a form needs its own scroller — an Android keyboard
            shrinks the layout viewport and would otherwise push the confirm button off-screen. */}
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Write to {email} again?</AlertDialogTitle>
            <AlertDialogDescription>
              New replies to this address will be queued and handed to a sender as normal. The replies that were
              refused while it was suppressed stay refused — they are not resent, because a comment is the record of
              what was written at the time. The suppression row stays on file with the date it was lifted and by whom.
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
              maxLength={LIFT_REASON_MAX}
              disabled={pending}
              placeholder="Client confirmed the new mailbox is working on a recorded call"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
            />
            {error === null ? (
              <p className="text-xs text-muted-foreground">
                At least {LIFT_REASON_MIN} characters. Recorded in the audit log.
              </p>
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
              {pending ? "Working…" : "Write again"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
