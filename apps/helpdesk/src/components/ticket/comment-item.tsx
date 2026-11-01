"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Cog, Download, Inbox, Lock, Send, Sparkles, Undo2, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import type { AttachmentDTO, CommentDTO } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";
import { DISCLAIMERS } from "@/lib/disclaimers";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { retractComment } from "@/server/retractions.actions";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DeliveryChip, DeliveryFailureNote } from "@/components/tickets/delivery-chip";
import {
  INTERNAL_BADGE_CLASSES,
  INTERNAL_NOTE_CLASSES,
  commentChannel,
  commentChannelLabel,
  type CommentChannel,
} from "@/components/tickets/internal-note-styles";
import { PiiIndicator } from "@/components/tickets/pii-indicator";
import { UserAvatar } from "@/components/tickets/user-avatar";
import { NO_CAPABILITIES, useComposerStore } from "@/components/ticket/composer-store";
import { MarkdownRenderer } from "@/components/ticket/markdown-renderer";
import { formatBytes, mimeIcon, mimeLabel } from "@/components/ticket/attachments/attachment-meta";

/**
 * One comment on the ticket timeline.
 * INTERNAL → amber frame (`INTERNAL_NOTE_CLASSES`, the single source of yellow) + Lock badge.
 * PUBLIC → neutral card + a badge naming the AUDIENCE OR ORIGIN (never a claim about delivery) + the
 * delivery chip + the disclaimer chip.
 *
 * Wave A adds three things:
 * - **Authorship.** A REQUESTER or SYSTEM row has no `author`, so it renders
 *   `authorLabel` instead of the avatar — `UserAvatar(null)` means "Unassigned", which a client's own
 *   message is not.
 * - **The channel badge branches on `authorKind`, not on `visibility` alone.** A requester's inbound
 *   reply is a PUBLIC row, so a visibility-only branch badged it with a Send icon and the outbound
 *   wording — an inbound client message presented as an outbound firm message, which on a complaint or
 *   an escalation ticket is a misattribution on the record. `commentChannel` resolves the four real
 *   cases and `commentChannelLabel` owns the wording, so the dashboard preview cannot drift from here.
 * - **The delivery chip.** A PUBLIC staff reply carries its outbound state: Queued / Sending / Sent /
 *   Failed, from `comment.delivery`, which the ticket loader already fetched with the comment. Nothing
 *   here says "sent" unless a sender reported a result. Reading a delivery's status is not a read of
 *   client material — the body is the comment the viewer already has — so it writes no audit row (§3 rule 3).
 *
 * Files sit on the message they arrived with. `CommentDTO.attachments` carries the READY attachments
 * of this comment (contract §10 S7; loaded by `src/server/comments.ts`), and without them here a reply
 * reading "see attached" rendered with no file anywhere on it and the operator had to infer the link
 * from timestamps in the separate panel. Listing attachment metadata is not a read of client material,
 * so there is still no audit row here; the DOWNLOAD route audits itself before it mints a URL.
 *
 * --- Wave B: retraction ---
 *
 * This file became a CLIENT component for one reason: the withdraw control has to live on the comment
 * it withdraws, and a control needs state. Everything it renders is still the `CommentDTO` the server
 * loaded; nothing is fetched here.
 *
 * **The withdrawn body stays on screen, struck through.** A staff surface has to be able to read what
 * the desk actually put in front of a client — that is the whole record, and hiding it would make the
 * ticket page disagree with the ledger. What the CLIENT sees is a different question and is answered
 * at the privilege layer: `ClientVisibleComment` returns an empty body and `retracted = true`, and the
 * client role holds no privilege on `"Comment"` (guardrail G16). Verified against
 * `src/server/client-view.ts`, which renders `CLIENT_RETRACTED_BODY` and refuses a retracted row that
 * arrives carrying a body.
 *
 * **The dialog states the delivery consequence before the click, not after.** A QUEUED email is
 * cancelled in the same transaction; one that has already been sent cannot be recalled, and this
 * surface says so plainly rather than letting an operator believe a withdrawal unsends mail.
 */

/**
 * `DeliveryChip` moved to `@/components/tickets/delivery-chip` so the dashboard preview card can print
 * the same delivery state without S5 importing S6 (§g layering). Re-exported here because the timeline
 * is where it was introduced and where the contract points.
 */
export { DeliveryChip } from "@/components/tickets/delivery-chip";

/** Icon per channel. Inbound never gets `Send`: the arrow points the wrong way for a client's message. */
const CHANNEL_ICON: Readonly<Record<CommentChannel, LucideIcon>> = {
  INTERNAL: Lock,
  OUTBOUND: Send,
  INBOUND: Inbox,
  SYSTEM: Cog,
};

/** Author line for a row with no `User` behind it: the requester's name, or the system label. */
function NonStaffAuthor({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-xs">
      <span
        aria-hidden
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <User className="size-3.5" />
      </span>
      <span className="truncate font-medium">{label}</span>
    </span>
  );
}

/**
 * The files that belong to this message. Attachments are INTERNAL-only in v1, so an
 * outbound reply's files were NOT transmitted with it — the row says so rather than letting a rep
 * assume the client received what is listed under their own reply.
 */
function CommentAttachments({
  attachments,
  channel,
}: {
  attachments: readonly AttachmentDTO[];
  channel: CommentChannel;
}): React.JSX.Element | null {
  if (attachments.length === 0) return null;
  const note =
    channel === "INBOUND"
      ? "Arrived with this message."
      : "On the ticket only — attachments are never sent to the client.";

  return (
    <div className="mt-3 border-t pt-2" data-comment-attachments={attachments.length}>
      <ul className="flex flex-col" aria-label={`Files on this message (${attachments.length})`}>
        {attachments.map((a) => {
          const Icon = mimeIcon(a.mime);
          return (
            <li key={a.id}>
              <a
                href={`/api/attachments/${a.id}/download`}
                rel="noopener"
                className="flex min-h-11 items-center gap-2 rounded-md px-1 text-xs underline-offset-4 outline-none hover:bg-muted/60 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 md:min-h-9"
              >
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium" title={a.filename}>
                  {a.filename}
                </span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{formatBytes(a.size)}</span>
                <span className="hidden shrink-0 text-muted-foreground sm:inline">{mimeLabel(a.mime)}</span>
                <Download aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="sr-only">Download {a.filename}</span>
              </a>
            </li>
          );
        })}
      </ul>
      <p className="px-1 pt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

/**
 * The retraction banner: who withdrew this, when, and why, above the struck-through body.
 *
 * Above rather than below, because a reader scanning the timeline must know the message was withdrawn
 * BEFORE they read it and act on it. Strike-through alone is easy to miss at a glance and invisible to
 * a screen reader.
 */
function RetractionNotice({ comment }: { comment: CommentDTO }): React.JSX.Element | null {
  const retraction = comment.retraction;
  if (retraction === null) return null;
  const who = retraction.retractedBy.name?.trim() || retraction.retractedBy.email;
  return (
    <div
      data-slot="comment-retraction"
      role="status"
      className="mt-2 flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
    >
      <p className="font-semibold">
        Withdrawn by {who} · <time dateTime={retraction.createdAt}>{formatDateTime(retraction.createdAt)}</time>
      </p>
      <p>
        <span className="font-medium">Reason:</span> {retraction.reason}
      </p>
      <p className="opacity-90">
        The client no longer sees this message — their view shows only that it was withdrawn. It is kept
        here, struck through, because it is part of this ticket&rsquo;s record and cannot be edited or
        deleted. A withdrawal cannot be undone; write to the client again to correct it.
      </p>
    </div>
  );
}

/**
 * "Withdraw this reply" — the control and its confirmation.
 *
 * Two-step by construction: a typed reason of at least `reasonMinChars`, which the DB CHECK enforces
 * too, and an explicit confirm. There is no undo, so the dialog says so in the sentence above the
 * button rather than in a toast afterwards.
 */
function WithdrawReply({ comment }: { comment: CommentDTO }): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const uid = useId();
  const reasonId = `${uid}-reason`;

  const delivery = comment.delivery;
  const queued = delivery?.status === "QUEUED";
  // LEASED or SENT: a poller already has it, or it is in a mailbox. Either way it is not ours to stop.
  const alreadyGone = delivery !== null && delivery.status !== "QUEUED" && delivery.status !== "CANCELLED";
  const ready = reason.trim().length >= WAVE_B_LIMITS.reasonMinChars;

  function submit(): void {
    if (!ready) return;
    startTransition(async () => {
      const result = await retractComment({ commentId: comment.id, reason: reason.trim(), confirm: true });
      if (result.ok) {
        setOpen(false);
        setReason("");
        toast.success(
          result.data.deliveryCancelled
            ? "Reply withdrawn — the queued email was cancelled before it left"
            : "Reply withdrawn — it is struck through here and hidden from the client",
        );
        router.refresh();
        return;
      }
      switch (result.code) {
        case "CONFLICT":
          toast.warning("This reply has already been withdrawn — refreshing");
          setOpen(false);
          router.refresh();
          return;
        case "FORBIDDEN":
          toast.error("You do not have permission to withdraw replies on this ticket.");
          return;
        case "VALIDATION": {
          const detail = result.fieldErrors ? Object.values(result.fieldErrors).flat()[0] : undefined;
          toast.error(detail ?? result.message);
          return;
        }
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        case "NOT_FOUND":
          toast.error("That comment no longer exists — refreshing");
          router.refresh();
          return;
        case "INTERNAL":
          toast.error("The reply could not be withdrawn. Nothing was changed.");
          return;
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setOpen(true)}
        // `data-control`, NOT `data-slot`: `Button` sets `data-slot="button"` before spreading props,
        // so a caller-supplied `data-slot` silently replaces it — and the phone tap rule in
        // globals.css is keyed on `:where([data-slot=button], …)`, so this control dropped out of the
        // 44 px floor entirely and measured 88x24. It is the entry point to an irreversible, audited
        // withdrawal. `min-h-11 md:min-h-0` is §7's sanctioned fix: give the control the size.
        data-control="withdraw-reply"
        className="min-h-11 md:min-h-0"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Withdraw this reply"
      >
        <Undo2 aria-hidden />
        Withdraw
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!pending) setOpen(o);
        }}
      >
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this reply?</AlertDialogTitle>
            <AlertDialogDescription>
              {queued
                ? "This reply has not left the building yet. Withdrawing it cancels the queued email and hides the message from the client."
                : alreadyGone
                  ? "This reply has already been emailed to the client and that email cannot be recalled. Withdrawing it removes the message from the client's view here and records why — it does not unsend anything."
                  : "Withdrawing hides this message from the client's view and records why."}{" "}
              The text stays on this ticket, struck through, because it is part of the record. A
              withdrawal cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={reasonId}>Why is it being withdrawn?</Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={WAVE_B_LIMITS.reasonMaxChars}
              disabled={pending}
              placeholder="e.g. sent to the wrong ticket; the settlement date quoted was incorrect"
              className="min-h-24 text-base md:text-sm"
              aria-describedby={`${reasonId}-hint`}
            />
            <p id={`${reasonId}-hint`} className="text-xs text-muted-foreground">
              At least {WAVE_B_LIMITS.reasonMinChars} characters. This is shown to staff on the ticket and
              recorded in the audit log; the client never sees it.
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Keep the reply</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={submit}
              disabled={pending || !ready}
              aria-busy={pending || undefined}
            >
              <Undo2 aria-hidden />
              {pending ? "Withdrawing…" : "Withdraw reply"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export type CommentItemProps = {
  comment: CommentDTO;
  /**
   * Whether this viewer may withdraw a public reply on this ticket (`queue:write`).
   *
   * Optional because the timeline is foundation-owned and passes only `comment`. When it is omitted
   * the value comes from the composer's published capability for this ticket
   * (`composer-store.ts`, which explains why). Absent both, the control is not offered — and
   * `retractComment` re-checks the capability server-side on every call regardless, so this
   * decides what is SHOWN, never what is allowed.
   */
  canRetract?: boolean;
};

export function CommentItem({ comment, canRetract }: CommentItemProps): React.JSX.Element {
  const published = useComposerStore((s) => s.capabilities[comment.ticketId]) ?? NO_CAPABILITIES;
  const mayRetract = canRetract ?? published.canRetract;

  const internal = comment.visibility === "INTERNAL";
  const channel = commentChannel(comment.visibility, comment.authorKind);
  const ChannelIcon = CHANNEL_ICON[channel];
  const disclaimer = comment.disclaimerKey !== "NONE" ? DISCLAIMERS[comment.disclaimerKey] : null;
  const isStaff = comment.authorKind === "STAFF" && comment.author !== null;
  const retracted = comment.retraction !== null;
  // Only the desk's own outbound replies. A client's own message is not ours to withdraw, and an
  // internal note has never been client-visible, so there is nothing to take back.
  const withdrawable = mayRetract && !retracted && channel === "OUTBOUND";

  return (
    <li
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-xs",
        internal ? INTERNAL_NOTE_CLASSES : "border-border",
        retracted && "border-amber-500/40",
      )}
      data-comment-id={comment.id}
      data-visibility={comment.visibility}
      data-author-kind={comment.authorKind}
      data-comment-channel={channel}
      data-retracted={retracted ? "true" : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {isStaff ? <UserAvatar user={comment.author} size="sm" /> : <NonStaffAuthor label={comment.authorLabel} />}
          <time
            dateTime={comment.createdAt}
            title={formatDateTime(comment.createdAt)}
            className="text-xs tabular-nums text-muted-foreground"
          >
            {formatRelative(comment.createdAt)}
          </time>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {internal ? (
            <Badge className={cn("gap-1", INTERNAL_BADGE_CLASSES)} data-channel="INTERNAL">
              <ChannelIcon aria-hidden />
              {commentChannelLabel(channel)}
            </Badge>
          ) : (
            <>
              <Badge
                variant={channel === "OUTBOUND" ? "secondary" : "outline"}
                className="gap-1"
                data-channel="PUBLIC"
              >
                <ChannelIcon aria-hidden />
                {commentChannelLabel(channel)}
              </Badge>
              {retracted ? (
                <Badge variant="outline" className="gap-1 border-amber-500/50 font-normal" data-control="retracted-badge">
                  <Undo2 aria-hidden />
                  Withdrawn
                </Badge>
              ) : null}
              {comment.delivery ? <DeliveryChip delivery={comment.delivery} /> : null}
              {disclaimer ? (
                <Badge variant="outline" className="font-normal" title={disclaimer.text} data-disclaimer={comment.disclaimerKey}>
                  Disclaimer: {disclaimer.label}
                </Badge>
              ) : null}
            </>
          )}
          {comment.macroTitle ? (
            <Badge variant="outline" className="gap-1 font-normal text-muted-foreground" data-macro-id={comment.macroId ?? undefined}>
              <Sparkles aria-hidden />
              {comment.macroTitle}
            </Badge>
          ) : null}
          <PiiIndicator count={comment.piiRedactionCount} scope="comment" />
          {withdrawable ? <WithdrawReply comment={comment} /> : null}
        </div>
      </div>
      <div className="px-3 pt-2 pb-3">
        <RetractionNotice comment={comment} />
        {/*
          The stored text, unchanged (I8). `line-through` plus reduced contrast on a withdrawn row, and
          the banner above says so in words for anyone the strike-through does not reach.
        */}
        <div className={cn(retracted && "mt-2 text-muted-foreground line-through decoration-amber-600/60")}>
          {/*
            `mentions` for INTERNAL notes only (integration round 1, B1's note §1.4): the chips mark
            the exact tokens `parseMentions` produced, which are the tokens that produced the
            Notification rows. A PUBLIC reply is deliberately NOT passed through it — an `@` there is
            a typo or an address the client typed, and a chip would claim a colleague had been told.
          */}
          <MarkdownRenderer source={comment.body} mentions={internal} />
        </div>
        <CommentAttachments attachments={comment.attachments} channel={channel} />
      </div>
      <DeliveryFailureNote delivery={comment.delivery} className="px-3 pb-3" />
    </li>
  );
}
