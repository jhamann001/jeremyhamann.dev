"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { ActionError, IdentityVerificationMethod } from "@/types/domain";
import {
  IDENTITY_VERIFICATION_METHODS,
  IDENTITY_VERIFICATION_METHOD_LABELS,
  WAVE_B_LIMITS,
} from "@/types/domain";
import { overrideIdentityGate, recordIdentityVerification } from "@/server/identity-verification.actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
} from "@/components/shell/responsive-sheet";

/**
 * The client half of the identity-verification panel — slice B6.
 *
 * `identity-verification.tsx` is an async SERVER component (it owns its own data load),
 * so the two write controls live here. A sibling file rather than a nested directory because there is
 * exactly one of them; recorded as an addition in the build record.
 *
 * Two sheets, because they are two different acts with two different bars:
 *  - **Record** — queue WRITE (`identity:verify`). Method, outcome, and how the check was made.
 *  - **Override** — `ops_team` as well, and only while the gate is unsatisfied. A confirmation and a
 *    reason of at least `WAVE_B_LIMITS.reasonMinChars` characters, because the override is the one
 *    control here that removes a requirement rather than satisfying it.
 *
 * Both gates are re-checked on the server; the props only decide what is drawn.
 *
 * MOBILE: bottom sheet on phones, right sheet at md+, 44 px targets, 16 px controls.
 */
export type IdentityVerificationControlsProps = {
  ticketId: string;
  canRecord: boolean;
  canOverride: boolean;
  gateRequired: boolean;
  gateSatisfied: boolean;
};

type Outcome = "VERIFIED" | "FAILED";

export function IdentityVerificationControls({
  ticketId,
  canRecord,
  canOverride,
  gateRequired,
  gateSatisfied,
}: IdentityVerificationControlsProps): React.JSX.Element | null {
  const [recordOpen, setRecordOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);

  if (!canRecord && !canOverride) return null;

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {canRecord ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 justify-center"
          onClick={() => setRecordOpen(true)}
        >
          <ShieldCheck aria-hidden />
          Record verification
        </Button>
      ) : null}

      {canOverride ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 justify-center"
          onClick={() => setOverrideOpen(true)}
        >
          <ShieldAlert aria-hidden />
          Override gate
        </Button>
      ) : null}

      {canRecord ? (
        <RecordSheet
          ticketId={ticketId}
          open={recordOpen}
          onOpenChange={setRecordOpen}
          gateRequired={gateRequired}
          gateSatisfied={gateSatisfied}
        />
      ) : null}
      {canOverride ? (
        <OverrideSheet ticketId={ticketId} open={overrideOpen} onOpenChange={setOverrideOpen} />
      ) : null}
    </div>
  );
}

/** Shared error rendering: one place decides what each ActionError code says to a person. */
function useActionErrors(setFieldError: (m: string | null) => void): (err: ActionError) => void {
  const router = useRouter();
  return (err: ActionError): void => {
    switch (err.code) {
      case "VALIDATION": {
        const message =
          err.fieldErrors?.note?.join(" ") ??
          err.fieldErrors?.reason?.join(" ") ??
          err.fieldErrors?.confirm?.join(" ") ??
          err.fieldErrors?._form?.join(" ") ??
          err.message;
        setFieldError(message);
        toast.error(message);
        return;
      }
      case "CONFLICT":
        toast.warning("This ticket changed elsewhere — refreshing.");
        router.refresh();
        return;
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
        toast.error("Nothing was saved.");
        return;
    }
  };
}

function RecordSheet({
  ticketId,
  open,
  onOpenChange,
  gateRequired,
  gateSatisfied,
}: {
  ticketId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gateRequired: boolean;
  gateSatisfied: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const uid = useId();
  const [method, setMethod] = useState<IdentityVerificationMethod>("CALLBACK_KNOWN_NUMBER");
  const [outcome, setOutcome] = useState<Outcome>("VERIFIED");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const applyError = useActionErrors(setError);

  useEffect(() => {
    if (open) return;
    setMethod("CALLBACK_KNOWN_NUMBER");
    setOutcome("VERIFIED");
    setNote("");
    setError(null);
  }, [open]);

  const ids = { method: `${uid}-method`, outcome: `${uid}-outcome`, note: `${uid}-note` };

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await recordIdentityVerification({ ticketId, method, result: outcome, note: note.trim() });
      if (!result.ok) {
        applyError(result);
        return;
      }
      toast.success(outcome === "VERIFIED" ? "Identity verification recorded" : "Failed verification recorded");
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
      title="Record identity verification"
      description="How you established who you were speaking to."
      size="lg"
      height="full"
    >
      <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={pending || undefined}>
        <ResponsiveSheetBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.method}>Method</Label>
            <Select
              value={method}
              onValueChange={(v) => {
                if ((IDENTITY_VERIFICATION_METHODS as readonly string[]).includes(v)) {
                  setMethod(v as IdentityVerificationMethod);
                }
              }}
              disabled={pending}
            >
              <SelectTrigger id={ids.method} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {IDENTITY_VERIFICATION_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {IDENTITY_VERIFICATION_METHOD_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <span id={ids.outcome} className="text-sm font-medium">
              Outcome
            </span>
            <div role="group" aria-labelledby={ids.outcome} className="grid grid-cols-2 gap-2">
              {(
                [
                  ["VERIFIED", "Verified"],
                  ["FAILED", "Not verified"],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  variant={outcome === value ? "default" : "outline"}
                  className="min-h-11 justify-center"
                  aria-pressed={outcome === value}
                  disabled={pending}
                  onClick={() => setOutcome(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              A failed check is worth recording: it is evidence the check happened. It does not let a
              gated ticket resolve.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.note}>How you established it</Label>
            <Textarea
              id={ids.note}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              required
              rows={5}
              maxLength={WAVE_B_LIMITS.reasonMaxChars}
              className="min-h-28 leading-relaxed"
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${ids.note}-hint${error ? ` ${ids.note}-error` : ""}`}
            />
            {error ? (
              <p id={`${ids.note}-error`} className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <p id={`${ids.note}-hint`} className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ShieldAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Say what you did — &ldquo;called the number on file and the client confirmed the last
                transfer&rdquo;. Do <strong>not</strong> copy the identifiers you checked. A date of
                birth, a licence number or a passport number typed here is <strong>stored as you type
                it</strong>; only Social Security, card and account numbers are redacted before saving.
                A record of the check is what is needed, not a copy of the document.
              </span>
            </p>
          </div>

          {gateRequired && !gateSatisfied ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" role="status">
              This ticket cannot be resolved until a verification passes or the gate is overridden.
            </p>
          ) : null}
        </ResponsiveSheetBody>

        <ResponsiveSheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={pending}>
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <ShieldCheck aria-hidden />}
            {pending ? "Recording…" : "Record"}
          </Button>
        </ResponsiveSheetFooter>
      </form>
    </ResponsiveSheet>
  );
}

function OverrideSheet({
  ticketId,
  open,
  onOpenChange,
}: {
  ticketId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const uid = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const applyError = useActionErrors(setError);

  useEffect(() => {
    if (open) return;
    setReason("");
    setError(null);
  }, [open]);

  const ids = { reason: `${uid}-reason` };
  const tooShort = reason.trim().length < WAVE_B_LIMITS.reasonMinChars;

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await overrideIdentityGate({ ticketId, reason: reason.trim(), confirm: true });
      if (!result.ok) {
        applyError(result);
        return;
      }
      toast.success("Override recorded — this ticket may now be resolved");
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
      title="Override the identity gate"
      description="Let this ticket resolve without a verification, with your name and your reason on it."
      size="lg"
      height="full"
    >
      <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={pending || undefined}>
        <ResponsiveSheetBody className="flex flex-col gap-4">
          <p className="rounded-md border border-amber-500/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            This is recorded as an override, not as a verification. It writes a row a reviewer can
            filter on, so &ldquo;resolved without a verification&rdquo; is a fact rather than an absence.
            It cannot be undone.
          </p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.reason}>Why this ticket may resolve without one</Label>
            <Textarea
              id={ids.reason}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              rows={5}
              minLength={WAVE_B_LIMITS.reasonMinChars}
              maxLength={WAVE_B_LIMITS.reasonMaxChars}
              className="min-h-28 leading-relaxed"
              disabled={pending}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${ids.reason}-hint${error ? ` ${ids.reason}-error` : ""}`}
            />
            {error ? (
              <p id={`${ids.reason}-error`} className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <p id={`${ids.reason}-hint`} className="text-xs text-muted-foreground">
              At least {WAVE_B_LIMITS.reasonMinChars} characters. This sentence is what a reviewer reads
              a year from now.
            </p>
          </div>
        </ResponsiveSheetBody>

        <ResponsiveSheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" className="flex-1" disabled={pending || tooShort}>
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <ShieldAlert aria-hidden />}
            {pending ? "Recording…" : "Record override"}
          </Button>
        </ResponsiveSheetFooter>
      </form>
    </ResponsiveSheet>
  );
}
