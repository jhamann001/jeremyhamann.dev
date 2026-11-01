"use client";

import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  CheckCheck,
  CloudOff,
  Eye,
  Info,
  Loader2,
  Lock,
  MailWarning,
  Pencil,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type {
  ActionResult,
  CommentActionResult,
  CommentVisibility,
  DisclaimerKey,
  MacroActions,
  MacroDTO,
  TicketDetailDTO,
  Viewer,
} from "@/types/domain";
import { appendDisclaimer } from "@/lib/disclaimers";
import { macroVarsFor } from "@/lib/macro-template";
import { canWriteQueue } from "@/lib/rbac";
import { DEFAULT_DISCLAIMER_BY_CATEGORY } from "@/lib/routing";
import { canTransition } from "@/lib/ticket-policy";
import { cn } from "@/lib/utils";
import { addInternalNote, addPublicReply, addPublicReplyAndSetPending } from "@/server/comments.actions";
import { deleteDraft, loadComposerState, saveDraft } from "@/server/drafts.actions";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  INTERNAL_BADGE_CLASSES,
  INTERNAL_NOTE_CLASSES,
  INTERNAL_NOTE_LABEL,
  PUBLIC_REPLY_LABEL,
} from "@/components/tickets/internal-note-styles";
import { AiDraftButton } from "@/components/ticket/ai-draft-button";
import {
  EMPTY_DRAFT,
  EMPTY_SYNC,
  draftStatusLabel,
  hasUnsavedChanges,
  useComposerStore,
  type ComposerChannel,
} from "@/components/ticket/composer-store";
import { DisclaimerPreview } from "@/components/ticket/disclaimer-preview";
import { describeMacroActions } from "@/components/admin/macros/macro-form-support";
import { MacroPicker } from "@/components/ticket/macro-picker";
import { MarkdownRenderer } from "@/components/ticket/markdown-renderer";
import { demoTextMax } from "@/lib/demo/mode";

/**
 * Dual-channel composer.
 *
 * Two tabs, two server actions, two drafts: the channel is decided by which action is called, never by
 * a field the client controls. The public pane previews `appendDisclaimer(draft, key)` — exactly the
 * text `addPublicReply` stores — and requires the acknowledgement checkbox plus an AlertDialog confirm.
 * Every result ends in `router.refresh()`, which re-renders the page as a new audited view.
 *
 * Wave A copy rule (binding): **nothing here says "sent"**. Saving a
 * reply writes the record and QUEUES a delivery; whether it actually left the building is the chip on
 * the comment, which only reads Sent once a sender has reported a result. Hence "Save reply to ticket"
 * and "Save reply and set Pending client" — the second sets the status in the SAME transaction as the
 * comment, audited as an ordinary TICKET_STATUS_CHANGED.
 *
 * Fix round 2, two copy/affordance corrections, both R10 ("nothing that matters is tooltip-only"):
 *  - **Delivery is claimed only when there is somewhere to deliver.** A phone-only ticket
 *    has no `requesterEmail`, so `writePublicReply` enqueues nothing AND the client API — which
 *    authorizes on that exact column — can never serve the thread either. The reply is a desk record and
 *    nothing more. The confirm dialog used to promise delivery unconditionally and a toast retracted it
 *    *after* an immutable comment was written (I2/I8); now the Public pane says so before a word is
 *    typed and the dialog says so again at the point of no return.
 *  - **A disabled channel explains itself in visible text**, under the TabsList, the way
 *    `release-intake-dialog.tsx` and `user-active-dialog.tsx` do. A disabled `TabsTrigger` gets no
 *    hover events on a desktop and no hover at all on a phone, so the old tooltip told nobody anything.
 *
 * Mobile-first pass: draft text and macro ids live in `useComposerStore` (keyed by ticket id) so a
 * phone sheet dismissed by an overlay brush keeps the half-written reply; `layout="sheet"` renders
 * inside the dock's 90 svh bottom sheet with a sticky, thumb-reachable submit row; `initialChannel`
 * seeds the tab (only when that channel is permitted); `onSubmitted` lets the dock close the sheet
 * after the success toasts and before the single `router.refresh()`.
 *
 * --- Wave B ---
 *
 * **Drafts are now durable.** The in-memory store still owns the keystroke-to-keystroke state, and it
 * is still memory-only (no `persist`, no browser storage — MOBILE_FIRST §7's guardrail stands). What
 * changed is that it is backed by a `ComposerDraft` row per (ticket, user, channel): `loadComposerState`
 * restores on mount, a debounced `saveDraft` writes on idle and on blur, the indicator says which of
 * the three states the channel is in, Discard deletes the row, and submitting clears it inside the
 * comment's own transaction. A half-written reply now survives a closed tab and a different device,
 * which `localStorage` would not have done and which is the whole point.
 *
 * **The disclaimer is stored with the draft and deliberately NOT restored.** MOBILE_FIRST §4.5 makes
 * the disclaimer and the acknowledgement a per-send confirmation that resets with the component, and
 * that is a compliance decision rather than a convenience: resuming a session with a disclaimer
 * already chosen is resuming half of an approval nobody re-gave. The column records what was selected
 * when the draft was written; the checkbox starts empty every time.
 *
 * **The AI draft control** appears only when the server says the seam is configured (G1: the flag is
 * resolved in `loadComposerState`, never by importing `@/lib/env` here). It fills this textarea and
 * nothing else.
 *
 * **Capabilities are published to the store** so `CommentItem` can offer the withdraw control on a
 * public reply. The timeline hands a comment row a DTO and no viewer, and the page that mounts both is
 * foundation-owned; this component has `viewer` and `ticket`, so it computes `canWriteQueue` once and
 * publishes it. The server re-checks on every retraction regardless.
 */

// Shorter in the public demo (src/lib/demo/mode.ts), as the server's schemas are.
const BODY_MAX = demoTextMax(20_000);
const REDACTION_NOTE = "Numbers matching SSN, card or account-number formats are redacted before saving.";

/** How long the operator has to stop typing before the draft is written. */
const AUTOSAVE_IDLE_MS = 1_200;

type Channel = "internal" | "public";
type Layout = "inline" | "sheet";

/** Shared with `TicketActionDock` so a disabled dock item explains itself with the composer's own words. */
export function publicReplyDisabledReason(closed: boolean): string {
  return closed
    ? "This ticket is closed — public replies are disabled. Internal notes remain available."
    : "Replying to the client requires write access to this queue.";
}

export function internalNoteDisabledReason(): string {
  return "Internal notes require read access to this queue.";
}

function isPermitted(p: TicketDetailDTO["permissions"], channel: Channel): boolean {
  return channel === "internal" ? p.canInternalNote : p.canPublicReply;
}

function defaultChannel(p: TicketDetailDTO["permissions"]): Channel {
  if (p.canInternalNote) return "internal";
  if (p.canPublicReply) return "public";
  return "internal";
}

function appendBody(prev: string, body: string): string {
  return prev.trim().length === 0 ? body : `${prev.trimEnd()}\n\n${body}`;
}

/** `ComposerChannel` → the `CommentVisibility` the server actions take. */
function visibilityOf(channel: ComposerChannel): CommentVisibility {
  return channel === "public" ? "PUBLIC" : "INTERNAL";
}

/**
 * Tab trigger. A disabled one carries `title` for a pointer and `aria-describedby` pointing at the
 * VISIBLE reason rendered under the TabsList — never a tooltip, which a disabled control cannot fire
 * and a phone cannot summon (same shape as the two admin dialogs).
 */
function ChannelTab({
  value,
  disabled,
  reason,
  reasonId,
  children,
}: {
  value: Channel;
  disabled: boolean;
  reason: string;
  /** Id of the visible <p> that states `reason`; only wired while `disabled`. */
  reasonId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <TabsTrigger
      value={value}
      disabled={disabled}
      className="gap-1.5 px-3"
      data-channel={value}
      // `r` and `n` from KeyboardShortcuts: the key focuses the tab that opens the right
      // composer. It never submits anything — opening a composer is the whole action.
      data-shortcut={value === "public" ? "reply" : "internal-note"}
      title={disabled ? reason : undefined}
      aria-describedby={disabled ? reasonId : undefined}
    >
      {children}
    </TabsTrigger>
  );
}

/**
 * Submit row. Inline: right-aligned inside the channel frame. Sheet: sticks to the bottom of the
 * scrolling sheet body (thumb-reachable however long the draft), padded for the home indicator.
 * The -mx-4 cancels ResponsiveSheetBody's px-4 so the bar spans the sheet edge to edge.
 */
function SubmitRow({ layout, children }: { layout: Layout; children: React.ReactNode }): React.JSX.Element {
  if (layout === "sheet") {
    return (
      <div
        className="sticky bottom-0 z-10 -mx-4 mt-2 border-t bg-popover px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]"
        data-slot="composer-submit"
      >
        {children}
      </div>
    );
  }
  return <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>;
}

/**
 * The draft state line, and the Discard control beside it.
 *
 * R10: this is visible text, not a tooltip and not an icon alone. "Is my work safe" is exactly the
 * question an operator should never have to hover to answer, and the icon is decorative — the words
 * carry the meaning.
 */
function DraftStatus({
  label,
  state,
  onDiscard,
  discardable,
  disabled,
}: {
  label: string | null;
  state: "saving" | "saved" | "unsaved" | "error" | "none";
  onDiscard: () => void;
  discardable: boolean;
  disabled: boolean;
}): React.JSX.Element | null {
  if (label === null && !discardable) return null;
  const Icon = state === "saving" ? Loader2 : state === "error" ? CloudOff : state === "saved" ? CheckCheck : Save;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-slot="draft-status" data-state={state}>
      {label !== null ? (
        <p
          className={cn("flex items-center gap-1.5 text-xs", state === "error" ? "text-destructive" : "text-muted-foreground")}
          role="status"
          aria-live="polite"
        >
          <Icon aria-hidden className={cn("size-3.5 shrink-0", state === "saving" && "animate-spin")} />
          <span>{label}</span>
        </p>
      ) : (
        <span />
      )}
      {discardable ? (
        // `data-control`, not `data-slot`: see the note on the withdraw control in comment-item.tsx —
        // overriding `data-slot` takes the control out of globals.css's 44 px phone rule, and this one
        // discards written work at 24 px tall.
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onDiscard}
          disabled={disabled}
          data-control="discard-draft"
          className="min-h-11 md:min-h-0"
        >
          <Trash2 aria-hidden />
          Discard draft
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A macro as the composer needs it: the `MacroDTO` the picker already renders, plus the structured
 * side effects `listMacros` now reads alongside it.
 *
 * Fix round 1. `actions` is OPTIONAL on purpose. `MacroDTO` lives in the foundation-owned
 * `src/types/domain.ts`, which this slice may not edit, so the field is
 * added here instead; optional keeps a plain `MacroDTO[]` assignable, which is what lets
 * `ticket-action-dock.tsx` and the ticket page pass their arrays through unchanged. An absent `actions`
 * and a `null` one mean the same thing to `describeMacroActions` — "insert the body only" — so a caller
 * that does not carry the field degrades to today's behaviour rather than to a wrong claim.
 */
export type ComposerMacro = MacroDTO & { actions?: MacroActions | null };

/**
 * What the inserted macro will do to the TICKET, in the macro form's own words.
 *
 * Fix round 1. Macro actions apply atomically on submit and the mechanism was right,
 * but the operator was never told: a macro carrying `{"status": "PENDING_CLIENT"}` moved the ticket
 * OPEN → PENDING_CLIENT on confirm while nothing in the composer or the confirm dialog mentioned a
 * status change. `describeMacroActions` already produces these sentences for `/admin/macros` under a
 * "What this will change" heading; the same sentences belong here, where the change is committed.
 *
 * Pure helper, imported rather than duplicated so the two screens cannot describe one macro two ways.
 * Renders nothing when the macro has no actions, which is the common case.
 */
function MacroEffects({ actions }: { actions: MacroActions | null }): React.JSX.Element | null {
  const lines = describeMacroActions(actions);
  if (lines.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-1 rounded-md border border-dashed px-3 py-2 text-xs"
      data-control="macro-effects"
      role="status"
    >
      <p className="font-semibold">What this will change when you submit</p>
      <ul className="list-disc pl-4 text-muted-foreground">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export function Composer({
  ticket,
  macros,
  viewer,
  initialChannel,
  layout = "inline",
  onSubmitted,
}: {
  ticket: TicketDetailDTO;
  macros: ComposerMacro[];
  viewer: Viewer;
  /** Seeds the tab; ignored when that channel is not permitted (falls back to the first permitted one). */
  initialChannel?: Channel;
  /** "sheet" = inside the phone dock's bottom sheet (full-width tabs, taller textareas, sticky submit). */
  layout?: Layout;
  /** Fires after a successful send, after the toasts and before `router.refresh()`. */
  onSubmitted?: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const ids = { internal: useId(), public: useId(), ack: useId(), channelReason: useId(), noAddress: useId() };
  const { permissions } = ticket;
  const closed = ticket.status === "CLOSED";
  const sheet = layout === "sheet";

  const [channel, setChannel] = useState<Channel>(() =>
    initialChannel !== undefined && isPermitted(permissions, initialChannel) ? initialChannel : defaultChannel(permissions),
  );

  // Drafts (memory store for the live text, a ComposerDraft row for durability; D4 + Wave B B3).
  const draft = useComposerStore((s) => s.drafts[ticket.id]) ?? EMPTY_DRAFT;
  const sync = useComposerStore((s) => s.sync[ticket.id]) ?? EMPTY_SYNC;
  const setDraft = useComposerStore((s) => s.setDraft);
  const clearDraft = useComposerStore((s) => s.clearDraft);
  const hydrate = useComposerStore((s) => s.hydrate);
  const setSync = useComposerStore((s) => s.setSync);
  const setCapabilities = useComposerStore((s) => s.setCapabilities);
  const noteBody = draft.note;
  const replyBody = draft.reply;

  // Fix round 1. The side effects of the macro currently inserted into each channel,
  // so the panes and the reply confirmation can NAME the ticket mutation they are about to commit.
  // Null whenever no macro is inserted or the inserted one only pastes text, which is the common case.
  const replyMacroActions = macros.find((m) => m.id === draft.replyMacroId)?.actions ?? null;
  const noteMacroActions = macros.find((m) => m.id === draft.noteMacroId)?.actions ?? null;
  const replyMacroEffects = describeMacroActions(replyMacroActions);

  const [aiEnabled, setAiEnabled] = useState(false);

  // Per-send confirmation state — deliberately local, resets with the component.
  const [disclaimerKey, setDisclaimerKey] = useState<DisclaimerKey>(DEFAULT_DISCLAIMER_BY_CATEGORY[ticket.category]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmIntent, setConfirmIntent] = useState<"save" | "pending">("save");

  const nothingAllowed = !permissions.canInternalNote && !permissions.canPublicReply;
  const publicDisabledReason = publicReplyDisabledReason(closed);
  const internalDisabledReason = internalNoteDisabledReason();

  const ticketId = ticket.id;

  /**
   * One capability, published once, for `CommentItem`'s withdraw control. `canWriteQueue` is the same
   * predicate `retractComment` re-checks on the server, so the control is offered on exactly the fact
   * that authorises it — and being wrong here costs an error toast, never an unauthorised write.
   */
  const canRetract = canWriteQueue(viewer.groups, ticket.queueKey);
  useEffect(() => {
    setCapabilities(ticketId, { canRetract });
  }, [ticketId, canRetract, setCapabilities]);

  /**
   * Restore on open. Runs once per ticket, guarded on `hydrated` so the inline composer and the
   * phone sheet (both mounted on a phone-sized viewport) do not each fetch and each overwrite.
   */
  const hydrating = useRef(false);
  useEffect(() => {
    if (sync.hydrated || hydrating.current) return;
    hydrating.current = true;
    void loadComposerState({ ticketId }).then((result) => {
      hydrating.current = false;
      if (!result.ok) {
        // A failed restore is not an error the operator can act on: the composer still works and the
        // next save creates the row. Mark it hydrated anyway, so autosave is allowed to start — the
        // guard exists to stop an empty body overwriting a draft that has not arrived, and after a
        // failure none is coming.
        hydrate(ticketId, {});
        return;
      }
      setAiEnabled(result.data.aiEnabled);
      const internal = result.data.drafts.find((d) => d.channel === "INTERNAL");
      const publicDraft = result.data.drafts.find((d) => d.channel === "PUBLIC");
      hydrate(ticketId, {
        ...(internal ? { note: { body: internal.body, macroId: internal.macroId, savedAt: internal.updatedAt } } : {}),
        ...(publicDraft
          ? { reply: { body: publicDraft.body, macroId: publicDraft.macroId, savedAt: publicDraft.updatedAt } }
          : {}),
      });
    });
  }, [ticketId, sync.hydrated, hydrate]);

  /**
   * Writes one channel's draft. Returns a promise so `flush` can be awaited on blur.
   *
   * Never runs before hydration: saving an empty body over a stored draft the restore has not yet
   * delivered is the one way this feature could destroy the text it exists to protect.
   */
  const writeDraft = useCallback(
    async (target: ComposerChannel, body: string, macroId: string | null): Promise<void> => {
      if (!useComposerStore.getState().sync[ticketId]?.hydrated) return;
      setSync(ticketId, target, { status: "saving", error: null });
      const result = await saveDraft({
        ticketId,
        channel: visibilityOf(target),
        body,
        macroId,
        ...(target === "public" ? { disclaimerKey } : {}),
      });
      if (!result.ok) {
        setSync(ticketId, target, {
          status: "error",
          error: result.code === "UNAUTHORIZED" ? "Signed out — draft not saved" : "Draft not saved",
        });
        return;
      }
      if (result.data.redacted) {
        toast.warning(
          `Sensitive numbers were redacted in the saved draft (${result.data.redactionCount}). They are removed on save too.`,
        );
      }
      setSync(ticketId, target, {
        savedBody: body,
        savedAt: result.data.updatedAt,
        status: "saved",
        error: null,
      });
    },
    [ticketId, disclaimerKey, setSync],
  );

  // Debounced autosave, one timer per channel. No interval, nothing polling: the timer is armed by a
  // change and disarmed by the next one or by unmount.
  const timers = useRef<Record<ComposerChannel, ReturnType<typeof setTimeout> | null>>({
    internal: null,
    public: null,
  });

  const schedule = useCallback(
    (target: ComposerChannel, body: string, macroId: string | null) => {
      const handle = timers.current[target];
      if (handle !== null) clearTimeout(handle);
      timers.current[target] = setTimeout(() => {
        timers.current[target] = null;
        void writeDraft(target, body, macroId);
      }, AUTOSAVE_IDLE_MS);
    },
    [writeDraft],
  );

  /** Saves now (blur, or leaving the tab) rather than waiting out the idle window. */
  const flush = useCallback(
    (target: ComposerChannel) => {
      const handle = timers.current[target];
      if (handle === null) return;
      clearTimeout(handle);
      timers.current[target] = null;
      const current = useComposerStore.getState().drafts[ticketId] ?? EMPTY_DRAFT;
      const body = target === "internal" ? current.note : current.reply;
      const macroId = target === "internal" ? current.noteMacroId : current.replyMacroId;
      void writeDraft(target, body, macroId);
    },
    [ticketId, writeDraft],
  );

  useEffect(() => {
    const handles = timers.current;
    return () => {
      for (const key of ["internal", "public"] as const) {
        const handle = handles[key];
        if (handle !== null) clearTimeout(handle);
      }
    };
  }, []);

  /**
   * Mirrors `writePublicReply`'s own test (`forDelivery?.requesterEmail?.trim()`, src/server/
   * comments.actions.ts): no address ⇒ no `MessageDelivery` row is enqueued. The same column is the
   * client API's authorization subject (`getClientTicketView` refuses a null outright), so on a
   * phone-only ticket the reply is not emailed AND not readable in the client app. Both halves are
   * stated up front rather than in a toast after the record is written.
   */
  const canDeliverToClient = (ticket.requesterEmail ?? "").trim().length > 0;

  /**
   * At most one channel is ever disabled here: both disabled returns the read-only card below. The
   * reason is rendered as a visible line under the TabsList, not as a tooltip.
   */
  const channelDisabledReason = !permissions.canInternalNote
    ? internalDisabledReason
    : !permissions.canPublicReply
      ? publicDisabledReason
      : null;

  function macroVars() {
    return macroVarsFor({ number: ticket.number, requesterName: ticket.requesterName }, viewer.name);
  }

  function handleResult<T extends CommentActionResult>(
    result: ActionResult<T>,
    successMessage: string,
    onSuccess: (data: T) => void,
  ): void {
    if (result.ok) {
      toast.success(successMessage);
      if (result.data.piiRedacted) toast.warning("Sensitive numbers were redacted before saving");
      if (result.data.firstResponseStamped) toast("First response recorded");
      onSuccess(result.data);
      onSubmitted?.();
      router.refresh();
      return;
    }
    switch (result.code) {
      case "CONFLICT":
        toast.warning("Ticket changed elsewhere — refreshing");
        router.refresh();
        return;
      case "FORBIDDEN":
        toast.error(result.message);
        return;
      case "VALIDATION": {
        const detail = result.fieldErrors ? Object.values(result.fieldErrors).flat()[0] : undefined;
        toast.error(detail ? `${result.message}: ${detail}` : result.message);
        return;
      }
      case "UNAUTHORIZED":
        toast.error("Your session has ended. Sign in again.");
        router.refresh();
        return;
      case "NOT_FOUND":
        toast.error("Ticket not found");
        router.refresh();
        return;
      case "INTERNAL":
        toast.error("The comment could not be saved. Nothing was changed.");
        return;
    }
  }

  /** A submit makes any pending autosave pointless — the comment's transaction deletes the row. */
  function cancelAutosave(target: ComposerChannel): void {
    const handle = timers.current[target];
    if (handle !== null) clearTimeout(handle);
    timers.current[target] = null;
  }

  function discard(target: ComposerChannel): void {
    cancelAutosave(target);
    startTransition(async () => {
      const result = await deleteDraft({ ticketId, channel: visibilityOf(target) });
      if (!result.ok) {
        toast.error("The draft could not be discarded.");
        return;
      }
      clearDraft(ticketId, target);
      if (target === "public") {
        setAcknowledged(false);
        setMode("write");
      }
      toast.success("Draft discarded");
    });
  }

  function submitInternal(): void {
    const body = noteBody.trim();
    if (body.length === 0) return;
    const macroId = draft.noteMacroId;
    cancelAutosave("internal");
    startTransition(async () => {
      const result = await addInternalNote({ ticketId: ticket.id, body, ...(macroId ? { macroId } : {}) });
      handleResult(result, "Internal note added", () => clearDraft(ticket.id, "internal"));
    });
  }

  /**
   * `setPending` picks the action, not a flag on one action: "and set Pending client" moves the ticket
   * in the same transaction as the comment and therefore takes the version token, which the plain reply
   * deliberately does not.
   */
  function submitPublic(setPending: boolean): void {
    const body = replyBody.trim();
    if (body.length === 0 || disclaimerKey === "NONE" || !acknowledged) return;
    const macroId = draft.replyMacroId;
    cancelAutosave("public");
    const base = {
      ticketId: ticket.id,
      body,
      ...(macroId ? { macroId } : {}),
      disclaimerKey,
      disclaimerAcknowledged: true as const,
    };
    startTransition(async () => {
      const result = setPending
        ? await addPublicReplyAndSetPending({ ...base, version: ticket.version })
        : await addPublicReply(base);
      const saved = setPending ? "Reply saved — ticket set to Pending client" : "Reply saved to the ticket";
      handleResult(result, saved, (data) => {
        toast(
          data.deliveryQueued
            ? "Queued for delivery to the client"
            : "No email address on file — this reply was recorded but will not be emailed",
        );
        clearDraft(ticket.id, "public");
        setAcknowledged(false);
        setMode("write");
      });
    });
  }

  const replyReady = replyBody.trim().length > 0 && disclaimerKey !== "NONE" && acknowledged;
  const storedPreview = appendDisclaimer(replyBody, disclaimerKey);

  // The second button appears only when the state machine allows it (PENDING_INTERNAL and RESOLVED do
  // not reach PENDING_CLIENT, and a ticket already Pending client has nowhere to go). The server
  // re-checks: the button is convenience, never the gate.
  const canSetPending = canTransition(ticket.status, "PENDING_CLIENT");

  function openConfirm(intent: "save" | "pending"): void {
    setConfirmIntent(intent);
    setDraft(ticket.id, { replySetsPending: intent === "pending" });
    setConfirmOpen(true);
  }

  function statusStateFor(body: string, channelSync: typeof sync.internal): "saving" | "saved" | "unsaved" | "error" | "none" {
    if (channelSync.status === "error") return "error";
    if (channelSync.status === "saving") return "saving";
    if (hasUnsavedChanges(body, channelSync)) return body.trim().length === 0 ? "none" : "unsaved";
    return channelSync.savedAt !== null && channelSync.savedBody.trim().length > 0 ? "saved" : "none";
  }

  const replyButtons = (
    <>
      <Button
        type="button"
        size={sheet ? "default" : "sm"}
        className={sheet ? "w-full" : undefined}
        onClick={() => openConfirm("save")}
        disabled={pending || !replyReady}
        data-intent="save"
      >
        <Save aria-hidden />
        Save reply to ticket
      </Button>
      {canSetPending ? (
        <Button
          type="button"
          variant="outline"
          size={sheet ? "default" : "sm"}
          className={sheet ? "w-full" : undefined}
          onClick={() => openConfirm("pending")}
          disabled={pending || !replyReady}
          data-intent="pending"
        >
          <CalendarClock aria-hidden />
          Save reply and set Pending client
        </Button>
      ) : null}
    </>
  );

  if (nothingAllowed) {
    return (
      <section aria-label="Composer" className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
        You can read this ticket but cannot comment on it.
      </section>
    );
  }

  return (
    <section aria-label="Composer" className="flex flex-col gap-2" data-slot="composer" data-layout={layout}>
      <Tabs
        value={channel}
        onValueChange={(v) => {
          // Leaving a tab is the same commitment point as leaving the field: write what is there
          // rather than relying on the operator coming back before the idle window elapses.
          flush(channel === "public" ? "public" : "internal");
          setChannel(v === "public" ? "public" : "internal");
        }}
      >
        <TabsList className={sheet ? "w-full" : "w-full sm:w-fit"}>
          <ChannelTab
            value="internal"
            disabled={!permissions.canInternalNote}
            reason={internalDisabledReason}
            reasonId={ids.channelReason}
          >
            <Lock aria-hidden />
            Internal note
          </ChannelTab>
          <ChannelTab
            value="public"
            disabled={!permissions.canPublicReply}
            reason={publicDisabledReason}
            reasonId={ids.channelReason}
          >
            <Send aria-hidden />
            Public reply
          </ChannelTab>
        </TabsList>

        {/*
          R10: the greyed tab's reason as visible text. Compliance on any ticket, and everyone on a
          CLOSED one, used to see a dead tab and be told nothing — the tooltip could not fire on a
          disabled trigger and a phone has no hover. Same treatment as release-intake-dialog.tsx.
        */}
        {channelDisabledReason !== null ? (
          <p
            id={ids.channelReason}
            data-slot="channel-disabled-reason"
            className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground"
          >
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span>{channelDisabledReason}</span>
          </p>
        ) : null}

        {/* ---------------------------------------------------------------- Internal note */}
        <TabsContent value="internal">
          <div className={cn("flex flex-col gap-2 rounded-lg border p-3", INTERNAL_NOTE_CLASSES)} data-channel="INTERNAL">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge className={cn("gap-1", INTERNAL_BADGE_CLASSES)}>
                <Lock aria-hidden />
                {INTERNAL_NOTE_LABEL}
              </Badge>
              <MacroPicker
                macros={macros}
                channel="INTERNAL"
                vars={macroVars()}
                disabled={pending}
                onInsert={(r) => {
                  const current = useComposerStore.getState().drafts[ticket.id] ?? EMPTY_DRAFT;
                  const next = appendBody(current.note, r.body);
                  setDraft(ticket.id, { note: next, noteMacroId: r.macroId });
                  schedule("internal", next, r.macroId);
                }}
              />
            </div>
            <MacroEffects actions={noteMacroActions} />
            <Label htmlFor={ids.internal} className="sr-only">
              Internal note
            </Label>
            <Textarea
              id={ids.internal}
              value={noteBody}
              onChange={(e) => {
                const next = e.target.value;
                const macroId = next.trim().length === 0 ? null : draft.noteMacroId;
                setDraft(ticket.id, next.trim().length === 0 ? { note: next, noteMacroId: null } : { note: next });
                schedule("internal", next, macroId);
              }}
              onBlur={() => flush("internal")}
              placeholder="Add a note for staff only. Markdown is supported."
              maxLength={BODY_MAX}
              disabled={pending}
              className={cn("bg-background/70 dark:bg-background/40", sheet ? "min-h-40 text-base" : "min-h-28")}
              aria-describedby={`${ids.internal}-hint`}
            />
            <p id={`${ids.internal}-hint`} className="text-xs opacity-80">
              {REDACTION_NOTE}
            </p>
            <DraftStatus
              label={draftStatusLabel(noteBody, sync.internal, sync.hydrated)}
              state={statusStateFor(noteBody, sync.internal)}
              onDiscard={() => discard("internal")}
              discardable={noteBody.trim().length > 0}
              disabled={pending}
            />
            {sheet ? null : (
              <SubmitRow layout="inline">
                <Button type="button" size="sm" onClick={submitInternal} disabled={pending || noteBody.trim().length === 0}>
                  <Lock aria-hidden />
                  Add internal note
                </Button>
              </SubmitRow>
            )}
          </div>
          {sheet ? (
            <SubmitRow layout="sheet">
              <Button type="button" className="w-full" onClick={submitInternal} disabled={pending || noteBody.trim().length === 0}>
                <Lock aria-hidden />
                Add internal note
              </Button>
            </SubmitRow>
          ) : null}
        </TabsContent>

        {/* ---------------------------------------------------------------- Public reply */}
        <TabsContent value="public">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3" data-channel="PUBLIC">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant="secondary" className="gap-1">
                <Send aria-hidden />
                {PUBLIC_REPLY_LABEL}
              </Badge>
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Editor mode">
                  <Button
                    type="button"
                    size="xs"
                    variant={mode === "write" ? "secondary" : "ghost"}
                    aria-pressed={mode === "write"}
                    onClick={() => setMode("write")}
                  >
                    <Pencil aria-hidden />
                    Write
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant={mode === "preview" ? "secondary" : "ghost"}
                    aria-pressed={mode === "preview"}
                    onClick={() => setMode("preview")}
                  >
                    <Eye aria-hidden />
                    Preview
                  </Button>
                </div>
                <AiDraftButton
                  ticketId={ticket.id}
                  enabled={aiEnabled}
                  disabled={pending}
                  hasExistingText={replyBody.trim().length > 0}
                  onDraft={(text) => {
                    // Straight into the textarea, as ordinary editable text. Nothing is submitted,
                    // nothing is queued, and the acknowledgement resets so the operator confirms the
                    // disclaimer against the words they end up with rather than the ones they had.
                    setDraft(ticket.id, { reply: text });
                    setAcknowledged(false);
                    setMode("write");
                    schedule("public", text, draft.replyMacroId);
                  }}
                />
                <MacroPicker
                  macros={macros}
                  channel="PUBLIC"
                  vars={macroVars()}
                  disabled={pending}
                  onInsert={(r) => {
                    const current = useComposerStore.getState().drafts[ticket.id] ?? EMPTY_DRAFT;
                    const next = appendBody(current.reply, r.body);
                    setDraft(ticket.id, { reply: next, replyMacroId: r.macroId });
                    if (r.disclaimerKey !== "NONE") setDisclaimerKey(r.disclaimerKey);
                    setAcknowledged(false);
                    schedule("public", next, r.macroId);
                  }}
                />
              </div>
            </div>

            <MacroEffects actions={replyMacroActions} />

            {/*
              Stated before a word is typed, because the record it warns about cannot be edited or
              deleted once saved (I2/I8). Decision #62 / CROSSWALK P2: a voicemail ticket has a phone
              and no address, and this composer is fully enabled on it — `permissions.canPublicReply`
              is queue WRITE plus "not closed" and deliberately does not consider the address.
            */}
            {!canDeliverToClient ? (
              <p
                id={ids.noAddress}
                role="status"
                data-slot="no-delivery-address"
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
              >
                <MailWarning aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>
                  <span className="font-semibold">No email address on this ticket.</span> A reply is
                  recorded here for the desk, and that is all: it is not emailed, and the client app
                  cannot show it either, because it identifies a client by the address this ticket does
                  not have. Reach {ticket.requesterPhone ?? "the client"} by phone, or add an address
                  under Edit ticket first.
                </span>
              </p>
            ) : null}

            {mode === "write" ? (
              <>
                <Label htmlFor={ids.public} className="sr-only">
                  Public reply
                </Label>
                <Textarea
                  id={ids.public}
                  value={replyBody}
                  onChange={(e) => {
                    const next = e.target.value;
                    const macroId = next.trim().length === 0 ? null : draft.replyMacroId;
                    setDraft(ticket.id, next.trim().length === 0 ? { reply: next, replyMacroId: null } : { reply: next });
                    schedule("public", next, macroId);
                  }}
                  onBlur={() => flush("public")}
                  placeholder="Write to the client. Markdown is supported; the disclaimer below is appended automatically."
                  maxLength={BODY_MAX}
                  disabled={pending}
                  className={sheet ? "min-h-40 text-base" : "min-h-28"}
                  aria-describedby={`${ids.public}-hint`}
                />
              </>
            ) : (
              <div
                className={cn("rounded-lg border border-dashed border-border px-3 py-2", sheet ? "min-h-40" : "min-h-28")}
                aria-label="Preview of the stored reply"
                data-slot="reply-preview"
              >
                {replyBody.trim().length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing to preview yet.</p>
                ) : (
                  <MarkdownRenderer source={storedPreview} />
                )}
              </div>
            )}
            <p id={`${ids.public}-hint`} className="text-xs text-muted-foreground">
              {REDACTION_NOTE} The preview shows exactly what will be stored and shown to the client.
            </p>

            <DraftStatus
              label={draftStatusLabel(replyBody, sync.public, sync.hydrated)}
              state={statusStateFor(replyBody, sync.public)}
              onDiscard={() => discard("public")}
              discardable={replyBody.trim().length > 0}
              disabled={pending}
            />

            <DisclaimerPreview
              disclaimerKey={disclaimerKey}
              onChange={(k) => {
                setDisclaimerKey(k);
                setAcknowledged(false);
              }}
            />

            {/* 44px tap area: the whole label row toggles the checkbox (htmlFor → the Radix button's id). */}
            <Label htmlFor={ids.ack} className="flex min-h-11 items-start gap-3 py-1 text-sm leading-snug font-normal">
              <Checkbox
                id={ids.ack}
                checked={acknowledged}
                onCheckedChange={(v) => setAcknowledged(v === true)}
                disabled={pending || disclaimerKey === "NONE"}
                aria-required
                className="mt-0.5"
              />
              <span>I confirm this disclaimer will be appended and the reply is client-appropriate</span>
            </Label>

            {sheet ? null : <SubmitRow layout="inline">{replyButtons}</SubmitRow>}
          </div>
          {sheet ? (
            <SubmitRow layout="sheet">
              <div className="flex flex-col gap-2">{replyButtons}</div>
            </SubmitRow>
          ) : null}

          <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {confirmIntent === "pending"
                    ? "Save this reply and set the ticket to Pending client?"
                    : "Save this reply to the ticket?"}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {canDeliverToClient ? (
                    <>
                      The reply is stored with the selected disclaimer appended, becomes visible to the
                      client immediately, and is queued for delivery to {ticket.requesterEmail} — the
                      comment shows Queued until the sender reports a result.
                    </>
                  ) : (
                    <>
                      The reply is stored with the selected disclaimer appended and recorded on this
                      ticket. It will <strong className="font-semibold">not</strong> be emailed and the
                      client app will not show it: this ticket has a phone number and no email address,
                      and both of those paths identify the client by that address.
                    </>
                  )}
                  {confirmIntent === "pending" ? " The ticket moves to Pending client in the same step." : ""}{" "}
                  {/*
                    Every consequence, including the one that mutates the ticket. The macro's actions
                    apply atomically in the same transaction as the reply (Decision #100), so a dialog
                    that omitted them understated what it was confirming.
                  */}
                  {replyMacroEffects.length > 0
                    ? `The macro you inserted also applies: ${replyMacroEffects.join("; ")}. `
                    : ""}
                  Comments are records: they cannot be edited or deleted afterwards.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Keep editing</AlertDialogCancel>
                <AlertDialogAction
                  disabled={pending || !replyReady}
                  onClick={(e) => {
                    e.preventDefault();
                    setConfirmOpen(false);
                    submitPublic(confirmIntent === "pending");
                  }}
                >
                  {confirmIntent === "pending" ? <CalendarClock aria-hidden /> : <Save aria-hidden />}
                  {confirmIntent === "pending" ? "Save and set Pending client" : "Save reply"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TabsContent>
      </Tabs>
    </section>
  );
}
