"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MailX } from "lucide-react";
import { toast } from "sonner";
import { confirmBounceSuppression } from "@/server/suppression.actions";
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
import { bounceCountLabel } from "@/components/admin/suppression/suppression-form-support";

/**
 * Confirm a hard-bounce candidate into a suppression.
 *
 * This button IS the "candidate, never automatic" rule. `recordBounce` marks the delivery and stops;
 * nothing suppresses the address until somebody reads this dialog and presses the button, and the
 * ledger records who did.
 *
 * The confirm is deliberately a dialog rather than a one-click action even though the reason and the
 * note are both derived server-side. The click stops the desk writing to a client, and a control that
 * does that from a list row is a control somebody presses on the wrong row from a phone.
 *
 * The count in the dialog is what the page rendered; the count the server records is re-derived from
 * the deliveries, so a stale page cannot put a number that was never true into a compliance record.
 */
export function ConfirmBounceButton({
  email,
  bounces,
  className,
}: {
  email: string;
  bounces: number;
  className?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function onConfirm(): void {
    startTransition(async () => {
      const result = await confirmBounceSuppression({ email });
      if (result.ok) {
        toast.success(`Outbound mail to ${email} is stopped`);
        setOpen(false);
        router.refresh();
        return;
      }
      switch (result.code) {
        case "FORBIDDEN":
          toast.error("You do not have permission to change the suppression list.");
          return;
        case "VALIDATION":
          toast.error(result.fieldErrors?._form?.join(" ") ?? result.message);
          setOpen(false);
          router.refresh();
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        case "NOT_FOUND":
        case "CONFLICT":
          toast.error(result.message);
          setOpen(false);
          router.refresh();
          return;
        case "INTERNAL":
          toast.error("The address could not be suppressed. Nothing was changed.");
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
        aria-label={`Stop writing to ${email}`}
      >
        <MailX aria-hidden />
        Stop writing
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Stop writing to {email}?</AlertDialogTitle>
            <AlertDialogDescription>
              The receiving server has rejected {bounceCountLabel(bounces)} to this address as permanent. Confirming
              records a <span className="font-medium">hard bounce</span> suppression: replies the desk writes are still
              recorded on the ticket, and are never handed to a sender. Mail FROM this address still reaches the desk.
              This is recorded in the audit log and can be lifted from this page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onConfirm();
              }}
              disabled={pending}
              aria-busy={pending || undefined}
            >
              {pending ? "Working…" : "Stop writing"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
