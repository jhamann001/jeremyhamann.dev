"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive } from "lucide-react";
import { discardHeldIntake } from "@/server/held-intake-discard.actions";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const REASON_MAX = 500;
/** Mirrors `discardSchema.reason.min(3)` in `src/server/held-intake-discard.actions.ts`. */
const REASON_MIN = 3;

export type DiscardIntakeDialogProps = {
  suspendedId: string;
  subject: string;
  fromAddress: string;
  reasonLabel: string;
  /**
   * When false, `releaseHeldIntake` cannot run on this row at all (its sender is not an address a
   * ticket could be answered at) — so this control is the ONLY disposition it has, and the dialog
   * says so instead of leaving the reviewer to guess.
   */
  releasable: boolean;
};

/**
 * The second disposition a held message needs: "this is not for the desk" (the build record,
 * *"released to nothing and marked, not removed"*).
 *
 * Five of the nine hold reasons are machine noise — a bounce, an out-of-office, a no-reply
 * notification, spam, a mail loop — and releasing one of those opens a real ticket with an SLA clock
 * on a message nobody should answer. Before this control existed the only alternative was to leave
 * the row `NEW` forever, which is what a reviewer sensibly did, so the queue only ever grew and the
 * client mail this page exists to surface ended up buried under it.
 *
 * The wording is deliberate and matches the release dialog's: **marked, never deleted**. The row, its
 * preview and its provenance stay exactly where they are, the append-only trigger on
 * `SuspendedIntake` means no code path can remove them, and the `Discarded` filter is the history.
 * The reason is required, not optional: a discard produces no ticket anybody can read later, so the
 * audit row is the whole record of the decision.
 */
export function DiscardIntakeDialog({
  suspendedId,
  subject,
  fromAddress,
  reasonLabel,
  releasable,
}: DiscardIntakeDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const trimmed = reason.trim();
  const tooShort = trimmed.length < REASON_MIN;
  const reasonId = `discard-reason-${suspendedId}`;
  const helpId = `discard-help-${suspendedId}`;

  function onConfirm(): void {
    startTransition(async () => {
      const result = await discardHeldIntake({ suspendedId, reason: trimmed });

      if (result.ok) {
        toast.success(
          result.data.alreadyDiscarded
            ? "That message was already marked as not for the desk"
            : "Marked as not for the desk — the message is kept, not deleted",
        );
        setOpen(false);
        setReason("");
        router.refresh();
        return;
      }

      switch (result.code) {
        case "FORBIDDEN":
          toast.error("You do not have permission to review held mail.");
          return;
        case "VALIDATION":
          toast.error(result.message);
          return;
        case "NOT_FOUND":
          toast.error("That held message no longer exists — refreshing.");
          setOpen(false);
          router.refresh();
          return;
        case "CONFLICT":
          toast.warning("Somebody else handled that message — refreshing.");
          setOpen(false);
          router.refresh();
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        case "INTERNAL":
          toast.error("The change failed. The message is still waiting.");
          return;
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full md:w-auto"
        aria-label={`Mark the held message from ${fromAddress} as not for the desk`}
        onClick={() => setOpen(true)}
      >
        <Archive aria-hidden />
        Not for the desk
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        {/*
          docs/MOBILE_FIRST.md §4.6's recipe for a dialog that carries a form: an Android keyboard
          shrinks the layout viewport to roughly 390x400 (`interactive-widget: resizes-content`), and a
          centred box with no ceiling and no scroller puts its confirm button off-screen.
        */}
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Mark this as not for the desk?</AlertDialogTitle>
            <AlertDialogDescription>
              It was held as “{reasonLabel}”. No ticket is created and{" "}
              <strong className="font-semibold">nothing is sent to {fromAddress}</strong>. The message is{" "}
              <strong className="font-semibold">marked, never deleted</strong>: it stays on this page under the
              Discarded filter, with its preview and its provenance, and the decision is recorded in the audit
              log under your name. There is no undo — a message marked here can only be read back, not released.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-3">
            <p className="text-sm break-words" title={subject}>
              <span className="text-muted-foreground">Subject: </span>
              {subject}
            </p>

            {!releasable ? (
              <p className="rounded-lg bg-muted/60 p-2 text-xs">
                This message has no sender address a ticket could be answered at, so it cannot be released. This
                is the only disposition it has.
              </p>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={reasonId}>Why it is not for the desk</Label>
              <Input
                id={reasonId}
                name="reason"
                value={reason}
                maxLength={REASON_MAX}
                autoComplete="off"
                required
                aria-describedby={helpId}
                placeholder="Out-of-office auto-reply, no client content"
                onChange={(e) => setReason(e.target.value)}
                disabled={pending}
              />
              <p id={helpId} className="text-xs text-muted-foreground">
                Required — this is the only record of the decision. Do not put account numbers or client
                identifiers here.
              </p>
            </div>
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
              {pending ? "Working…" : "Mark as not for the desk"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
