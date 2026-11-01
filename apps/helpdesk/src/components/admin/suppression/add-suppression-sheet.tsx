"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import type { ActionError, SuppressionReason } from "@/types/domain";
import { SUPPRESSION_REASONS, SUPPRESSION_REASON_LABELS } from "@/types/domain";
import { addSuppression } from "@/server/suppression.actions";
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
import {
  LIFT_REASON_MAX,
  MANUAL_NOTE_PLACEHOLDER,
  SUPPRESSION_REASON_HELP,
} from "@/components/admin/suppression/suppression-form-support";

/**
 * Add an address to the suppression list (MOBILE_FIRST R1–R12).
 *
 * A bottom sheet on phones, a side sheet from `md`, like every other admin form in this wave.
 *
 * The form is three fields and one sentence, and the sentence is the important part: suppression stops
 * OUTBOUND mail only. An operator who believes it also blocks incoming mail will use it to deal with a
 * nuisance sender and will instead have silently stopped answering somebody. The sentence is on the
 * page and again in this sheet because it is the one thing that is worth saying twice.
 *
 * `HARD_BOUNCE` is offered here but it is not the path a bounce normally takes: the candidates list on
 * the page behind this sheet is where a recorded bounce is confirmed, with the count written into the
 * note by the server. This sheet is for the decisions that have no evidence behind them — the client
 * who asked to stop, the address somebody reported.
 */

type FieldErrors = Record<string, string[]>;

function FieldError({ id, messages }: { id: string; messages: string[] | undefined }): React.JSX.Element | null {
  if (!messages || messages.length === 0) return null;
  return (
    <p id={id} className="text-xs text-destructive" role="alert">
      {messages.join(" ")}
    </p>
  );
}

export function AddSuppressionSheet({ className }: { className?: string }): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const uid = useId();

  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<SuppressionReason>("MANUAL");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  // Seed on the OPEN transition only: re-seeding on every list refresh would wipe a part-filled form.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setEmail("");
      setReason("MANUAL");
      setNote("");
      setErrors({});
    }
    wasOpen.current = open;
  }, [open]);

  const ids = { email: `${uid}-email`, reason: `${uid}-reason`, note: `${uid}-note` };
  const errId = (k: keyof typeof ids): string => `${ids[k]}-error`;

  function applyError(err: ActionError): void {
    switch (err.code) {
      case "VALIDATION": {
        const fe = err.fieldErrors ?? {};
        setErrors(fe);
        toast.error(fe._form?.join(" ") ?? err.message);
        return;
      }
      case "FORBIDDEN":
        toast.error("You do not have permission to change the suppression list.");
        return;
      case "NOT_FOUND":
        toast.error("That record no longer exists — refreshing.");
        setOpen(false);
        router.refresh();
        return;
      case "UNAUTHORIZED":
        toast.error("Your session has ended. Sign in again.");
        router.refresh();
        return;
      case "CONFLICT":
        toast.error(err.message);
        return;
      case "INTERNAL":
        toast.error("The address could not be suppressed. Nothing was changed.");
        return;
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (trimmed.length === 0 || !trimmed.includes("@")) {
      setErrors({ email: ["Enter the email address the desk should stop writing to."] });
      toast.error("Please correct the highlighted field");
      return;
    }
    setErrors({});

    startTransition(async () => {
      const result = await addSuppression({
        email: trimmed,
        reason,
        ...(note.trim().length === 0 ? {} : { note: note.trim() }),
      });
      if (!result.ok) {
        applyError(result);
        return;
      }
      toast.success(`Outbound mail to ${trimmed} is stopped`);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Plus aria-hidden />
        Stop mail to an address
      </Button>

      <ResponsiveSheet
        open={open}
        onOpenChange={(o) => {
          if (!pending) setOpen(o);
        }}
        title="Stop outbound mail"
        description="Replies written to this address are still recorded — they are never handed to a sender. Adding an address is recorded in the audit log."
        size="lg"
        height="full"
      >
        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={pending || undefined}>
          <ResponsiveSheetBody className="flex flex-col gap-4">
            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">This stops outbound mail only.</span> Messages FROM this
              address still arrive, still become tickets and still reach the queue. Use it when the desk should stop
              writing — never to block a sender.
            </p>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.email}>Email address</Label>
              <Input
                id={ids.email}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={320}
                autoComplete="off"
                spellCheck={false}
                inputMode="email"
                disabled={pending}
                placeholder="name@example.com"
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={errors.email ? errId("email") : undefined}
              />
              <FieldError id={errId("email")} messages={errors.email} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.reason}>Reason</Label>
              <Select
                value={reason}
                onValueChange={(v) => setReason(v as SuppressionReason)}
                disabled={pending}
              >
                <SelectTrigger id={ids.reason} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPRESSION_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {SUPPRESSION_REASON_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{SUPPRESSION_REASON_HELP[reason]}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.note}>Note</Label>
              <Textarea
                id={ids.note}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={LIFT_REASON_MAX}
                disabled={pending}
                placeholder={MANUAL_NOTE_PLACEHOLDER}
                aria-invalid={errors.note ? true : undefined}
                aria-describedby={errors.note ? errId("note") : undefined}
              />
              <p className="text-xs text-muted-foreground">
                Optional, and the only place the reason will ever be written down. Account numbers and similar values
                are redacted before this is stored.
              </p>
              <FieldError id={errId("note")} messages={errors.note} />
            </div>
          </ResponsiveSheetBody>

          <ResponsiveSheetFooter>
            <Button type="submit" className="w-full md:w-auto" disabled={pending}>
              {pending ? "Working…" : "Stop outbound mail"}
            </Button>
          </ResponsiveSheetFooter>
        </form>
      </ResponsiveSheet>
    </>
  );
}
