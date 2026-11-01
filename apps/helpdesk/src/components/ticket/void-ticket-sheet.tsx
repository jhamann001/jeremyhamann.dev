"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CircleSlash, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import type { ActionError, TicketDetailDTO, Viewer } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";
import { canVoidTicket } from "@/lib/rbac";
import { formatTicketNumber } from "@/lib/format";
import { voidTicket } from "@/server/void.actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
} from "@/components/shell/responsive-sheet";
import { statusHelpFor } from "@/components/tickets/status-help";

/**
 * "Entered in error".
 *
 * All three rules below are POLICY rather than presentation, and all three are re-checked on the server
 * — this sheet only makes them visible before somebody commits to them:
 *
 *  - **ops_team AND queue WRITE** (`canVoidTicket`). The control is not rendered otherwise, and
 *    `voidTicket` refuses it regardless.
 *  - **A reason of at least 12 characters**, stored on the ticket AND on the `TICKET_VOIDED` row.
 *  - **Refused once the ticket carries a PUBLIC comment.** The server's test is the existence of that
 *    comment, not a delivery result and not current client visibility — a withdrawn reply, a phone-only
 *    ticket and a suppressed address all count, and in all three nothing was transmitted.
 *    Once the desk has written to a client the ticket is correspondence, and the answer to a mistake in
 *    correspondence is a correction. The sheet says so before the attempt, rather than letting the
 *    server say it after; the server's refusal text (rendered verbatim in the error slot) is the half
 *    that distinguishes a live reply from one already withdrawn.
 *
 * The sheet is deliberately blunt about what a void does: it takes the ticket out of every counter,
 * every SLA number and every export, and it cannot be undone. `VOIDED` has no transitions out of it.
 */
export type VoidTicketSheetProps = { ticket: TicketDetailDTO; viewer: Viewer };

export function VoidTicketSheet({ ticket, viewer }: VoidTicketSheetProps): React.JSX.Element | null {
  const router = useRouter();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setReason("");
    setError(null);
  }, [open]);

  const allowed = canVoidTicket(viewer.groups, ticket.queueKey);
  const alreadyTerminal = ticket.status === "VOIDED" || ticket.status === "CLOSED";
  if (!allowed || alreadyTerminal) return null;

  function applyError(err: ActionError): void {
    const message = err.fieldErrors?.reason?.join(" ") ?? err.fieldErrors?._form?.join(" ") ?? err.message;
    setError(message);
    if (err.code === "CONFLICT") {
      toast.warning("The ticket changed elsewhere — refreshing. Nothing was voided.");
      router.refresh();
      return;
    }
    if (err.code === "UNAUTHORIZED") {
      toast.error("Your session has ended. Sign in again.");
      router.refresh();
      return;
    }
    toast.error(message);
  }

  const help = statusHelpFor("VOIDED");

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-11 self-start text-muted-foreground md:min-h-8"
        data-slice="B2-void"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <CircleSlash aria-hidden />
        Entered in error
      </Button>

      <ResponsiveSheet
        open={open}
        onOpenChange={(o) => {
          if (!pending) setOpen(o);
        }}
        title={`Void ${formatTicketNumber(ticket.number)}`}
        description="For a ticket that should never have existed — a test, a mis-file, a duplicate of your own keystroke."
        size="lg"
      >
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          aria-busy={pending || undefined}
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = reason.trim();
            if (trimmed.length < WAVE_B_LIMITS.reasonMinChars) {
              setError(`Say why, in at least ${WAVE_B_LIMITS.reasonMinChars} characters.`);
              return;
            }
            setError(null);
            startTransition(async () => {
              const result = await voidTicket({
                ticketId: ticket.id,
                version: ticket.version,
                reason: trimmed,
                confirm: true,
              });
              if (!result.ok) {
                applyError(result);
                return;
              }
              toast.success(`${formatTicketNumber(ticket.number)} was voided`);
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <ResponsiveSheetBody className="flex flex-col gap-4">
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
              <p className="font-medium">{help.means}</p>
              <p className="mt-0.5 text-muted-foreground">{help.watchOut}</p>
            </div>

            <p className="text-xs text-muted-foreground">
              Use <strong>Mark as duplicate</strong> when the client really did ask, twice. Voiding says the
              request never happened, and that is a different claim.
            </p>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${uid}-reason`}>Why should this ticket never have existed?</Label>
              <Textarea
                id={`${uid}-reason`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                minLength={WAVE_B_LIMITS.reasonMinChars}
                maxLength={WAVE_B_LIMITS.reasonMaxChars}
                disabled={pending}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${uid}-hint${error ? ` ${uid}-error` : ""}`}
                className="text-base md:text-sm"
              />
              {error ? (
                <p id={`${uid}-error`} role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
              <p id={`${uid}-hint`} className="text-xs text-muted-foreground">
                Stored on the ticket and on the audit row. Numbers matching SSN, card or account-number formats are
                redacted first.
              </p>
            </div>
          </ResponsiveSheetBody>

          <ResponsiveSheetFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" className="flex-1" disabled={pending}>
              {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <CircleSlash aria-hidden />}
              {pending ? "Voiding…" : "Void this ticket"}
            </Button>
          </ResponsiveSheetFooter>
        </form>
      </ResponsiveSheet>
    </>
  );
}
