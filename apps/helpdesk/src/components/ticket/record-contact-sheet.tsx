"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, PhoneCall, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { ActionError, ClientContactChannel, TicketDetailDTO } from "@/types/domain";
import { CLIENT_CONTACT_CHANNELS, CLIENT_CONTACT_CHANNEL_LABELS } from "@/types/domain";
import { recordClientContact } from "@/server/tickets.actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
} from "@/components/shell/responsive-sheet";
import { demoTextMax } from "@/lib/demo/mode";

/**
 * "Record client contact".
 *
 * The desk answers a great many clients by phone, and until Wave A that work was invisible: the
 * first-response clock only stopped on a written reply, so a returned voicemail inside ten minutes still
 * read as a breach. `recordClientContact` credits the callback as the first response under the same
 * conditional guard the reply path uses, writes an INTERNAL note carrying what was said, and audits
 * both in one transaction.
 *
 * INTERNAL, always: this note is the desk's own record of the call and never reaches the client
 * surface — so the sheet says so in as many words, above the box.
 *
 * Controlled by the parent so the same component serves the phone action dock and the md+ properties
 * panel without either owning the other's state.
 */

// Shorter in the public demo (src/lib/demo/mode.ts), as the server's schemas are.
const NOTE_MAX = demoTextMax(20_000);

export function RecordContactSheet({
  ticket,
  open,
  onOpenChange,
}: {
  ticket: TicketDetailDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const uid = useId();
  const [channel, setChannel] = useState<ClientContactChannel>("PHONE");
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  // A fresh sheet every time: a half-typed note from the previous call must never be attributed to this one.
  useEffect(() => {
    if (open) return;
    setChannel("PHONE");
    setNote("");
    setNoteError(null);
  }, [open]);

  const ids = { channel: `${uid}-channel`, note: `${uid}-note` };

  function applyError(err: ActionError): void {
    switch (err.code) {
      case "CONFLICT":
        toast.warning("Ticket changed elsewhere — refreshing. Your note was not saved.");
        router.refresh();
        return;
      case "VALIDATION": {
        const messages = err.fieldErrors?.note?.join(" ") ?? err.fieldErrors?._form?.join(" ") ?? err.message;
        setNoteError(messages);
        toast.error(messages);
        return;
      }
      case "FORBIDDEN":
        toast.error(err.message);
        return;
      case "UNAUTHORIZED":
        toast.error("Your session has ended. Sign in again.");
        router.refresh();
        return;
      case "NOT_FOUND":
        toast.error("Ticket not found");
        router.refresh();
        return;
      case "INTERNAL":
        toast.error("The contact could not be recorded. Nothing was saved.");
        return;
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const body = note.trim();
    if (body.length === 0) {
      setNoteError("Say what was discussed — this note is the record of the call.");
      return;
    }
    setNoteError(null);

    startTransition(async () => {
      const result = await recordClientContact({
        ticketId: ticket.id,
        version: ticket.version,
        channel,
        note: body,
      });
      if (!result.ok) {
        applyError(result);
        return;
      }
      toast.success(
        result.data.firstResponseStamped
          ? "Contact recorded — credited as the first response"
          : "Contact recorded",
      );
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
      title="Record client contact"
      description="A call, a returned voicemail or an in-person conversation — logged as an internal note."
      size="lg"
      height="full"
    >
      <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={pending || undefined}>
        <ResponsiveSheetBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.channel}>Channel</Label>
            <Select
              value={channel}
              onValueChange={(v) => {
                if ((CLIENT_CONTACT_CHANNELS as readonly string[]).includes(v)) setChannel(v as ClientContactChannel);
              }}
              disabled={pending}
            >
              <SelectTrigger id={ids.channel} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {CLIENT_CONTACT_CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {CLIENT_CONTACT_CHANNEL_LABELS[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.note}>What was discussed</Label>
            <Textarea
              id={ids.note}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
              rows={8}
              maxLength={NOTE_MAX}
              className="min-h-40 leading-relaxed"
              disabled={pending}
              aria-invalid={noteError ? true : undefined}
              aria-describedby={`${ids.note}-hint${noteError ? ` ${ids.note}-error` : ""}`}
            />
            {noteError ? (
              <p id={`${ids.note}-error`} className="text-xs text-destructive" role="alert">
                {noteError}
              </p>
            ) : null}
            <p id={`${ids.note}-hint`} className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Saved as an <strong>internal</strong> note — the client never sees it. Numbers matching SSN,
                card or account-number formats are redacted before saving.
              </span>
            </p>
          </div>

          {ticket.firstRespondedAt === null ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" role="status">
              This ticket has no first response yet, so recording this contact stops the first-response clock.
            </p>
          ) : null}
        </ResponsiveSheetBody>

        <ResponsiveSheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={pending}>
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <PhoneCall aria-hidden />}
            {pending ? "Recording…" : "Record contact"}
          </Button>
        </ResponsiveSheetFooter>
      </form>
    </ResponsiveSheet>
  );
}
