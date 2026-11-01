"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Inbox } from "lucide-react";
import type { QueueKey } from "@/types/domain";
import { QUEUE_LABELS } from "@/types/domain";
import { releaseHeldIntake } from "@/server/suspended-intake.actions";
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

const NOTE_MAX = 500;
/** Mirrors `UNVERIFIED_SENDER_NOTE_MIN` in `src/server/suspended-intake.actions.ts`. */
const UNVERIFIED_NOTE_MIN = 12;

/** Why the control refuses a reviewer who can read held mail but write no queue. Rendered, not hidden. */
const NO_QUEUE_REASON = "You can review held mail but not release it — that needs write access to a queue." as const;

export type ReleaseIntakeDialogProps = {
  suspendedId: string;
  subject: string;
  fromAddress: string;
  reasonLabel: string;
  /** True when the message arrived on an unmapped address: a queue must be chosen explicitly. */
  unknownMailbox: boolean;
  /**
   * False when nothing proved the message came from the address it claims — `HeldIntakeRow`'s
   * computed verdict, which is the reason AND the authentication result the hold recorded, not the
   * reason alone. A message can fail authentication and still be held as `UNKNOWN_MAILBOX` or
   * `SPAM`, because the intake gates are ordered and the reason enum holds one value.
   *
   * Releasing adopts that address as the ticket's requester, so the server demands an explicit
   * acknowledgement and a note on exactly this condition; this renders both.
   */
  senderVerified: boolean;
  /** Queues this reviewer may write. Empty means they may read held mail but not release it. */
  releasableQueues: QueueKey[];
  /**
   * Fix round 1. For a `FORWARDED` hold: the ORIGINAL sender parsed out of the forwarded block, or
   * null. When present the dialog offers a second, explicit path — attribute the ticket to that
   * address instead of to the colleague who forwarded it — and sends `releaseAsCandidate: true`.
   *
   * The address itself is never sent: the server takes a boolean and checks it against the same
   * stored column, so this control cannot point a ticket at an arbitrary address. The forwarder
   * remains the DEFAULT, because a human attributing the message is the whole point of the hold.
   */
  candidateRequesterEmail?: string | null;
};

/**
 * The release control, behind an explicit confirm (CONTRACT §3 `INTAKE_RELEASED`).
 *
 * Releasing is not a dismissal: it creates a real ticket, with an SLA clock, from a message the desk
 * decided not to trust. The dialog says what that produces and what it does NOT produce — nothing is
 * sent to the sender — because the one dangerous misreading of this button is "release = reply".
 *
 * The queue is a choice, not a default, whenever the mailbox map has no route for the address: a
 * ticket filed into the wrong queue is a ticket nobody is watching.
 */
export function ReleaseIntakeDialog({
  suspendedId,
  subject,
  fromAddress,
  reasonLabel,
  unknownMailbox,
  senderVerified,
  releasableQueues,
  candidateRequesterEmail = null,
}: ReleaseIntakeDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [confirmUnverifiedSender, setConfirmUnverifiedSender] = useState(false);
  /** "sender" = the address on the envelope (the forwarder); "candidate" = the person inside it. */
  const [attribution, setAttribution] = useState<"sender" | "candidate">("sender");
  const [queueKey, setQueueKey] = useState<QueueKey | "">(releasableQueues.length === 1 ? releasableQueues[0] : "");
  const [pending, startTransition] = useTransition();

  const noQueues = releasableQueues.length === 0;
  const noQueueReasonId = `no-queue-${suspendedId}`;
  const mustChooseQueue = unknownMailbox && queueKey === "";
  // The same two conditions the server enforces, restated so the button says no before the round
  // trip does. The server is still the gate; this is only the explanation.
  const mustAcknowledgeSender =
    !senderVerified && (!confirmUnverifiedSender || note.trim().length < UNVERIFIED_NOTE_MIN);

  function onConfirm(): void {
    startTransition(async () => {
      const result = await releaseHeldIntake({
        suspendedId,
        ...(queueKey === "" ? {} : { queueKey }),
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
        ...(senderVerified ? {} : { confirmUnverifiedSender }),
        ...(candidateRequesterEmail !== null && attribution === "candidate" ? { releaseAsCandidate: true } : {}),
      });

      if (result.ok) {
        toast.success(
          result.data.alreadyReleased
            ? `Already released as HD-${result.data.ticketNumber}`
            : `Released as HD-${result.data.ticketNumber}`,
        );
        setOpen(false);
        setNote("");
        setConfirmUnverifiedSender(false);
        setAttribution("sender");
        router.refresh();
        return;
      }

      switch (result.code) {
        case "FORBIDDEN":
          toast.error("You cannot release mail into that queue.");
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
          toast.error("The release failed. No ticket was created.");
          return;
      }
    });
  }

  return (
    <>
      {/*
        The refusal is VISIBLE text, not only a `title` (docs/MOBILE_FIRST.md R10): shadcn's Button sets
        `disabled:pointer-events-none`, so a tooltip on a disabled control never fires — and a phone has
        no hover at all. Same treatment as `user-active-dialog.tsx`.
      */}
      <div className="flex flex-col items-stretch gap-1 md:items-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full md:w-auto"
          disabled={noQueues}
          title={noQueues ? NO_QUEUE_REASON : undefined}
          aria-label={`Release the held message from ${fromAddress}`}
          aria-describedby={noQueues ? noQueueReasonId : undefined}
          onClick={() => setOpen(true)}
        >
          <Inbox aria-hidden />
          Release into a ticket
        </Button>
        {noQueues ? (
          <p id={noQueueReasonId} className="text-xs text-muted-foreground md:text-right">
            {NO_QUEUE_REASON}
          </p>
        ) : null}
      </div>

      <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        {/*
          docs/MOBILE_FIRST.md §4.6's recipe for a dialog that carries a form. `AlertDialogContent` is
          centred with no max-height and no scroller, which was fine for a title + two lines + two
          buttons; with a form inside it the box runs past 500 px, and an Android keyboard shrinks the
          layout viewport to roughly 390x400 (`interactive-widget: resizes-content`, src/app/layout.tsx),
          putting the confirm button off-screen with no way to scroll to it. The width half of §4.6's
          recipe is deliberately omitted: the primitive's own `data-[size=default]:max-w-xs` wins on
          specificity over a plain `max-w-*` utility, so it would be dead CSS.
        */}
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Release this message into a ticket?</AlertDialogTitle>
            <AlertDialogDescription>
              It was held as “{reasonLabel}”. The new ticket carries the stored preview — redacted, possibly
              truncated — with the sender, the mailbox and the Message-ID recorded on it, and it starts an SLA
              clock. <strong className="font-semibold">Nothing is sent to {fromAddress}.</strong> The release is
              recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-3">
            <p className="text-sm break-words" title={subject}>
              <span className="text-muted-foreground">Subject: </span>
              {subject}
            </p>

            {candidateRequesterEmail === null ? null : (
              <fieldset className="flex flex-col gap-2 rounded-lg border p-3" data-control="forwarded-attribution">
                <legend className="px-1 text-sm font-medium">Who is this ticket for?</legend>
                <p className="text-xs text-muted-foreground">
                  This is a forwarded copy, so the address it arrived from is whoever forwarded it. Replies go to
                  whichever address you pick here.
                </p>
                {/*
                  Native radios inside the AlertDialog, for the same reason the queue control is a native
                  select: no second Radix focus scope, and the label row carries the >= 44 px target (R3).
                  The FORWARDER is the default — the hold exists precisely so a person attributes the mail.
                */}
                <label
                  htmlFor={`attr-sender-${suspendedId}`}
                  className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm"
                >
                  <input
                    id={`attr-sender-${suspendedId}`}
                    type="radio"
                    name={`attribution-${suspendedId}`}
                    value="sender"
                    checked={attribution === "sender"}
                    disabled={pending}
                    onChange={() => setAttribution("sender")}
                    className="size-5 shrink-0 accent-primary"
                  />
                  <span className="break-all">{fromAddress} — the address that sent it on</span>
                </label>
                <label
                  htmlFor={`attr-candidate-${suspendedId}`}
                  className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm"
                >
                  <input
                    id={`attr-candidate-${suspendedId}`}
                    type="radio"
                    name={`attribution-${suspendedId}`}
                    value="candidate"
                    checked={attribution === "candidate"}
                    disabled={pending}
                    onChange={() => setAttribution("candidate")}
                    className="size-5 shrink-0 accent-primary"
                  />
                  <span className="break-all">
                    Appears to be from {candidateRequesterEmail} — the person inside the forward
                  </span>
                </label>
                <p className="text-xs text-muted-foreground">
                  The desk re-checks the second choice: it is refused unless the forward passed sender
                  authentication, the forwarder is active staff, and the address matches the one read out of the
                  forwarded block.
                </p>
              </fieldset>
            )}

            {senderVerified ? null : (
              <div className="flex flex-col gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-3">
                <p className="text-sm font-medium">Nothing proved this came from {fromAddress}.</p>
                <p className="text-xs text-muted-foreground">
                  Sender authentication failed or was missing, so the address is unproven. Releasing it makes that
                  address the ticket&apos;s requester: staff replies are delivered there, and anyone using it can open
                  this thread in the client portal. Check with the client on a number you already hold — never one
                  from the message — before you confirm.
                </p>
                {/*
                  A native checkbox, like the select below: no Radix focus scope nested inside the
                  AlertDialog's, and the label row carries the >= 44 px target (docs/MOBILE_FIRST.md R3).
                */}
                <label
                  htmlFor={`unverified-${suspendedId}`}
                  className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm"
                >
                  <input
                    id={`unverified-${suspendedId}`}
                    name="confirmUnverifiedSender"
                    type="checkbox"
                    checked={confirmUnverifiedSender}
                    disabled={pending}
                    onChange={(e) => setConfirmUnverifiedSender(e.target.checked)}
                    className="size-5 shrink-0 accent-primary"
                  />
                  <span>I have verified the sender another way and accept this address on the ticket.</span>
                </label>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`queue-${suspendedId}`}>
                Queue{unknownMailbox ? "" : " (optional — defaults to the mailbox's queue)"}
              </Label>
              {/*
                A native select, not shadcn's: this sits INSIDE an AlertDialog, and stacking two
                Radix focus scopes and portals for a three-option list buys nothing. globals.css
                already carries the >= 44 px tap target and the 16 px font rule for `select`
                (docs/MOBILE_FIRST.md R3, R4), and the classes below restate them locally.
              */}
              <select
                id={`queue-${suspendedId}`}
                name="queueKey"
                value={queueKey}
                disabled={pending}
                onChange={(e) => setQueueKey(e.target.value as QueueKey | "")}
                className="h-11 w-full rounded-md border bg-background px-3 text-base"
              >
                <option value="">{unknownMailbox ? "Choose a queue…" : "The mailbox's own queue"}</option>
                {releasableQueues.map((q) => (
                  <option key={q} value={q}>
                    {QUEUE_LABELS[q]}
                  </option>
                ))}
              </select>
              {unknownMailbox ? (
                <p className="text-xs text-muted-foreground">
                  This address is not in the mailbox map, so it has no queue of its own. Pick the one that should
                  own it.
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`note-${suspendedId}`}>
                {senderVerified ? "Why you are releasing it (optional)" : "How you verified the sender (required)"}
              </Label>
              <Input
                id={`note-${suspendedId}`}
                name="note"
                value={note}
                maxLength={NOTE_MAX}
                autoComplete="off"
                placeholder="Called the client back on 555-0123 and confirmed they sent it"
                onChange={(e) => setNote(e.target.value)}
                disabled={pending}
                required={!senderVerified}
                aria-describedby={`note-help-${suspendedId}`}
              />
              <p id={`note-help-${suspendedId}`} className="text-xs text-muted-foreground">
                Stored on the ticket. Do not put account numbers or client identifiers here.
                {senderVerified ? "" : ` At least ${UNVERIFIED_NOTE_MIN} characters — say how you reached the client.`}
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
              disabled={pending || mustChooseQueue || mustAcknowledgeSender}
              aria-busy={pending || undefined}
            >
              {pending ? "Working…" : "Release"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
