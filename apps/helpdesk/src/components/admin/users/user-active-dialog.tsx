"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserMinus, UserPlus } from "lucide-react";
import { deactivateUser, reactivateUser } from "@/server/users.actions";
import { demoMode } from "@/lib/demo/mode";
import { isPersonaUserId } from "@/lib/dev-login";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const REASON_MAX = 500;

/** Why an operator's own row refuses deactivation. Rendered, not only hung on a `title`. */
const SELF_DEACTIVATION_REASON = "You cannot deactivate your own account — ask another Operations administrator." as const;

export type UserActiveDialogProps = {
  userId: string;
  /** Name or email — whatever the row shows, so the dialog names the same person the operator tapped. */
  displayName: string;
  isActive: boolean;
  /** Open assignments that deactivation will hand back to the queue. */
  openAssignments: number;
  /** True for the signed-in operator's own row: the action refuses it, so the control says so up front. */
  isSelf: boolean;
};

/**
 * The active toggle, behind an explicit confirm.
 *
 * It is a button and a dialog rather than a switch on purpose. Deactivation is not a preference: it
 * ends someone's sessions, refuses their next sign-in and takes every open ticket off them, and each
 * of those is an audit row. A switch invites an accidental flip and shows none of that; the dialog
 * states the consequence in the person's own terms ("3 open tickets return to their queues") before
 * anything happens.
 *
 * The optional reason is stored in the `USER_DEACTIVATED` / `USER_REACTIVATED` metadata, sanitized
 * server-side like every other free-text field. It is the line an examiner reads a year later.
 */
export function UserActiveDialog({
  userId,
  displayName,
  isActive,
  openAssignments,
  isSelf,
}: UserActiveDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const deactivating = isActive;
  const disabled = isSelf && deactivating;
  const selfReasonId = `self-deactivation-${userId}`;

  function onConfirm(): void {
    startTransition(async () => {
      const input = { userId, isActive: !isActive, ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}) };
      const result = deactivating ? await deactivateUser(input) : await reactivateUser(input);

      if (result.ok) {
        if (deactivating && "clearedAssignments" in result.data) {
          const cleared = result.data.clearedAssignments;
          toast.success(
            cleared === 0
              ? `${displayName} deactivated`
              : `${displayName} deactivated — ${cleared} ${cleared === 1 ? "ticket" : "tickets"} returned to the queue`,
          );
        } else {
          toast.success(`${displayName} reactivated`);
        }
        setOpen(false);
        setReason("");
        router.refresh();
        return;
      }

      switch (result.code) {
        case "FORBIDDEN":
          // The demo's persona fence refuses with FORBIDDEN too; say which refusal it was.
          toast.error(
            demoMode() && isPersonaUserId(userId)
              ? "This is a shared demo sign-in account, so it can't be changed. Try another staff member."
              : "You do not have permission to change staff accounts.",
          );
          return;
        case "VALIDATION":
          toast.error(result.message);
          return;
        case "NOT_FOUND":
          toast.error("That account no longer exists — refreshing.");
          setOpen(false);
          router.refresh();
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
          router.refresh();
          return;
        case "CONFLICT":
          toast.warning("That account changed elsewhere — refreshing.");
          setOpen(false);
          router.refresh();
          return;
        case "INTERNAL":
          toast.error("The change failed. Nothing was recorded.");
          return;
      }
    });
  }

  return (
    <>
      {/*
        The refusal is stated as VISIBLE TEXT, not only as a `title` (docs/MOBILE_FIRST.md R10). shadcn's
        Button carries `disabled:pointer-events-none`, so a tooltip on a disabled control cannot fire even
        on a desktop hover, and a phone has no hover at all — an operator saw a grey button and was told
        nothing about why their own row refuses deactivation.
      */}
      <div className="flex flex-col items-stretch gap-1 md:items-end">
        <Button
          type="button"
          variant={deactivating ? "outline" : "secondary"}
          size="sm"
          className="w-full md:w-auto"
          disabled={disabled}
          title={disabled ? SELF_DEACTIVATION_REASON : undefined}
          aria-label={`${deactivating ? "Deactivate" : "Reactivate"} ${displayName}`}
          aria-describedby={disabled ? selfReasonId : undefined}
          onClick={() => setOpen(true)}
        >
          {deactivating ? <UserMinus aria-hidden /> : <UserPlus aria-hidden />}
          {deactivating ? "Deactivate" : "Reactivate"}
        </Button>
        {disabled ? (
          <p id={selfReasonId} className="text-xs text-muted-foreground md:text-right">
            {SELF_DEACTIVATION_REASON}
          </p>
        ) : null}
      </div>

      <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        {/*
          docs/MOBILE_FIRST.md §4.6's recipe for a dialog that carries a form. `AlertDialogContent` is
          centred with no max-height and no scroller, which was fine for a title + two lines + two
          buttons; with a form inside it the box runs past 500 px, and an Android keyboard shrinks the
          layout viewport to roughly 390x400 (`interactive-widget: resizes-content`, src/app/layout.tsx),
          putting the confirm button off-screen with no way to scroll to it. The width half of §4.6's
          recipe is deliberately omitted: the primitive's own `data-[size=default]:max-w-xs` wins on
          specificity over a plain `max-w-*` utility, so it would be dead CSS.
        */}
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deactivating ? `Deactivate ${displayName}?` : `Reactivate ${displayName}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deactivating ? (
                <>
                  Their current session stops working on the next request and Okta can no longer sign them in.
                  {openAssignments > 0
                    ? ` ${openAssignments} open ${openAssignments === 1 ? "ticket returns" : "tickets return"} to the queue unassigned.`
                    : " They hold no open tickets."}{" "}
                  This is recorded in the audit log.
                </>
              ) : (
                <>
                  They will be able to sign in again. Tickets that were handed back to the queue stay where they
                  are — reassign them deliberately. This is recorded in the audit log.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`reason-${userId}`}>Reason (optional)</Label>
            <Input
              id={`reason-${userId}`}
              name="reason"
              value={reason}
              maxLength={REASON_MAX}
              autoComplete="off"
              placeholder={deactivating ? "Left the firm, 2026-09-19" : "Returned from leave"}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
            />
            <p className="text-xs text-muted-foreground">
              Stored on the audit row. Do not put account numbers or client identifiers here.
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              // Radix closes on select by default; the action is async, so the close is ours to do.
              onClick={(e) => {
                e.preventDefault();
                onConfirm();
              }}
              disabled={pending}
              aria-busy={pending || undefined}
            >
              {pending ? "Working…" : deactivating ? "Deactivate" : "Reactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
