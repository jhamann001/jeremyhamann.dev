"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, RefreshCw } from "lucide-react";
import type { ApiTokenDTO, ApiTokenSecret } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";
import { revokeApiToken, rotateApiToken } from "@/server/api-tokens.actions";
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

/**
 * Revoke or rotate, behind an explicit confirm with a recorded reason
 * (the build record `API_TOKEN_REVOKED` / `_ROTATED`).
 *
 * A dialog rather than a switch, for the reason `UserActiveDialog` gives: this is not a preference.
 * Revoking breaks whatever is holding the credential, immediately and without a deploy, and the
 * consequence is stated in the consumer's own terms before anything happens.
 *
 * The reason is REQUIRED and has a floor, unlike the optional one on a user deactivation. "Why is
 * this credential gone" is the question asked six months later when an integration stops working,
 * and an empty answer in an append-only ledger cannot be corrected afterwards.
 */
export type TokenLifecycleDialogProps = {
  token: ApiTokenDTO;
  mode: "revoke" | "rotate";
  /** Rotation returns a new plaintext, which the page shows once. Never called for a revoke. */
  onRotated: (secret: ApiTokenSecret) => void;
  /**
   * Fix round 1. Called with this token's id after a successful REVOKE, so the page can clear a
   * reveal panel that is still displaying the plaintext of the credential just killed.
   *
   * `router.refresh()` re-renders the list from the server and leaves client state alone, so the row
   * correctly showed "revoked" while the block above it still told an administrator to save a token
   * that no longer works — on the one page whose whole subject is credential hygiene.
   */
  onRevoked?: (tokenId: string) => void;
};

export function TokenLifecycleDialog({ token, mode, onRotated, onRevoked }: TokenLifecycleDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();

  const revoking = mode === "revoke";
  const short = reason.trim().length < WAVE_B_LIMITS.reasonMinChars;
  const fieldId = `token-${mode}-reason-${token.id}`;

  function onConfirm(): void {
    if (short) return;
    startTransition(async () => {
      const input = { tokenId: token.id, reason: reason.trim() };
      const result = revoking ? await revokeApiToken(input) : await rotateApiToken(input);

      if (result.ok) {
        if (!revoking && "plaintext" in result.data) onRotated(result.data);
        if (revoking) onRevoked?.(token.id);
        toast.success(revoking ? `${token.name} revoked` : `${token.name} rotated`);
        setOpen(false);
        setReason("");
        router.refresh();
        return;
      }

      switch (result.code) {
        case "FORBIDDEN":
          toast.error("You do not have permission to change API tokens.");
          return;
        case "VALIDATION":
          toast.error(result.message);
          return;
        case "NOT_FOUND":
          toast.error("That token no longer exists — refreshing.");
          setOpen(false);
          router.refresh();
          return;
        case "CONFLICT":
          toast.warning("That token changed elsewhere — refreshing.");
          setOpen(false);
          router.refresh();
          return;
        case "UNAUTHORIZED":
          toast.error("Your session has ended. Sign in again.");
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
      <Button
        type="button"
        variant={revoking ? "outline" : "secondary"}
        size="sm"
        className="w-full md:w-auto"
        aria-label={`${revoking ? "Revoke" : "Rotate"} ${token.name}`}
        onClick={() => setOpen(true)}
      >
        {revoking ? <Ban aria-hidden /> : <RefreshCw aria-hidden />}
        {revoking ? "Revoke" : "Rotate"}
      </Button>

      <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
        {/* docs/MOBILE_FIRST.md §4.6: a dialog carrying a form needs a ceiling and a scroller, or an
            Android keyboard pushes the confirm button off a ~390x400 layout viewport. */}
        <AlertDialogContent className="max-h-[90svh] overflow-y-auto overscroll-contain">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {revoking ? `Revoke ${token.name}?` : `Rotate ${token.name}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revoking ? (
                <>
                  Anything holding <strong>{token.prefix}</strong> stops working on its next request —
                  there is no grace period and no cache to wait out. The row is kept, never deleted, so
                  its history stays readable. This is recorded in the audit log.
                </>
              ) : (
                <>
                  <strong>{token.prefix}</strong> is revoked and a NEW token is issued with the same name,
                  scopes and expiry. There is no overlap: the old one stops working the moment this saves,
                  so do it when you can paste the new one straight in. This is recorded in the audit log.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId}>Reason</Label>
            <Input
              id={fieldId}
              name="reason"
              value={reason}
              maxLength={WAVE_B_LIMITS.reasonMaxChars}
              autoComplete="off"
              placeholder={revoking ? "n8n workflow retired, 2026-09-20" : "Quarterly rotation, 2026-09-20"}
              onChange={(e) => setReason(e.target.value)}
              disabled={pending}
              aria-describedby={`${fieldId}-help`}
            />
            <p id={`${fieldId}-help`} className="text-xs text-muted-foreground">
              At least {WAVE_B_LIMITS.reasonMinChars} characters. Stored on the audit row — no client
              identifiers.
            </p>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              // Radix closes on select; the action is async, so the close is ours to do.
              onClick={(e) => {
                e.preventDefault();
                onConfirm();
              }}
              disabled={pending || short}
              aria-busy={pending || undefined}
            >
              {pending ? "Working…" : revoking ? "Revoke" : "Rotate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
