"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Trash } from "lucide-react";
import { toast } from "sonner";
import { removeAttachment } from "@/server/attachments.actions";
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

/**
 * Takes an attachment off the ticket.
 *
 * Confirmed, because it is not undoable from the UI — and deliberately honest about what it does:
 * the file is hidden from the ticket, not destroyed. Nothing in v1 hard-deletes an attachment; the
 * row and the stored object survive for books and records, and `ATTACHMENT_REMOVED` records who did
 * it and when.
 */
export function AttachmentRemoveButton({
  attachmentId,
  filename,
}: {
  attachmentId: string;
  filename: string;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm(): void {
    startTransition(async () => {
      const result = await removeAttachment({ attachmentId });
      if (result.ok) {
        toast.success(`${filename} removed from this ticket`);
        setOpen(false);
        router.refresh();
        return;
      }
      if (result.code === "UNAUTHORIZED") {
        toast.error("Your session has ended. Sign in again.");
        router.refresh();
        return;
      }
      if (result.code === "CONFLICT") {
        toast.warning("That attachment is no longer on this ticket");
        setOpen(false);
        router.refresh();
        return;
      }
      toast.error(result.message);
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-11 shrink-0 md:size-9"
        aria-label={`Remove ${filename} from this ticket`}
        onClick={() => setOpen(true)}
      >
        <Trash aria-hidden className="size-4" />
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => (pending ? null : setOpen(next))}>
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this attachment?</AlertDialogTitle>
            <AlertDialogDescription>
              {filename} comes off the ticket and stops appearing here. The file itself is kept for the record, and
              the removal is logged against your name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                confirm();
              }}
            >
              {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
