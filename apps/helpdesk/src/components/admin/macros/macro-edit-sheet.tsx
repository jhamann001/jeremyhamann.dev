"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import type {
  ActionError,
  CommentVisibility,
  DisclaimerKey,
  MacroAdminInput,
  QueueKey,
  UpdateMacroInput,
} from "@/types/domain";
import { COMMENT_VISIBILITIES, DISCLAIMER_KEYS, QUEUE_KEYS, QUEUE_LABELS } from "@/types/domain";
import type { MacroAdminRow } from "@/server/macros";
import { createMacro, updateMacro } from "@/server/macros.actions";
import { DISCLAIMERS } from "@/lib/disclaimers";
import { macroVarsFor, renderMacroTemplate } from "@/lib/macro-template";
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
  CHANNEL_LABELS,
  MACRO_PLACEHOLDERS,
  PREVIEW_AGENT,
  PREVIEW_DATE,
  PREVIEW_TICKET,
  isMacroKey,
  keyFieldState,
  keyFromTitle,
  residualPlaceholders,
} from "@/components/admin/macros/macro-form-support";

/**
 * Create / edit a macro (R1–R12).
 *
 * One sheet serves both: a bottom sheet on phones, a 560 px side sheet from `md`. On EDIT only the
 * changed fields are sent, so `updateMacro` writes exactly one `MACRO_UPDATED` row per field that
 * actually moved and an untouched form is a no-op rather than a fake edit — the same discipline
 * `EditTicketSheet` applies to a ticket.
 *
 * The live preview is the point of the screen. A macro is wording a client reads, and the person
 * approving it (the CCO holds `macro:admin` for exactly this reason) should read it the way the
 * client will — placeholders filled in, against an obviously-fake sample ticket — not as a template
 * full of braces. Unresolved placeholders are called out under the preview because the renderer would
 * ship them verbatim.
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

const QUEUE_ANY = "__ANY__";

export type MacroEditSheetProps =
  | { mode: "create"; macro?: undefined; className?: string }
  | { mode: "edit"; macro: MacroAdminRow; className?: string };

export function MacroEditSheet(props: MacroEditSheetProps): React.JSX.Element {
  const { mode, className } = props;
  const macro = props.mode === "edit" ? props.macro : undefined;

  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const uid = useId();

  const [key, setKey] = useState(macro?.key ?? "");
  const [keyTouched, setKeyTouched] = useState(mode === "edit");
  const [title, setTitle] = useState(macro?.title ?? "");
  const [queueKey, setQueueKey] = useState<QueueKey | null>(macro?.queueKey ?? null);
  const [channel, setChannel] = useState<CommentVisibility>(macro?.channel ?? "PUBLIC");
  const [disclaimerKey, setDisclaimerKey] = useState<DisclaimerKey>(macro?.disclaimerKey ?? "GENERAL_SERVICE");
  const [sortOrder, setSortOrder] = useState(String(macro?.sortOrder ?? 0));
  const [body, setBody] = useState(macro?.body ?? "");
  const [errors, setErrors] = useState<FieldErrors>({});

  /**
   * Seed on the OPEN transition only. Re-seeding whenever the list refreshes would wipe what the
   * author is typing — and a macro body is the longest thing anybody types in this app.
   */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setKey(macro?.key ?? "");
      setKeyTouched(mode === "edit");
      setTitle(macro?.title ?? "");
      setQueueKey(macro?.queueKey ?? null);
      setChannel(macro?.channel ?? "PUBLIC");
      setDisclaimerKey(macro?.disclaimerKey ?? "GENERAL_SERVICE");
      setSortOrder(String(macro?.sortOrder ?? 0));
      setBody(macro?.body ?? "");
      setErrors({});
    }
    wasOpen.current = open;
    // Only the open transition seeds; the macro fields are read at that instant on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const ids = {
    key: `${uid}-key`,
    title: `${uid}-title`,
    queueKey: `${uid}-queue`,
    channel: `${uid}-channel`,
    disclaimerKey: `${uid}-disclaimer`,
    sortOrder: `${uid}-sort-order`,
    body: `${uid}-body`,
  };
  const errId = (k: keyof typeof ids): string => `${ids[k]}-error`;

  // On EDIT the key is read-only rather than disabled, so it stays legible, focusable and copyable —
  // it is the string the operator pastes into an audit-log filter. See `keyFieldState`.
  const keyField = keyFieldState(mode, pending);

  const preview = renderMacroTemplate(body, macroVarsFor(PREVIEW_TICKET, PREVIEW_AGENT, PREVIEW_DATE));
  const unresolved = residualPlaceholders(preview);
  const disclaimerText = DISCLAIMERS[disclaimerKey].text;

  /**
   * Channel and disclaimer move together, because the server refuses the incoherent pairs: a PUBLIC
   * macro must carry a disclaimer (a public reply cannot be sent without one) and an INTERNAL one
   * must not (an internal note has no disclaimer field to put it in).
   */
  function onChannelChange(next: CommentVisibility): void {
    setChannel(next);
    if (next === "INTERNAL") setDisclaimerKey("NONE");
    else if (disclaimerKey === "NONE") setDisclaimerKey("GENERAL_SERVICE");
  }

  function onTitleChange(next: string): void {
    setTitle(next);
    // Only until the author edits the key themselves, and never on an existing macro (the key is
    // immutable — it is the macro's identity in the ledger and in MACRO_SEED).
    if (mode === "create" && !keyTouched) setKey(keyFromTitle(next));
  }

  function applyError(err: ActionError): void {
    switch (err.code) {
      case "VALIDATION": {
        const fe = err.fieldErrors ?? {};
        setErrors(fe);
        toast.error(fe._form?.join(" ") ?? err.message);
        return;
      }
      case "CONFLICT":
        setErrors({ key: [err.message] });
        toast.error(err.message);
        return;
      case "FORBIDDEN":
        toast.error("You do not have permission to change macros.");
        return;
      case "NOT_FOUND":
        toast.error("That macro no longer exists — refreshing.");
        setOpen(false);
        router.refresh();
        return;
      case "UNAUTHORIZED":
        toast.error("Your session has ended. Sign in again.");
        router.refresh();
        return;
      case "INTERNAL":
        toast.error("The macro could not be saved. Nothing was changed.");
        return;
    }
  }

  /** Only the fields that actually differ. An empty object means there is nothing to save. */
  function buildPatch(current: MacroAdminRow): Omit<UpdateMacroInput, "macroId"> {
    const patch: Omit<UpdateMacroInput, "macroId"> = {};
    const nextTitle = title.trim();
    if (nextTitle !== current.title) patch.title = nextTitle;
    if (queueKey !== current.queueKey) patch.queueKey = queueKey;
    const nextBody = body.trim();
    if (nextBody !== current.body) patch.body = nextBody;
    if (channel !== current.channel) patch.channel = channel;
    if (disclaimerKey !== current.disclaimerKey) patch.disclaimerKey = disclaimerKey;
    const nextSort = Number(sortOrder);
    if (Number.isFinite(nextSort) && nextSort !== current.sortOrder) patch.sortOrder = nextSort;
    return patch;
  }

  function localErrors(): FieldErrors {
    const fe: FieldErrors = {};
    if (title.trim().length === 0) fe.title = ["A title is required."];
    if (body.trim().length === 0) fe.body = ["A body is required."];
    if (mode === "create" && !isMacroKey(key.trim())) {
      fe.key = ["Use lower-case words separated by hyphens, e.g. wire-verification-notice."];
    }
    const sort = Number(sortOrder);
    if (!Number.isInteger(sort) || sort < 0) fe.sortOrder = ["Use a whole number, 0 or greater."];
    if (unresolved.length > 0) {
      fe.body = [
        `${unresolved.join(", ")} would be sent to the client exactly as written. Use one of the placeholders listed above.`,
      ];
    }
    return fe;
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const fe = localErrors();
    setErrors(fe);
    if (Object.keys(fe).length > 0) {
      toast.error("Please correct the highlighted fields");
      return;
    }

    startTransition(async () => {
      if (mode === "create") {
        const input: MacroAdminInput = {
          key: key.trim(),
          title: title.trim(),
          queueKey,
          body: body.trim(),
          channel,
          disclaimerKey,
          sortOrder: Number(sortOrder),
        };
        const result = await createMacro(input);
        if (!result.ok) {
          applyError(result);
          return;
        }
        toast.success(`Macro “${input.title}” created`);
      } else {
        const patch = buildPatch(props.macro);
        if (Object.keys(patch).length === 0) {
          toast.info("Nothing changed");
          setOpen(false);
          return;
        }
        const result = await updateMacro({ macroId: props.macro.id, ...patch });
        if (!result.ok) {
          applyError(result);
          return;
        }
        toast.success(`Macro “${title.trim()}” updated`);
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant={mode === "create" ? "default" : "outline"}
        size={mode === "create" ? "default" : "sm"}
        className={className}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={mode === "create" ? "New macro" : `Edit ${macro?.title ?? "macro"}`}
      >
        {mode === "create" ? <Plus aria-hidden /> : <Pencil aria-hidden />}
        {mode === "create" ? "New macro" : "Edit"}
      </Button>

      <ResponsiveSheet
        open={open}
        onOpenChange={(o) => {
          if (!pending) setOpen(o);
        }}
        title={mode === "create" ? "New macro" : "Edit macro"}
        description={
          mode === "create"
            ? "Macros are firm-approved wording. Creating one is recorded in the audit log."
            : "Every changed field is recorded in the audit log, with the previous body."
        }
        size="lg"
        height="full"
      >
        <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={pending || undefined}>
          <ResponsiveSheetBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.title}>Title</Label>
              <Input
                id={ids.title}
                value={title}
                onChange={(e) => onTitleChange(e.target.value)}
                required
                maxLength={120}
                autoComplete="off"
                disabled={pending}
                aria-invalid={errors.title ? true : undefined}
                aria-describedby={errors.title ? errId("title") : undefined}
              />
              <p className="text-xs text-muted-foreground">What staff see in the composer&rsquo;s macro picker.</p>
              <FieldError id={errId("title")} messages={errors.title} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.key}>Key</Label>
              <Input
                id={ids.key}
                value={key}
                onChange={(e) => {
                  setKeyTouched(true);
                  setKey(e.target.value);
                }}
                required
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                disabled={keyField.disabled}
                readOnly={keyField.readOnly}
                aria-readonly={keyField.ariaReadOnly}
                className={keyField.className}
                aria-invalid={errors.key ? true : undefined}
                aria-describedby={errors.key ? errId("key") : undefined}
              />
              <p className="text-xs text-muted-foreground">
                {mode === "edit"
                  ? "The key never changes — it is how this macro is identified in the audit log. Retire it and create a replacement instead."
                  : "Lower-case words separated by hyphens. It cannot be changed afterwards."}
              </p>
              <FieldError id={errId("key")} messages={errors.key} />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.channel}>Channel</Label>
                <Select
                  value={channel}
                  onValueChange={(v) => {
                    if ((COMMENT_VISIBILITIES as readonly string[]).includes(v)) onChannelChange(v as CommentVisibility);
                  }}
                  disabled={pending}
                >
                  <SelectTrigger id={ids.channel} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    {COMMENT_VISIBILITIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {CHANNEL_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Public reply macros are offered only to staff who can reply to the client.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.queueKey}>Queue</Label>
                <Select
                  value={queueKey ?? QUEUE_ANY}
                  onValueChange={(v) => {
                    if (v === QUEUE_ANY) setQueueKey(null);
                    else if ((QUEUE_KEYS as readonly string[]).includes(v)) setQueueKey(v as QueueKey);
                  }}
                  disabled={pending}
                >
                  <SelectTrigger id={ids.queueKey} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    <SelectItem value={QUEUE_ANY}>All queues</SelectItem>
                    {QUEUE_KEYS.map((q) => (
                      <SelectItem key={q} value={q}>
                        {QUEUE_LABELS[q]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.disclaimerKey}>Disclaimer</Label>
                <Select
                  value={disclaimerKey}
                  onValueChange={(v) => {
                    if ((DISCLAIMER_KEYS as readonly string[]).includes(v)) setDisclaimerKey(v as DisclaimerKey);
                  }}
                  disabled={pending || channel === "INTERNAL"}
                >
                  <SelectTrigger
                    id={ids.disclaimerKey}
                    className="w-full"
                    aria-invalid={errors.disclaimerKey ? true : undefined}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper" align="start">
                    {DISCLAIMER_KEYS.filter((k) => (channel === "INTERNAL" ? k === "NONE" : k !== "NONE")).map((k) => (
                      <SelectItem key={k} value={k}>
                        {DISCLAIMERS[k].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError id={errId("disclaimerKey")} messages={errors.disclaimerKey} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.sortOrder}>Order</Label>
                <Input
                  id={ids.sortOrder}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={10}
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value)}
                  disabled={pending}
                  aria-invalid={errors.sortOrder ? true : undefined}
                  aria-describedby={errors.sortOrder ? errId("sortOrder") : undefined}
                />
                <p className="text-xs text-muted-foreground">Lower numbers appear first in the picker.</p>
                <FieldError id={errId("sortOrder")} messages={errors.sortOrder} />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.body}>Body</Label>
              <Textarea
                id={ids.body}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                required
                rows={10}
                maxLength={20000}
                disabled={pending}
                className="min-h-48 font-mono text-base md:text-sm"
                aria-invalid={errors.body ? true : undefined}
                aria-describedby={errors.body ? errId("body") : undefined}
              />
              <FieldError id={errId("body")} messages={errors.body} />
              <div className="rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">Placeholders</p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {MACRO_PLACEHOLDERS.map((p) => (
                    <li key={p.token}>
                      <code className="font-mono">{p.token}</code> — {p.describes}
                    </li>
                  ))}
                </ul>
                <p className="mt-1">Anything else is sent to the client exactly as you type it.</p>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium">Preview</p>
              <p className="text-xs text-muted-foreground">
                Rendered against a sample ticket (HD-{PREVIEW_TICKET.number}, {PREVIEW_TICKET.requesterName}). No real
                client data is used.
              </p>
              <div
                className="rounded-md border bg-card p-3 text-sm whitespace-pre-wrap text-card-foreground"
                data-macro-preview
              >
                {preview.length > 0 ? preview : <span className="text-muted-foreground">Nothing to preview yet.</span>}
              </div>
              {unresolved.length > 0 ? (
                <p className="text-xs text-destructive" role="alert">
                  {unresolved.join(", ")} will not be filled in — the client would read it exactly as written.
                </p>
              ) : null}
              {channel === "PUBLIC" && disclaimerText.length > 0 ? (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Appended on send — {DISCLAIMERS[disclaimerKey].label}</p>
                  <p className="mt-1">{disclaimerText}</p>
                </div>
              ) : null}
            </div>
          </ResponsiveSheetBody>

          <ResponsiveSheetFooter>
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={pending} aria-busy={pending || undefined}>
              {pending ? "Saving…" : mode === "create" ? "Create macro" : "Save changes"}
            </Button>
          </ResponsiveSheetFooter>
        </form>
      </ResponsiveSheet>
    </>
  );
}
