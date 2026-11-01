/**
 * Thread matching helpers — pure.
 *
 * The matching ORDER lives in src/server/email-intake.ts; this module only parses the raw header
 * material it needs: the Message-ID list a client's mail agent echoes back, and the `[HD-<n>]`
 * fallback in the subject. Neither function touches the database and neither decides anything —
 * the subject fallback in particular is worthless on its own and is gated in the server module by
 * "sender address equals the ticket requester AND the message passed DMARC".
 */
import type { ReplyTokenGeneration } from "@/lib/email/reply-token";

/** What the server module concluded. `kind` names which matcher won, for the audit metadata. */
export type ThreadMatch =
  | { kind: "message-id"; ticketId: string }
  /**
   * `generation` says which signing key verified the token: "current", or "previous" while a
   * REPLY_TOKEN_SECRET rotation is still accepting a retired value. It rides on the match so the
   * rotation's tail is measurable — when no message has threaded on "previous" for a while, the
   * retired secret can be dropped from the environment.
   */
  | { kind: "reply-token"; ticketId: string; generation: ReplyTokenGeneration }
  | { kind: "subject"; ticketId: string }
  | { kind: "none" };

/** A References header can legitimately be long; past this we stop reading (a hostile header is bounded). */
export const MAX_MESSAGE_IDS = 50 as const;

/** RFC 5322 msg-id, angle brackets required — anything else in the header is noise (phrases, commas). */
const ANGLE_ADDRESSED = /<([^<>\s]{1,400})>/g;
/** `[HD-123]`, the canonical form the outbound subject carries. */
const BRACKETED_WM = /\[\s*HD-(\d{1,10})\s*\]/i;
/** A bare `HD-123` token, accepted as a looser fallback (see the note on ticketNumberFromSubject). */
const BARE_WM = /(?:^|[^A-Za-z0-9])HD-(\d{1,10})(?![A-Za-z0-9])/i;

/**
 * Every Message-ID in an `In-Reply-To` or `References` header, in header order, **without** the
 * angle brackets, lower-cased, de-duplicated and capped at MAX_MESSAGE_IDS.
 *
 * Brackets are stripped because the stored `MessageDelivery.messageId` form is S3's to choose and
 * the contract's `<wm.…@domain>` notation is ambiguous about them; the intake module therefore
 * queries BOTH the bare and the bracketed spelling of each id it gets back from here, which costs
 * one extra array entry and removes the whole class of "threading silently never matches" bug.
 *
 * A header with no angle brackets at all is treated as a single bare id when it looks like one —
 * some agents emit `In-Reply-To: wm.abc.def@example.com`.
 */
export function parseMessageIdList(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (candidate: string): void => {
    const id = candidate.trim().toLowerCase();
    if (id.length === 0 || id.length > 400 || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  ANGLE_ADDRESSED.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANGLE_ADDRESSED.exec(raw)) !== null) {
    push(match[1]);
    if (out.length >= MAX_MESSAGE_IDS) return out;
  }

  if (out.length === 0) {
    // No brackets anywhere: accept whitespace/comma separated bare ids that contain an `@`.
    for (const piece of raw.split(/[\s,]+/)) {
      if (piece.includes("@") && !piece.includes("<") && !piece.includes(">")) push(piece);
      if (out.length >= MAX_MESSAGE_IDS) break;
    }
  }
  return out;
}

/**
 * The WM number in a subject, or null. `[HD-123]` wins; a bare `HD-123` is accepted as a second
 * pass because mail clients and mailing-list rewriters do strip brackets, and the caller's gate
 * (sender == requester AND dmarc=pass) is what makes this matcher safe rather than the punctuation.
 * A number outside the signed-32-bit range Postgres stores is refused rather than truncated.
 */
export function ticketNumberFromSubject(subject: string): number | null {
  if (typeof subject !== "string" || subject.length === 0) return null;
  const match = BRACKETED_WM.exec(subject) ?? BARE_WM.exec(subject);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) return null;
  return parsed;
}
