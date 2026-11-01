import type { UserRef } from "@/types/domain";
import { mentionSegments, parseMentions } from "@/lib/mentions";
import { cn } from "@/lib/utils";

export type MentionTextProps = {
  /** The STORED body, verbatim. Nothing here rewrites it. */
  body: string;
  /**
   * Who may be mentioned. When omitted, every parsed `@token` is chipped without claiming to name a
   * particular person — which is honest on a surface that has no directory to hand, and is what the
   * composer's live preview needs.
   */
  users?: UserRef[];
  className?: string;
};

/**
 * Renders an INTERNAL note's `@mentions` as chips without altering a character of the stored text
 * (`src/lib/mentions.ts` is the parser).
 *
 * THE TEXT IS THE RECORD. A comment is immutable and the ledger's copy has to be the words the
 * author typed, so this is a RENDER: concatenating every segment reproduces the body exactly, and
 * an unresolved token comes back as ordinary text rather than as a chip pointing at nobody.
 *
 * PUBLIC replies are deliberately not passed through this: an `@` in a client-facing message is a
 * typo or an address the client wrote, never a desk instruction, and chipping it would tell a
 * reader that a colleague had been notified when nobody had.
 *
 * It is a plain component with no `"use client"` directive, so it renders on either side of the
 * boundary — the timeline is a server render and the composer preview is a client one.
 */
export function MentionText({ body, users, className }: MentionTextProps): React.JSX.Element {
  const segments: RenderSegment[] =
    users === undefined || users.length === 0
      ? unresolvedSegments(body)
      : mentionSegments(body, users).map((s) =>
          s.kind === "text" ? { kind: "text", text: s.text } : { kind: "mention", text: s.text, email: s.user.email },
        );

  return (
    <span className={cn("break-words whitespace-pre-wrap", className)} data-slice="B1-mentions">
      {segments.map((segment, i) =>
        segment.kind === "text" ? (
          <span key={i}>{segment.text}</span>
        ) : (
          <span
            key={i}
            data-mention
            title={segment.email}
            className="rounded-sm bg-primary/10 px-1 font-medium text-primary"
          >
            {segment.text}
          </span>
        ),
      )}
    </span>
  );
}

/**
 * One render run. `email` is present only when the token resolved to a real person — a chip with no
 * address behind it marks the TOKEN and claims nothing about who, if anyone, was told.
 */
type RenderSegment = { kind: "text"; text: string } | { kind: "mention"; text: string; email?: string };

/** Chips for every parsed token, when there is no directory to resolve them against. */
function unresolvedSegments(body: string): RenderSegment[] {
  const out: RenderSegment[] = [];
  let cursor = 0;
  for (const mention of parseMentions(body)) {
    if (mention.start > cursor) out.push({ kind: "text", text: body.slice(cursor, mention.start) });
    out.push({ kind: "mention", text: body.slice(mention.start, mention.end) });
    cursor = mention.end;
  }
  if (cursor < body.length) out.push({ kind: "text", text: body.slice(cursor) });
  return out;
}
