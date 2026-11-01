"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import type { ActionError, TicketLinkKind } from "@/types/domain";
import { TICKET_LINK_KIND_LABELS } from "@/types/domain";
import { addTicketLink } from "@/server/ticket-links.actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
} from "@/components/shell/responsive-sheet";

/**
 * "Link another ticket". A bottom sheet on phones, a right sheet at md+ — one component, both
 * presentations, through `ResponsiveSheet` (MOBILE_FIRST D1).
 *
 * The operator types a **WM number**, not an id: that is the reference the desk actually speaks in, it
 * is what is pasted into Slack and Apex tickets, and it is the only one a person can read off a screen.
 *
 * `DUPLICATE_OF` is not offered here. Marking a duplicate sets a resolution and a status as well as a
 * link, and doing the three together is what `mergeTickets` is; offering a bare duplicate link would
 * let the row and the link disagree about the same fact.
 */
const KINDS: readonly TicketLinkKind[] = ["RELATED", "BLOCKS"];

const NOTE_MAX = 500;

export function AddLinkSheet({
  ticketId,
  open,
  onOpenChange,
}: {
  ticketId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const router = useRouter();
  const uid = useId();
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState<TicketLinkKind>("RELATED");
  const [number, setNumber] = useState("");
  const [note, setNote] = useState("");
  const [numberError, setNumberError] = useState<string | null>(null);
  const [noteError, setNoteError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setKind("RELATED");
    setNumber("");
    setNote("");
    setNumberError(null);
    setNoteError(null);
  }, [open]);

  const ids = { kind: `${uid}-kind`, number: `${uid}-number`, note: `${uid}-note` };

  function applyError(err: ActionError): void {
    setNumberError(err.fieldErrors?.otherTicketNumber?.join(" ") ?? null);
    setNoteError(err.fieldErrors?.note?.join(" ") ?? null);
    switch (err.code) {
      case "CONFLICT":
        toast.warning("The ticket changed elsewhere — refreshing. Nothing was linked.");
        router.refresh();
        return;
      case "UNAUTHORIZED":
        toast.error("Your session has ended. Sign in again.");
        router.refresh();
        return;
      case "VALIDATION":
        toast.error(err.fieldErrors?._form?.join(" ") ?? err.message);
        return;
      default:
        toast.error(err.message);
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const parsed = Number.parseInt(number.replace(/^\s*hd-?/i, "").trim(), 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      setNumberError("Enter a WM number, for example 1042.");
      return;
    }
    setNumberError(null);
    setNoteError(null);

    startTransition(async () => {
      const trimmed = note.trim();
      const result = await addTicketLink({
        ticketId,
        otherTicketNumber: parsed,
        kind,
        ...(trimmed.length > 0 ? { note: trimmed } : {}),
      });
      if (!result.ok) {
        applyError(result);
        return;
      }
      toast.success(`Linked to HD-${parsed}`);
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={(o) => {
        if (!pending) onOpenChange(o);
      }}
      title="Link another ticket"
      description="Point at a ticket this one relates to, or one it is waiting on."
      size="lg"
    >
      <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={pending || undefined}>
        <ResponsiveSheetBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.kind}>Relationship</Label>
            <Select
              value={kind}
              onValueChange={(v) => {
                if ((KINDS as readonly string[]).includes(v)) setKind(v as TicketLinkKind);
              }}
              disabled={pending}
            >
              <SelectTrigger id={ids.kind} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {TICKET_LINK_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {kind === "BLOCKS"
                ? "This ticket has to be finished before that one can be."
                : "The two are about the same matter, in either direction."}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.number}>Ticket number</Label>
            <Input
              id={ids.number}
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              inputMode="numeric"
              autoComplete="off"
              placeholder="1042"
              disabled={pending}
              aria-invalid={numberError ? true : undefined}
              aria-describedby={numberError ? `${ids.number}-error` : undefined}
              className="text-base md:text-sm"
            />
            {numberError ? (
              <p id={`${ids.number}-error`} role="alert" className="text-xs text-destructive">
                {numberError}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.note}>Why (optional)</Label>
            <Textarea
              id={ids.note}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={NOTE_MAX}
              disabled={pending}
              aria-invalid={noteError ? true : undefined}
              aria-describedby={`${ids.note}-hint${noteError ? ` ${ids.note}-error` : ""}`}
              className="text-base md:text-sm"
            />
            {noteError ? (
              <p id={`${ids.note}-error`} role="alert" className="text-xs text-destructive">
                {noteError}
              </p>
            ) : null}
            <p id={`${ids.note}-hint`} className="text-xs text-muted-foreground">
              Internal. Links to outside systems are limited to the firm&rsquo;s own — paste a WM number
              rather than a URL wherever you can.
            </p>
          </div>
        </ResponsiveSheetBody>

        <ResponsiveSheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={pending}>
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Link2 aria-hidden />}
            {pending ? "Linking…" : "Link ticket"}
          </Button>
        </ResponsiveSheetFooter>
      </form>
    </ResponsiveSheet>
  );
}
