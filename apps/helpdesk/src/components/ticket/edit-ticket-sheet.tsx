"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, LoaderCircle, Lock, MailWarning, Pencil, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type {
  ActionError,
  TicketBrand,
  TicketCategory,
  TicketDetailDTO,
  UpdateTicketFieldsInput,
} from "@/types/domain";
import { BRAND_LABELS, CATEGORY_LABELS, TICKET_BRANDS, TICKET_CATEGORIES } from "@/types/domain";
import { changeRequesterEmail, updateTicketFields } from "@/server/tickets.actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
 * Edit the ticket's own fields (the build record S6 `updateTicketFields`): subject, category,
 * requester identity, brand and the single external reference. Everything else on the ticket has its own
 * dedicated control — status, priority, assignee and queue live in the properties panel, because each is
 * a policy decision with its own audit action rather than a typo fix.
 *
 * Bottom sheet on phones / side sheet at md+ (`ResponsiveSheet`). One submit,
 * one server action, one `router.refresh()` (R8/G12).
 *
 * Only CHANGED fields are sent, so `updateTicketFields` writes exactly one `TICKET_FIELD_CHANGED` row per
 * field the operator actually touched and an untouched form is a no-op rather than a fake edit. The
 * version token travels with it: a CONFLICT does NOT silently retry — the operator is shown what
 * happened and offered a reload, because the other writer may have changed the very field being edited.
 *
 * `complaintFiledAt` is deliberately absent: it is server-stamped, never an input.
 *
 * **The requester address is a two-step control, not a field.** Once a ticket HAS an address, re-pointing
 * it is an access-control decision — the new address inherits read access to every PUBLIC comment already
 * on the thread through the client API, and every future reply is delivered there — so `updateTicketFields`
 * refuses a REDIRECT outright and `changeRequesterEmail` (confirmation + recorded reason) is the only way
 * through. The input therefore goes `readOnly` while a value is stored, a **Change address** button opens
 * that second step, and `buildPatch` can only ever produce an ADOPT (a phone-only ticket getting its first
 * address) or a CLEAR. This dialog is the app's only caller of `changeRequesterEmail`.
 *
 * Fix round 2: that second step is now a TOP-LEVEL `ResponsiveSheet`, not a `Dialog` floating on top of
 * this one. The rule the wave states twice — `TicketActionDock` hoisting `RecordContactSheet`
 * (ticket-action-dock.tsx) and docs/MOBILE_FIRST.md §4.5 — is about LAYERS, not element types: a centred
 * dialog over a 90 svh bottom sheet is still focus-trapped text entry two overlays deep with a keyboard
 * up at 390×844, and the §7 ticket-detail check counts sheet layers. So "Change address" closes this
 * sheet first and opens its own; Cancel (or a dismiss) re-opens this one, and success closes both.
 *
 * **When the ticket cannot be edited the control stays reachable and the sheet states the reason**
 * (docs/MOBILE_FIRST.md R10: nothing that matters is tooltip-only on phones). It used to be a `disabled`
 * button whose only explanation was a `title` — and shadcn's Button carries `disabled:pointer-events-none`,
 * so that tooltip could not fire on a desktop hover and a phone has no hover at all. The pencil is the
 * phone's ONLY edit affordance (the labelled "Edit fields" button is `variant="card"`, i.e. md+ only), so
 * a CS rep opening an Operations ticket on a phone saw a grey pencil and was told nothing. Now the sheet
 * opens read-only: every field is visible but disabled, the header prints the reason, and there is no
 * Save button, so the UI cannot offer a write the server would refuse.
 */

type FieldErrors = Record<string, string[]>;

/** Normalizes the way the server does, so "unchanged" here means unchanged there. */
function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}

function blankToNull(v: string): string | null {
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function FieldError({ id, messages }: { id: string; messages: string[] | undefined }): React.JSX.Element | null {
  if (!messages || messages.length === 0) return null;
  return (
    <p id={id} className="text-xs text-destructive" role="alert">
      {messages.join(" ")}
    </p>
  );
}

export function EditTicketSheet({
  ticket,
  trigger,
  className,
  requesterEmailChangedAt = null,
}: {
  ticket: TicketDetailDTO;
  /** "icon" = the pencil in the header; "button" = the labelled control in the properties panel. */
  trigger: "icon" | "button";
  className?: string;
  /**
   * When the ledger shows this ticket's requester address has already been moved away from — including a
   * plain CLEAR — the address is privileged even though the column is null right now. Supplied by the
   * page from `requesterEmailChangedAt` (`@/server/tickets`), the same read the header's banner uses.
   *
   * Without it the sheet would offer an ordinary editable field after a CLEAR and the server would
   * refuse the submission, pointing the operator at a control that was not on screen
   *.
   */
  requesterEmailChangedAt?: string | null;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const uid = useId();

  const closed = ticket.status === "CLOSED";
  const readOnly = closed || !ticket.permissions.canWrite;

  const [subject, setSubject] = useState(ticket.subject);
  const [category, setCategory] = useState<TicketCategory>(ticket.category);
  const [requesterName, setRequesterName] = useState(ticket.requesterName);
  const [requesterEmail, setRequesterEmail] = useState(ticket.requesterEmail ?? "");
  const [requesterPhone, setRequesterPhone] = useState(ticket.requesterPhone ?? "");
  const [brand, setBrand] = useState<TicketBrand>(ticket.brand);
  const [externalRef, setExternalRef] = useState(ticket.externalRef ?? "");
  const [errors, setErrors] = useState<FieldErrors>({});

  /**
   * Step two of the requester-address flow. An address ALREADY on the ticket cannot be re-pointed from
   * this form: `updateTicketFields` refuses a REDIRECT outright (src/server/tickets.actions.ts), because
   * the address is the client API's authorization subject and the destination of every outbound reply.
   * So the field goes read-only once a value is stored, and changing it opens this dialog, which is the
   * only caller of `changeRequesterEmail` — new address, a written reason, explicit confirmation.
   */
  const [redirectOpen, setRedirectOpen] = useState(false);
  const [redirectEmail, setRedirectEmail] = useState("");
  const [redirectReason, setRedirectReason] = useState("");
  const [redirectErrors, setRedirectErrors] = useState<FieldErrors>({});
  const [redirectPending, startRedirect] = useTransition();

  /**
   * Seed the form from the DTO on the OPEN transition only. Re-seeding whenever the ticket prop changes
   * would wipe what the operator is typing the moment anything else on the page refreshes — and it would
   * do so silently, then save the re-seeded values under the new version token. A concurrent change is
   * meant to surface as the CONFLICT dialog below, not as vanished typing.
   */
  const wasOpen = useRef(false);
  /**
   * Set only by `closeRedirect`. Hoisting the redirect step out of this sheet means the edit sheet
   * genuinely closes and re-opens, and without this the re-open would re-seed the form and silently
   * discard whatever the operator had already typed — the exact failure the comment above forbids.
   */
  const restoringEditRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current && restoringEditRef.current) {
      // Coming back from the redirect sheet: same editing session, so keep the form as it was.
      restoringEditRef.current = false;
    } else if (open && !wasOpen.current) {
      setSubject(ticket.subject);
      setCategory(ticket.category);
      setRequesterName(ticket.requesterName);
      setRequesterPhone(ticket.requesterPhone ?? "");
      setRequesterEmail(ticket.requesterEmail ?? "");
      setBrand(ticket.brand);
      setExternalRef(ticket.externalRef ?? "");
      setErrors({});
    }
    wasOpen.current = open;
    // Only the open transition seeds; the ticket fields are read at that instant on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ids = {
    subject: `${uid}-subject`,
    category: `${uid}-category`,
    requesterName: `${uid}-requester-name`,
    requesterEmail: `${uid}-requester-email`,
    requesterPhone: `${uid}-requester-phone`,
    brand: `${uid}-brand`,
    externalRef: `${uid}-external-ref`,
    redirectEmail: `${uid}-redirect-email`,
    redirectReason: `${uid}-redirect-reason`,
  };
  const errId = (k: keyof typeof ids) => `${ids[k]}-error`;

  function applyError(err: ActionError): void {
    switch (err.code) {
      case "CONFLICT":
        setConflict(true);
        return;
      case "VALIDATION": {
        const fe = err.fieldErrors ?? {};
        setErrors(fe);
        toast.error(fe._form?.join(" ") ?? "Please correct the highlighted fields");
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
        toast.error("The ticket could not be saved. Nothing was changed.");
        return;
    }
  }

  /** Only the fields that actually differ from the DTO. Empty object ⇒ nothing to save. */
  function buildPatch(): Omit<UpdateTicketFieldsInput, "ticketId" | "version"> {
    const patch: Omit<UpdateTicketFieldsInput, "ticketId" | "version"> = {};
    const nextSubject = subject.trim();
    if (nextSubject !== ticket.subject) patch.subject = nextSubject;
    if (category !== ticket.category) patch.category = category;
    const nextName = requesterName.trim();
    if (nextName !== ticket.requesterName) patch.requesterName = nextName;
    // CLEAR, and a FIRST adoption only. Neither a REDIRECT nor a re-adoption after a clear can be
    // built here: the field is read-only whenever the address is privileged, and this guard is the belt
    // to that braces, so a stale DTO or a pasted value can never send the server a change it is going
    // to refuse. `changeRequesterEmail` owns both of those moves.
    const nextEmail = normalizeEmail(requesterEmail);
    const currentEmail = ticket.requesterEmail ?? "";
    if (nextEmail !== currentEmail) {
      if (currentEmail.length > 0 && nextEmail.length === 0) patch.requesterEmail = null;
      else if (currentEmail.length === 0 && nextEmail.length > 0 && !addressIsPrivileged) {
        patch.requesterEmail = nextEmail;
      }
    }
    const nextPhone = blankToNull(requesterPhone);
    if (nextPhone !== ticket.requesterPhone) patch.requesterPhone = nextPhone;
    if (brand !== ticket.brand) patch.brand = brand;
    const nextRef = blankToNull(externalRef);
    if (nextRef !== ticket.externalRef) patch.externalRef = nextRef;
    return patch;
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    // Read-only renders no submit control; this is the belt to that braces (a stray Enter in a field).
    if (readOnly) return;
    setErrors({});

    // Mirrors the DB CHECK `ticket_requester_contact_present` so the operator sees a
    // field-level message instead of an opaque INTERNAL from a constraint violation.
    if (normalizeEmail(requesterEmail).length === 0 && blankToNull(requesterPhone) === null) {
      setErrors({ requesterEmail: ["A ticket needs a requester email or a phone number."] });
      toast.error("A ticket needs a requester email or a phone number.");
      return;
    }

    const patch = buildPatch();
    if (Object.keys(patch).length === 0) {
      toast.info("Nothing changed");
      setOpen(false);
      return;
    }

    startTransition(async () => {
      const result = await updateTicketFields({ ticketId: ticket.id, version: ticket.version, ...patch });
      if (!result.ok) {
        applyError(result);
        return;
      }
      if (result.data.piiRedacted) {
        const n = result.data.piiRedactionCount;
        toast.warning(`Sensitive numbers were redacted before saving (${n} ${n === 1 ? "item" : "items"})`);
      }
      toast.success("Ticket updated");
      setOpen(false);
      router.refresh();
    });
  }

  const storedEmail = ticket.requesterEmail ?? "";
  const hasStoredEmail = storedEmail.length > 0;
  /**
   * The controls attach to the column's HISTORY, not to its current value: a CLEAR is a move, not a
   * neutral edit (src/server/tickets.actions.ts `previousRequesterEmail`). A ticket whose address was
   * cleared still routes any new address through `changeRequesterEmail`, so the form has to keep
   * offering that step rather than an editable field the server will refuse.
   *
   * `hasStoredEmail` stays the test for copy that speaks about "the address on this ticket" — there
   * isn't one after a clear.
   */
  const addressIsPrivileged = hasStoredEmail || requesterEmailChangedAt !== null;
  /** Long enough that "typo" alone does not pass — mirrors REQUESTER_EMAIL_REASON_MIN on the server. */
  const REDIRECT_REASON_MIN = 12;

  /**
   * Hoist, don't stack: close the edit sheet in the same tick as opening the redirect
   * one, so exactly one overlay is ever the live layer — the dock's `RecordContactSheet` hand-off,
   * verbatim. `reopenEditRef` remembers that the operator came from the edit sheet, so backing out
   * returns them to it rather than to the bare ticket page.
   */
  const reopenEditRef = useRef(false);

  function openRedirect(): void {
    setRedirectEmail("");
    setRedirectReason("");
    setRedirectErrors({});
    reopenEditRef.current = open;
    setOpen(false);
    setRedirectOpen(true);
  }

  /** Cancel, Escape, the X and an overlay tap all land here: close this layer, restore the previous one. */
  function closeRedirect(): void {
    if (redirectPending) return;
    setRedirectOpen(false);
    if (reopenEditRef.current) {
      reopenEditRef.current = false;
      restoringEditRef.current = true;
      setOpen(true);
    }
  }

  function onRedirectSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (readOnly) return;
    setRedirectErrors({});

    const next = normalizeEmail(redirectEmail);
    const reason = redirectReason.trim();
    const local: FieldErrors = {};
    if (next.length === 0) local.requesterEmail = ["Enter the address correspondence should go to."];
    else if (next === storedEmail) local.requesterEmail = ["That is already the address on this ticket."];
    if (reason.length < REDIRECT_REASON_MIN) {
      local.reason = [`Say why the address is changing (at least ${REDIRECT_REASON_MIN} characters).`];
    }
    if (Object.keys(local).length > 0) {
      setRedirectErrors(local);
      return;
    }

    startRedirect(async () => {
      const result = await changeRequesterEmail({
        ticketId: ticket.id,
        version: ticket.version,
        requesterEmail: next,
        reason,
        confirm: true,
      });
      if (!result.ok) {
        // The server owns the refusals this form cannot know about — a complaint or an escalated
        // ticket, whose correspondence record is fixed — so its wording is shown, not paraphrased.
        if (result.code === "CONFLICT") {
          reopenEditRef.current = false;
          setRedirectOpen(false);
          setConflict(true);
          return;
        }
        if (result.code === "VALIDATION") {
          setRedirectErrors(result.fieldErrors ?? {});
          toast.error(result.fieldErrors?._form?.join(" ") ?? result.message);
          return;
        }
        setRedirectErrors({ _form: [result.message] });
        toast.error(result.message);
        return;
      }
      toast.success(`Correspondence now goes to ${result.data.requesterEmail}`);
      reopenEditRef.current = false;
      setRedirectOpen(false);
      setOpen(false);
      router.refresh();
    });
  }

  const disabledReason = closed
    ? "Closed — read only. Internal notes can still be added."
    : "You do not have write access to this queue.";

  /** Read-only mode disables the inputs; `pending` disables them while a save is in flight. */
  const fieldsDisabled = pending || readOnly;

  const triggerButton =
    trigger === "icon" ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={className}
        onClick={() => setOpen(true)}
        title={readOnly ? disabledReason : "Edit ticket fields"}
        aria-label={readOnly ? `Ticket fields (read only) — ${disabledReason}` : "Edit ticket fields"}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-read-only={readOnly || undefined}
        // `e` from KeyboardShortcuts. Both triggers carry it because exactly one of them is
        // rendered per surface (icon on phones, labelled button at md+), so the shortcut finds one.
        data-shortcut="edit-ticket"
      >
        {readOnly ? <Eye aria-hidden /> : <Pencil aria-hidden />}
      </Button>
    ) : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
        title={readOnly ? disabledReason : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-read-only={readOnly || undefined}
        data-shortcut="edit-ticket"
      >
        {readOnly ? <Eye aria-hidden /> : <Pencil aria-hidden />}
        {readOnly ? "View fields" : "Edit fields"}
      </Button>
    );

  return (
    <>
      {triggerButton}

      <ResponsiveSheet
        open={open}
        onOpenChange={(o) => {
          if (!pending) setOpen(o);
        }}
        title={readOnly ? "Ticket fields" : "Edit ticket"}
        description={
          readOnly ? "Read only — nothing here can be changed." : "Changes are recorded field by field in the audit log."
        }
        size="lg"
        height="full"
      >
        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={pending || undefined}>
          <ResponsiveSheetBody className="flex flex-col gap-4">
            {/* The same notice the properties panel prints (properties-panel.tsx), reachable from the
                phone header, where that panel is not. Visible text, not a tooltip (R10). */}
            {readOnly ? (
              <div
                className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground"
                role="status"
                data-read-only-reason
              >
                <Lock aria-hidden className="size-4 shrink-0" />
                <span>{disabledReason}</span>
              </div>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.subject}>Subject</Label>
              <Input
                id={ids.subject}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
                minLength={3}
                maxLength={200}
                autoComplete="off"
                disabled={fieldsDisabled}
                aria-invalid={errors.subject ? true : undefined}
                aria-describedby={errors.subject ? errId("subject") : undefined}
              />
              <FieldError id={errId("subject")} messages={errors.subject} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.category}>Category</Label>
              <Select
                value={category}
                onValueChange={(v) => {
                  if ((TICKET_CATEGORIES as readonly string[]).includes(v)) setCategory(v as TicketCategory);
                }}
                disabled={fieldsDisabled}
              >
                <SelectTrigger id={ids.category} className="w-full" aria-invalid={errors.category ? true : undefined}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {TICKET_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError id={errId("category")} messages={errors.category} />
              <p className="text-xs text-muted-foreground">
                Changing the category does not move the ticket between queues — use Queue for that.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.requesterName}>Requester name</Label>
              <Input
                id={ids.requesterName}
                value={requesterName}
                onChange={(e) => setRequesterName(e.target.value)}
                required
                maxLength={120}
                autoComplete="off"
                disabled={fieldsDisabled}
                aria-invalid={errors.requesterName ? true : undefined}
                aria-describedby={errors.requesterName ? errId("requesterName") : undefined}
              />
              <FieldError id={errId("requesterName")} messages={errors.requesterName} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {/*
                An address already on the ticket is not a field edit: re-pointing it grants the new
                address every PUBLIC comment already on the thread and redirects every future reply, so
                it goes through the confirmed, reasoned step below. `readOnly` rather than `disabled` on
                purpose — the value stays selectable, copyable and announced by a screen reader.
              */}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.requesterEmail}>
                  Requester email <span className="font-normal text-muted-foreground">(or phone)</span>
                </Label>
                <Input
                  id={ids.requesterEmail}
                  type="email"
                  inputMode="email"
                  value={requesterEmail}
                  onChange={(e) => setRequesterEmail(e.target.value)}
                  autoComplete="off"
                  readOnly={addressIsPrivileged && !fieldsDisabled}
                  disabled={fieldsDisabled}
                  aria-invalid={errors.requesterEmail ? true : undefined}
                  aria-describedby={
                    errors.requesterEmail
                      ? errId("requesterEmail")
                      : addressIsPrivileged
                        ? `${ids.requesterEmail}-hint`
                        : undefined
                  }
                  className={addressIsPrivileged && !fieldsDisabled ? "bg-muted/50" : undefined}
                />
                <FieldError id={errId("requesterEmail")} messages={errors.requesterEmail} />
                {addressIsPrivileged ? (
                  <div className="flex flex-col gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 self-start md:min-h-9"
                      disabled={fieldsDisabled}
                      onClick={openRedirect}
                      aria-haspopup="dialog"
                      aria-expanded={redirectOpen}
                      data-change-requester-email
                    >
                      <MailWarning aria-hidden />
                      {hasStoredEmail ? "Change address" : "Add an address"}
                    </Button>
                    <p id={`${ids.requesterEmail}-hint`} className="text-xs text-muted-foreground">
                      {hasStoredEmail
                        ? "Changing this redirects every future reply and gives the new address the thread\u2019s history. It is recorded with a reason."
                        : "This ticket\u2019s address was removed earlier. Adding one gives that address every client-visible message already on the thread, so it goes through the same confirmed step and is recorded with a reason."}
                    </p>
                  </div>
                ) : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.requesterPhone}>Requester phone</Label>
                <Input
                  id={ids.requesterPhone}
                  type="tel"
                  inputMode="tel"
                  placeholder="+14155550123"
                  value={requesterPhone}
                  onChange={(e) => setRequesterPhone(e.target.value)}
                  autoComplete="off"
                  disabled={fieldsDisabled}
                  aria-invalid={errors.requesterPhone ? true : undefined}
                  aria-describedby={errors.requesterPhone ? errId("requesterPhone") : `${ids.requesterPhone}-hint`}
                />
                <FieldError id={errId("requesterPhone")} messages={errors.requesterPhone} />
                <p id={`${ids.requesterPhone}-hint`} className="text-xs text-muted-foreground">
                  E.164 — a leading + and the country code.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.brand}>Brand</Label>
              <Select
                value={brand}
                onValueChange={(v) => {
                  if ((TICKET_BRANDS as readonly string[]).includes(v)) setBrand(v as TicketBrand);
                }}
                disabled={fieldsDisabled}
              >
                <SelectTrigger id={ids.brand} className="w-full" aria-invalid={errors.brand ? true : undefined}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {TICKET_BRANDS.map((b) => (
                    <SelectItem key={b} value={b}>
                      {BRAND_LABELS[b]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError id={errId("brand")} messages={errors.brand} />
              <p className="text-xs text-muted-foreground">
                Decides which identity a reply to this client is sent from.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.externalRef}>
                External reference <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id={ids.externalRef}
                value={externalRef}
                onChange={(e) => setExternalRef(e.target.value)}
                maxLength={200}
                autoComplete="off"
                placeholder="E-signature envelope, ACAT control number…"
                disabled={fieldsDisabled}
                aria-invalid={errors.externalRef ? true : undefined}
                aria-describedby={errors.externalRef ? errId("externalRef") : `${ids.externalRef}-hint`}
              />
              <FieldError id={errId("externalRef")} messages={errors.externalRef} />
              <p id={`${ids.externalRef}-hint`} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldAlert aria-hidden className="size-3.5 shrink-0" />
                Numbers matching SSN, card or account-number formats are redacted before saving.
              </p>
            </div>
          </ResponsiveSheetBody>

          <ResponsiveSheetFooter>
            <Button
              type="button"
              variant={readOnly ? "outline" : "ghost"}
              className={readOnly ? "flex-1" : undefined}
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {/* No Save in read-only mode: the UI never offers a write the server would refuse. */}
            {readOnly ? null : (
              <Button type="submit" className="flex-1" disabled={pending}>
                {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
                {pending ? "Saving…" : "Save changes"}
              </Button>
            )}
          </ResponsiveSheetFooter>
        </form>
      </ResponsiveSheet>

      {/*
        Step two of the requester-address flow, and the app's only caller of `changeRequesterEmail`.

        A TOP-LEVEL `ResponsiveSheet`, deliberately: `openRedirect` closes the edit sheet in the same
        tick, so this is the ONE live layer rather than a second overlay on a 90 svh bottom sheet
        (docs/MOBILE_FIRST.md §4.5; `TicketActionDock` hoists `RecordContactSheet` the same way, and
        the §7 ticket-detail check counts sheet layers). Backing out re-opens the edit sheet with the
        form untouched; succeeding closes both.
      */}
      <ResponsiveSheet
        open={redirectOpen}
        onOpenChange={(o) => {
          if (o) setRedirectOpen(true);
          else closeRedirect();
        }}
        title="Change the requester address"
        description={
          <>
            Correspondence on this ticket currently goes to{" "}
            <span className="font-medium text-foreground">{storedEmail}</span>. The new address will
            receive every future reply and can read this ticket&rsquo;s history through the client app.
            Nothing is sent to either address.
          </>
        }
        size="lg"
        height="auto"
        showCloseButton={!redirectPending}
      >
        <form onSubmit={onRedirectSubmit} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={redirectPending || undefined}>
          <ResponsiveSheetBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.redirectEmail}>New requester email</Label>
              <Input
                id={ids.redirectEmail}
                type="email"
                inputMode="email"
                autoComplete="off"
                value={redirectEmail}
                onChange={(e) => setRedirectEmail(e.target.value)}
                disabled={redirectPending}
                aria-invalid={redirectErrors.requesterEmail ? true : undefined}
                aria-describedby={redirectErrors.requesterEmail ? `${ids.redirectEmail}-error` : undefined}
              />
              <FieldError id={`${ids.redirectEmail}-error`} messages={redirectErrors.requesterEmail} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.redirectReason}>Why is it changing?</Label>
              <Textarea
                id={ids.redirectReason}
                rows={3}
                value={redirectReason}
                onChange={(e) => setRedirectReason(e.target.value)}
                disabled={redirectPending}
                placeholder="Client confirmed the new address on a recorded call."
                aria-invalid={redirectErrors.reason ? true : undefined}
                aria-describedby={redirectErrors.reason ? `${ids.redirectReason}-error` : `${ids.redirectReason}-hint`}
              />
              <FieldError id={`${ids.redirectReason}-error`} messages={redirectErrors.reason} />
              <p id={`${ids.redirectReason}-hint`} className="text-xs text-muted-foreground">
                Recorded on the audit row with your name, the old address and the new one. Account and
                card numbers are redacted before it is stored.
              </p>
            </div>

            <FieldError id={`${ids.redirectEmail}-form-error`} messages={redirectErrors._form} />
          </ResponsiveSheetBody>

          <ResponsiveSheetFooter>
            <Button type="button" variant="ghost" className="min-h-11" onClick={closeRedirect} disabled={redirectPending}>
              Cancel
            </Button>
            <Button type="submit" className="ml-auto min-h-11" disabled={redirectPending}>
              {redirectPending ? <LoaderCircle aria-hidden className="animate-spin" /> : <MailWarning aria-hidden />}
              Change address
            </Button>
          </ResponsiveSheetFooter>
        </form>
      </ResponsiveSheet>

      {/* I13: a stale version token is never retried behind the operator's back. */}
      <AlertDialog open={conflict} onOpenChange={setConflict}>
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>This ticket changed while you were editing</AlertDialogTitle>
            <AlertDialogDescription>
              Someone else saved a change to this ticket, so nothing you typed was written. Reload to see
              their version, then make your edit again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setConflict(false);
                setOpen(false);
                router.refresh();
              }}
            >
              Reload the ticket
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
