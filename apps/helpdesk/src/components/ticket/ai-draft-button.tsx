"use client";

import { useId, useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { ActionResult, AiDraftResult } from "@/types/domain";
import { requestAiDraft } from "@/server/ai-draft.actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ResponsivePopover } from "@/components/shell/responsive-sheet";

/**
 * The AI draft control (docs/MOBILE_FIRST.md R1–R12).
 *
 * Sits beside the macro picker on the Public pane. Opening it offers one optional instruction box and
 * one button; the result lands in the composer's textarea as ordinary editable text and the operator
 * sends it — or does not — through exactly the path they use for their own words. **This component
 * has no send path of any kind.**
 *
 * `enabled` is resolved on the SERVER (`loadComposerState` → `isAiDraftingEnabled(env)`) because a
 * client component may not import `@/lib/env`. When it is false this renders `null`: not a
 * disabled button, not a "coming soon" — nothing. A control that cannot work is noise on a screen
 * that is already dense, and an operator who has never seen the button cannot wonder why it is grey.
 *
 * The copy is deliberate. It says **draft**, never "write" or "reply", and the helper line says a
 * person sends it. Nothing on this surface may claim a reply was sent, and nothing
 * here may suggest the model did more than propose words.
 */

const INSTRUCTION_MAX = 1_000;

export type AiDraftButtonProps = {
  ticketId: string;
  /** Server-resolved. False ⇒ this component renders nothing at all. */
  enabled: boolean;
  /** The composer is busy submitting, or the channel is not available. */
  disabled?: boolean;
  /** True when the reply box already has text — the draft REPLACES it, so it is confirmed first. */
  hasExistingText: boolean;
  /** Receives the draft text. The caller decides where it goes; nothing is sent. */
  onDraft: (text: string) => void;
};

export function AiDraftButton({
  ticketId,
  enabled,
  disabled,
  hasExistingText,
  onDraft,
}: AiDraftButtonProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [pending, startTransition] = useTransition();
  const uid = useId();

  if (!enabled) return null;

  const ids = { instruction: `${uid}-instruction`, hint: `${uid}-hint` };

  function handleResult(result: ActionResult<AiDraftResult>): void {
    if (result.ok) {
      onDraft(result.data.draft);
      setOpen(false);
      setInstruction("");
      toast.success("Draft ready — read it before you save anything");
      return;
    }
    switch (result.code) {
      case "VALIDATION": {
        const detail = result.fieldErrors ? Object.values(result.fieldErrors).flat()[0] : undefined;
        toast.error(detail ?? result.message);
        return;
      }
      case "FORBIDDEN":
        toast.error("You do not have permission to draft a reply on this ticket.");
        return;
      case "NOT_FOUND":
        toast.error("Ticket not found");
        return;
      case "UNAUTHORIZED":
        toast.error("Your session has ended. Sign in again.");
        return;
      case "CONFLICT":
      case "INTERNAL":
        toast.error("The draft could not be generated. Nothing was changed.");
        return;
    }
  }

  function submit(): void {
    const trimmed = instruction.trim();
    startTransition(async () => {
      const result = await requestAiDraft({ ticketId, ...(trimmed.length > 0 ? { instruction: trimmed } : {}) });
      handleResult(result);
    });
  }

  return (
    <ResponsivePopover
      open={open}
      onOpenChange={(o) => {
        if (!pending) setOpen(o);
      }}
      title="Draft a reply"
      align="end"
      className="w-80 p-0"
      trigger={
        <Button type="button" variant="outline" size="sm" disabled={disabled || pending} aria-label="Draft a reply with AI">
          <Sparkles aria-hidden />
          Draft
        </Button>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.instruction}>Anything to tell it? (optional)</Label>
          <Textarea
            id={ids.instruction}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. keep it to two sentences and ask for the account number"
            maxLength={INSTRUCTION_MAX}
            disabled={pending}
            className="min-h-20 text-base md:text-sm"
            aria-describedby={ids.hint}
          />
        </div>
        <p id={ids.hint} className="text-xs text-muted-foreground">
          The draft is written from this ticket&rsquo;s client-visible messages, its category and the macro you have
          selected. Internal notes and attachments are never included. It lands in the reply box for you to edit — you
          save and send it, nothing does that for you.
          {hasExistingText ? " It replaces what is currently in the reply box." : ""}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="button" className="flex-1" onClick={submit} disabled={pending} aria-busy={pending || undefined}>
            <Sparkles aria-hidden />
            {pending ? "Drafting…" : hasExistingText ? "Replace with a draft" : "Draft reply"}
          </Button>
          <Button type="button" variant="ghost" className="flex-1" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
        </div>
      </div>
    </ResponsivePopover>
  );
}
