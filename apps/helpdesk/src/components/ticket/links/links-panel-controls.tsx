"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { removeTicketLink } from "@/server/ticket-links.actions";
import { Button } from "@/components/ui/button";
import { AddLinkSheet } from "@/components/ticket/links/add-link-sheet";

/**
 * The two interactive controls on the links panel. The panel itself is an async SERVER component
 * and may not hold state, so the button that opens the sheet and the button that removes a row live
 * here — the same split `AttachmentsPanel` uses for its upload and remove controls.
 */

/** The panel's "Link ticket" button plus the sheet it owns. 44 px on phones, compact at md+. */
export function AddLinkButton({ ticketId }: { ticketId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-auto min-h-11 md:min-h-8"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Plus aria-hidden />
        Link ticket
      </Button>
      <AddLinkSheet ticketId={ticketId} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * Soft-remove one link. No confirmation dialog: the action is reversible by re-linking, both halves are
 * in the ledger, and a modal for a two-second undo is friction that teaches people to click through
 * modals. The label names the ticket so the row being removed is never ambiguous.
 */
export function RemoveLinkButton({
  linkId,
  otherTicketNumber,
}: {
  linkId: string;
  otherTicketNumber: number;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-11 shrink-0 text-muted-foreground md:size-8"
      disabled={pending}
      aria-label={`Remove the link to HD-${otherTicketNumber}`}
      onClick={() =>
        startTransition(async () => {
          const result = await removeTicketLink({ linkId });
          if (!result.ok) {
            toast.error(result.code === "FORBIDDEN" ? result.message : "The link could not be removed.");
            return;
          }
          toast.success(`Link to HD-${otherTicketNumber} removed`);
          router.refresh();
        })
      }
    >
      {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <X aria-hidden />}
    </Button>
  );
}
