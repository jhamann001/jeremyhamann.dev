"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Flag, LoaderCircle, ShieldCheck, Stamp } from "lucide-react";
import { toast } from "sonner";
import type { ActionError, CommentDTO, ReviewStampDTO, ReviewVerdict, Viewer } from "@/types/domain";
import { REVIEW_VERDICT_LABELS } from "@/types/domain";
import { formatDateTime } from "@/lib/format";
import { canStampReview } from "@/lib/rbac";
import { REVIEW_CHECKLIST } from "@/lib/review-checklist";
import type { ReviewChecklistKey } from "@/lib/review-checklist";
import { cn } from "@/lib/utils";
import { stampReview } from "@/server/reviews.actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveSheet,
  ResponsiveSheetBody,
  ResponsiveSheetFooter,
} from "@/components/shell/responsive-sheet";

/**
 * Supervisory review stamp — slice B6.
 *
 * MOUNT POINT: the ticket page passes `ReviewStamp` into `Timeline`'s `commentSlot`, so the control
 * appears under every comment without B3's `CommentItem` importing a B6 module. It returns an `<li>`
 * (the slot lands as a SIBLING inside the timeline's `<ol>`) or null.
 *
 * It renders NOTHING for an INTERNAL note — there is nothing supervisory about the desk talking to
 * itself — and NOTHING for a viewer without `review:stamp`. Both are pure UI convenience: the server
 * re-checks the capability, the visibility and the queue on every stamp.
 *
 * `ReviewStampSheet` is exported because the review queue at `/compliance/reviews` opens the same
 * sheet. One component, two surfaces, so the checklist a reviewer sees on a ticket and the checklist
 * they see in the queue can never drift apart.
 *
 * MOBILE: a bottom sheet on phones, a right sheet at md+; 44 px targets throughout;
 * the verdict is a two-button segmented control rather than a radio row, because two 44 px targets
 * side by side is the whole of the decision and a select would hide half of it behind a tap.
 */
export type ReviewStampProps = { comment: CommentDTO; viewer: Viewer };

const VERDICT_ICON = { APPROVED: CheckCheck, FLAGGED: Flag } as const;

function stampBadgeClasses(verdict: ReviewVerdict): string {
  return verdict === "APPROVED"
    ? "border-emerald-500/60 text-emerald-800 dark:text-emerald-300"
    : "border-amber-500/70 text-amber-900 dark:text-amber-200";
}

/** The one-line summary of who has already reviewed this reply. */
function StampLine({ stamp }: { stamp: ReviewStampDTO }): React.JSX.Element {
  const Icon = VERDICT_ICON[stamp.verdict];
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Badge variant="outline" className={cn("gap-1", stampBadgeClasses(stamp.verdict))}>
        <Icon aria-hidden />
        <span>{REVIEW_VERDICT_LABELS[stamp.verdict]}</span>
      </Badge>
      <span className="min-w-0 truncate">{stamp.reviewer.name ?? stamp.reviewer.email}</span>
      <span aria-hidden>·</span>
      <span>{formatDateTime(stamp.createdAt)}</span>
      {stamp.note !== null && stamp.note.length > 0 ? (
        <span className="w-full text-foreground/80">{stamp.note}</span>
      ) : null}
    </li>
  );
}

export function ReviewStamp({ comment, viewer }: ReviewStampProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);

  if (comment.visibility !== "PUBLIC") return null;
  if (!canStampReview(viewer.groups)) return null;

  const mine = comment.reviews.find((r) => r.reviewer.id === viewer.id) ?? null;

  return (
    <li className="ml-0 rounded-lg border border-dashed px-3 py-2 md:ml-8" data-slot="review-stamp">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium">Supervisory review</span>
        {comment.reviews.length === 0 ? (
          <span className="text-xs text-muted-foreground">Not reviewed yet</span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={mine === null ? "outline" : "ghost"}
          className="ml-auto min-h-11 md:min-h-9"
          onClick={() => setOpen(true)}
          disabled={mine !== null}
          aria-label={mine === null ? "Review this reply" : "You have already reviewed this reply"}
        >
          <Stamp aria-hidden />
          {mine === null ? "Review" : "Reviewed by you"}
        </Button>
      </div>

      {comment.reviews.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1.5">
          {comment.reviews.map((r) => (
            <StampLine key={r.id} stamp={r} />
          ))}
        </ul>
      ) : null}

      <ReviewStampSheet
        open={open}
        onOpenChange={setOpen}
        commentId={comment.id}
        heading={`Reply sent ${formatDateTime(comment.createdAt)}`}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// The sheet — shared with /compliance/reviews
// ---------------------------------------------------------------------------

export type ReviewStampSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commentId: string;
  /** A line of context at the top of the sheet: which reply this is. */
  heading: string;
  /** Rendered above the checklist — the review queue passes the reply's excerpt. */
  children?: React.ReactNode;
  /** Called after a successful stamp, before the router refresh. */
  onStamped?: (commentId: string) => void;
};

export function ReviewStampSheet({
  open,
  onOpenChange,
  commentId,
  heading,
  children,
  onStamped,
}: ReviewStampSheetProps): React.JSX.Element {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const uid = useId();
  const [verdict, setVerdict] = useState<ReviewVerdict>("APPROVED");
  const [checked, setChecked] = useState<ReviewChecklistKey[]>([]);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);

  // A fresh sheet every time. A checklist half-ticked against the previous reply must never be
  // attributed to this one — the whole value of the record is that it says what THIS reviewer
  // checked on THIS reply.
  useEffect(() => {
    if (open) return;
    setVerdict("APPROVED");
    setChecked([]);
    setNote("");
    setNoteError(null);
  }, [open]);

  const ids = { note: `${uid}-note`, verdict: `${uid}-verdict` };

  function toggle(key: ReviewChecklistKey, on: boolean): void {
    setChecked((prev) => (on ? [...prev.filter((k) => k !== key), key] : prev.filter((k) => k !== key)));
  }

  function applyError(err: ActionError): void {
    switch (err.code) {
      case "CONFLICT":
        toast.warning("You have already reviewed this reply.");
        onOpenChange(false);
        router.refresh();
        return;
      case "VALIDATION": {
        const message = err.fieldErrors?.note?.join(" ") ?? err.fieldErrors?._form?.join(" ") ?? err.message;
        setNoteError(message);
        toast.error(message);
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
        toast.error("Reply not found");
        router.refresh();
        return;
      case "INTERNAL":
        toast.error("The review could not be recorded. Nothing was saved.");
        return;
    }
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setNoteError(null);
    startTransition(async () => {
      const result = await stampReview({
        commentId,
        verdict,
        checklist: checked,
        note: note.trim().length > 0 ? note.trim() : undefined,
      });
      if (!result.ok) {
        applyError(result);
        return;
      }
      toast.success(verdict === "APPROVED" ? "Review recorded — approved" : "Review recorded — flagged");
      onStamped?.(commentId);
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
      title="Review this reply"
      description={heading}
      size="lg"
      height="full"
    >
      <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col" aria-busy={pending || undefined}>
        <ResponsiveSheetBody className="flex flex-col gap-4">
          {children}

          <fieldset className="flex flex-col gap-2" disabled={pending}>
            <legend className="text-sm font-medium">What you checked</legend>
            <p className="text-xs text-muted-foreground">
              A record of what you looked at. Nothing here is required, and nothing is checked for you.
            </p>
            <ul className="flex flex-col gap-2">
              {REVIEW_CHECKLIST.map((item) => {
                const id = `${uid}-${item.key}`;
                return (
                  <li key={item.key} className="flex min-h-11 items-start gap-3">
                    <Checkbox
                      id={id}
                      checked={checked.includes(item.key)}
                      onCheckedChange={(v) => toggle(item.key, v === true)}
                      className="mt-1"
                      aria-describedby={`${id}-detail`}
                    />
                    <div className="min-w-0">
                      <Label htmlFor={id} className="text-sm font-normal">
                        {item.label}
                      </Label>
                      <p id={`${id}-detail`} className="text-xs text-muted-foreground">
                        {item.detail}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <span id={ids.verdict} className="text-sm font-medium">
              Verdict
            </span>
            <div role="group" aria-labelledby={ids.verdict} className="grid grid-cols-2 gap-2">
              {(["APPROVED", "FLAGGED"] as const).map((v) => {
                const Icon = VERDICT_ICON[v];
                return (
                  <Button
                    key={v}
                    type="button"
                    variant={verdict === v ? "default" : "outline"}
                    className="min-h-11 justify-center"
                    aria-pressed={verdict === v}
                    disabled={pending}
                    onClick={() => setVerdict(v)}
                  >
                    <Icon aria-hidden />
                    {REVIEW_VERDICT_LABELS[v]}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.note}>
              Note {verdict === "FLAGGED" ? <span aria-hidden>(required)</span> : <span aria-hidden>(optional)</span>}
            </Label>
            <Textarea
              id={ids.note}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              className="min-h-24 leading-relaxed"
              disabled={pending}
              aria-invalid={noteError ? true : undefined}
              aria-describedby={`${ids.note}-hint${noteError ? ` ${ids.note}-error` : ""}`}
              required={verdict === "FLAGGED"}
            />
            {noteError ? (
              <p id={`${ids.note}-error`} className="text-xs text-destructive" role="alert">
                {noteError}
              </p>
            ) : null}
            <p id={`${ids.note}-hint`} className="text-xs text-muted-foreground">
              {verdict === "FLAGGED"
                ? "Say what is wrong with this reply — the next reader has to act on it."
                : "A review cannot be edited or withdrawn. A second opinion is a second stamp."}
            </p>
          </div>
        </ResponsiveSheetBody>

        <ResponsiveSheetFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={pending}>
            {pending ? <LoaderCircle aria-hidden className="animate-spin" /> : <Stamp aria-hidden />}
            {pending ? "Recording…" : "Record review"}
          </Button>
        </ResponsiveSheetFooter>
      </form>
    </ResponsiveSheet>
  );
}
