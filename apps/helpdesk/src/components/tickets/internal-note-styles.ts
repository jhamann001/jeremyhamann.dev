import type { CommentAuthorKind, CommentVisibility } from "@/types/domain";

/**
 * The single source of "yellow" for internal notes.
 * Every surface that styles an INTERNAL comment imports these; nobody re-declares amber classes.
 */
export const INTERNAL_NOTE_CLASSES =
  "border-l-4 border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100 dark:border-amber-500" as const;

export const INTERNAL_BADGE_CLASSES =
  "bg-amber-200 text-amber-950 dark:bg-amber-800 dark:text-amber-50" as const;

export const INTERNAL_NOTE_LABEL = "Internal note — never sent to client" as const;

/**
 * The AUDIENCE of a non-INTERNAL comment, never its delivery state. It must stay true the moment the
 * comment exists — a reply is client-visible as soon as it is saved, whether the outbound copy is
 * Queued, Sending, Sent or Failed — because it is printed beside `DeliveryChip` (the one thing in the
 * app that prints "Sent"), on the composer's Public pane before a character is typed, and on the
 * dashboard preview card. "Sent to client" contradicted all three (the build record S3,
 * binding: nothing says "sent" until a delivery result exists; the build record P16).
 */
export const PUBLIC_REPLY_LABEL = "Client-visible reply" as const;

/**
 * The AUDIENCE/ORIGIN of a non-INTERNAL comment. `PUBLIC` is not one thing: a PUBLIC row is either a
 * reply the desk wrote (outbound), a message the REQUESTER wrote that arrived by email or the client
 * app (inbound), or a SYSTEM row. Branching on `visibility` alone badged a client's own inbound reply
 * as an outbound firm message — a misattribution on a surface a compliance reviewer reads.
 *
 * `authorKind` is on `CommentDTO` for exactly this (contract §1.2), so the badge branches on
 * both. INTERNAL wins over everything: the amber "never sent to client" promise is the claim that
 * matters most and it is true of an internal row whoever authored it.
 */
export type CommentChannel = "INTERNAL" | "OUTBOUND" | "INBOUND" | "SYSTEM";

/** A message the requester wrote. Never carries a Send icon and never claims delivery. */
export const INBOUND_MESSAGE_LABEL = "From client" as const;

/** A PUBLIC row with no human author — an automated acknowledgement or notice. */
export const SYSTEM_MESSAGE_LABEL = "System message" as const;

export function commentChannel(
  visibility: CommentVisibility,
  authorKind: CommentAuthorKind,
): CommentChannel {
  if (visibility === "INTERNAL") return "INTERNAL";
  switch (authorKind) {
    case "REQUESTER":
      return "INBOUND";
    case "SYSTEM":
      return "SYSTEM";
    case "STAFF":
      return "OUTBOUND";
    default: {
      const exhaustive: never = authorKind;
      return exhaustive;
    }
  }
}

/** The one place each channel's badge wording lives, so the timeline and the preview cannot diverge. */
export function commentChannelLabel(channel: CommentChannel): string {
  switch (channel) {
    case "INTERNAL":
      return INTERNAL_NOTE_LABEL;
    case "INBOUND":
      return INBOUND_MESSAGE_LABEL;
    case "SYSTEM":
      return SYSTEM_MESSAGE_LABEL;
    case "OUTBOUND":
      return PUBLIC_REPLY_LABEL;
    default: {
      const exhaustive: never = channel;
      return exhaustive;
    }
  }
}
