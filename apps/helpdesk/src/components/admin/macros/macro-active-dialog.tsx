"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, RotateCcw } from "lucide-react";
import { setMacroActive } from "@/server/macros.actions";
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

/**
 * Retire / restore a macro, behind an explicit confirm.
 *
 * Retiring is the only removal there is. A macro that has been applied is pointed at by
 * `Comment.macroId` and by every `MACRO_APPLIED` row, so deleting one would leave the ledger
 * referring to wording nobody can read again; `isActive = false` takes it out of the composer's
 * picker and leaves the history whole. The dialog says that in those terms rather than calling it
 * "delete", because the difference matters to the person clicking it.
 */
export function MacroActiveDialog({
  macroId,
  title,
  isActive,
}: {
  macroId: string;
  title: string;
  isActive: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const retiring = isActive;

  function onConfirm(): void {
    startTransition(async () => {
      const result = await setMacroActive({ macroId, isActive: !isActive });

      if (result.ok) {
        toast.success(retiring ? `“${title}” retired` : `“${title}” restored`);
        setOpen(false);
        router.refresh();
        return;
      }

      switch (result.code) {
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
        case "VALIDATION":
        case "CONFLICT":
          toast.error(result.message);
          return;
        case "INTERNAL":
          toast.error("The change failed. Nothing was recorded.");
          return;
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant={retiring ? "outline" : "secondary"}
        size="sm"
        className="w-full md:w-auto"
        onClick={() => setOpen(true)}
        aria-label={`${retiring ? "Retire" : "Restore"} ${title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {retiring ? <Archive aria-hidden /> : <RotateCcw aria-hidden />}
        {retiring ? "Retire" : "Restore"}
      </Button>

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
            <AlertDialogTitle>{retiring ? `Retire “${title}”?` : `Restore “${title}”?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {retiring ? (
                <>
                  Staff stop seeing it in the composer straight away. Replies already sent with it are unchanged and
                  still point at this wording, which is why retiring is not a delete. You can restore it later. This is
                  recorded in the audit log.
                </>
              ) : (
                <>
                  It goes back into the composer for everyone who can use its queue and channel. Check the wording is
                  still current before you restore it. This is recorded in the audit log.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
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
              {pending ? "Working…" : retiring ? "Retire" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
