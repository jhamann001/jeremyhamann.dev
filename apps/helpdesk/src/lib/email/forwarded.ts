/**
 * Forwarded-mail detection — pure, layer L1 (the build record B9, §1.2 `SuspendedIntakeReason
 * += FORWARDED`).
 *
 * A forwarded message is the one inbound shape where the `From` header is CORRECT and still the wrong
 * answer. The person who forwarded it really did send it; the words inside it are somebody else's. Every
 * identity control the intake path has — DMARC, the thread's requester check, the reply token — answers
 * "is the sender who they claim to be", and all three pass. What none of them answers is "whose request
 * is this", and filing a forward as an ordinary message answers it wrongly in a way nothing downstream
 * can correct: `Ticket.requesterEmail` becomes the forwarder, every later staff reply is delivered to
 * the forwarder, and the client API hands the forwarder the thread.
 *
 * So this module does exactly two things, and deliberately not a third:
 *
 *   1. It RECOGNISES the shape — the `Fwd:` / `FW:` subject prefix, and the block markers the four mail
 *      clients that matter actually emit.
 *   2. It PARSES the embedded original `From` / `Date` / `Subject` out of that block, as a CANDIDATE.
 *   3. It never decides anything. `candidateFrom` is a string a human confirms on `/admin/intake`; the
 *      intake path holds the message with reason `FORWARDED` and attributes it to nobody.
 *
 * Nothing here reads the database, the environment or the network, and nothing here throws: the input
 * is unauthenticated mail, so every branch tolerates a missing header, a hostile block and a value that
 * is not a string.
 */
import { parseFromAddress } from "@/lib/email/mailboxes";

/** What one message looks like. `candidateFrom` is a CANDIDATE — never an attribution. */
export type ForwardedAnalysis = {
  isForwarded: boolean;
  /** The addr-spec parsed out of the embedded `From:` line, lower-cased. Null when there is none. */
  candidateFrom: string | null;
  /** The embedded `Subject:` line, or the outer subject with its forward prefixes stripped. */
  originalSubject: string | null;
  /**
   * The embedded `From:` line VERBATIM — display name included, casing untouched.
   *
   * `candidateFrom` is the addr-spec and is lower-cased, because an address is case-insensitive and is
   * stored and compared as such. A person's NAME is not: "Marla Whitfield" lower-cased is a mis-spelled
   * client name on a client-facing record, and the release path has nothing else to take the name from
   * once the block is gone. The line is carried here so `src/server/email-intake.ts` can read the
   * display name off it; nothing here decides anything, exactly as with `candidateFrom`.
   *
   * ADDITIVE and OPTIONAL for the same reason as `originalDate` below — the contract's three-field
   * §10 B9 shape still describes this one.
   */
  candidateFromHeader?: string | null;
  /**
   * The embedded `Date:` / `Sent:` line, verbatim and unparsed.
   *
   * ADDITIVE to the §10 B9 shape, and deliberately OPTIONAL so the contract's three-field type still
   * describes this one. The brief asks for the original From, Date and Subject to be parsed; the Date
   * has no column to land in (`SuspendedIntake` stores the header block, not a parsed original), so it
   * is carried here for the review card rather than dropped. It is never parsed into a `Date`: the
   * string is whatever the forwarding client rendered, in whatever locale, and a wrong instant on a
   * review card is worse than a verbatim one.
   */
  originalDate?: string | null;
};

/**
 * How much of the body is scanned. A forwarded block sits at the top of a message; a marker 64 KB down
 * is inside quoted history, not a header this message is about. The cap also bounds the cost of a
 * hostile body that is one enormous line.
 */
export const FORWARD_SCAN_CHARS = 64_000;

/** Lines examined after a block marker for the embedded header fields. */
export const FORWARD_HEADER_SCAN_LINES = 40;

/** Longest embedded subject kept. Matches `SUBJECT_HARD_MAX` in `src/server/email-intake.ts`. */
const ORIGINAL_SUBJECT_MAX = 2_000;

/** Longest embedded `From:` line kept — the `from` field of `inboundEmailSchema` carries the same cap. */
const ORIGINAL_FROM_MAX = 400;

/**
 * The forward prefixes a subject can carry, including the reply prefixes that legitimately stack in
 * front of them (`Re: Fwd: …`). Only the English and the two European abbreviations that actually reach
 * this desk: `TR:` (French), `WG:` (German). A broader list starts matching ordinary words.
 */
const SUBJECT_PREFIX = /^\s*(?:\[?\s*(?:re|fwd?|fw|tr|wg)\s*\]?\s*:\s*)+/i;

/** Does this subject carry at least one FORWARD prefix (as opposed to only `Re:`)? */
const HAS_FORWARD_PREFIX = /(?:^|\s|\[)(?:fwd|fw|tr|wg)\s*\]?\s*:/i;

/**
 * The block markers. One regex per client rather than one clever regex, because each is a literal
 * string that client emits and the list is the documentation:
 *
 *  - Gmail:        `---------- Forwarded message ---------`
 *  - Apple Mail:   `Begin forwarded message:`
 *  - Outlook:      `-----Original Message-----`
 *  - Outlook web:  a rule of underscores, then `From:` on the next non-empty line
 *  - Thunderbird:  `-------- Forwarded Message --------`
 *
 * The underscore rule is the only one that is not self-describing, so it is the only one that needs a
 * corroborating `From:` line before it counts (see `findBlockStart`).
 */
const NAMED_MARKERS: readonly RegExp[] = [
  /^\s*-{2,}\s*forwarded message\s*-{2,}\s*$/i,
  /^\s*begin forwarded message\s*:?\s*$/i,
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*weitergeleitete nachricht\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*message transféré\s*-{2,}\s*$/i,
];

/** A rule of underscores (Outlook on the web) — only a marker when a `From:` line follows it. */
const UNDERSCORE_RULE = /^\s*_{8,}\s*$/;

/** `From: …` inside the block. Outlook localises nothing here; Gmail and Apple Mail do not either. */
const EMBEDDED_FROM = /^\s*(?:from|von|de|expéditeur)\s*:\s*(.+)$/i;
const EMBEDDED_SUBJECT = /^\s*(?:subject|betreff|objet|asunto)\s*:\s*(.*)$/i;
const EMBEDDED_DATE = /^\s*(?:date|sent|gesendet|envoyé)\s*:\s*(.+)$/i;

/** Lower-cases every key once so a caller can forward whatever casing the MTA used. */
function lower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers === null || typeof headers !== "object") return out;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") continue;
    out[key.trim().toLowerCase()] = value;
  }
  return out;
}

/** The subject with every leading `Re:` / `Fwd:` / `FW:` run removed, collapsed and trimmed. */
export function stripForwardPrefixes(subject: string): string {
  if (typeof subject !== "string") return "";
  return subject.replace(SUBJECT_PREFIX, "").replace(/\s+/g, " ").trim();
}

/** True when the subject carries a FORWARD prefix. A bare `Re:` is a reply, not a forward. */
export function hasForwardSubjectPrefix(subject: string | undefined | null): boolean {
  if (typeof subject !== "string" || subject.length === 0) return false;
  const prefix = SUBJECT_PREFIX.exec(subject);
  return prefix !== null && HAS_FORWARD_PREFIX.test(prefix[0]);
}

/**
 * The index of the line where the forwarded block starts, or -1.
 *
 * A named marker counts on its own. An underscore rule counts only when a `From:` line follows within
 * the next few lines — a rule of underscores is also just a separator somebody typed.
 */
function findBlockStart(lines: readonly string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (NAMED_MARKERS.some((re) => re.test(line))) return i + 1;
    if (UNDERSCORE_RULE.test(line)) {
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        if (lines[j].trim().length === 0) continue;
        if (EMBEDDED_FROM.test(lines[j])) return i + 1;
        break;
      }
    }
  }
  return -1;
}

/**
 * The first embedded header field of each kind, scanned from `start` for at most
 * {@link FORWARD_HEADER_SCAN_LINES} lines.
 *
 * Scanning stops at the first line that is neither blank nor a `Header: value` line AND that comes
 * after at least one field has been read — that boundary is where the block's headers end and the
 * forwarded body begins, and reading past it starts picking up `From:` lines out of quoted prose.
 */
function readEmbeddedHeaders(
  lines: readonly string[],
  start: number,
): { from: string | null; subject: string | null; date: string | null } {
  let from: string | null = null;
  let subject: string | null = null;
  let date: string | null = null;
  let seenAny = false;

  const end = Math.min(lines.length, start + FORWARD_HEADER_SCAN_LINES);
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;

    const fromMatch = EMBEDDED_FROM.exec(line);
    if (fromMatch !== null) {
      seenAny = true;
      if (from === null) from = fromMatch[1].trim();
      continue;
    }
    const subjectMatch = EMBEDDED_SUBJECT.exec(line);
    if (subjectMatch !== null) {
      seenAny = true;
      if (subject === null) subject = subjectMatch[1].trim();
      continue;
    }
    const dateMatch = EMBEDDED_DATE.exec(line);
    if (dateMatch !== null) {
      seenAny = true;
      if (date === null) date = dateMatch[1].trim();
      continue;
    }
    // Any other `Header: value` line (To, Cc, Reply-To…) keeps the block open without being read.
    if (/^\s*[A-Za-z-]{2,40}\s*:\s/.test(line)) {
      seenAny = true;
      continue;
    }
    if (seenAny) break;
  }

  return { from, subject, date };
}

/**
 * Recognises a forwarded message and parses the original sender, subject and date out of its block.
 *
 * `headers` is the forwarded header block in any casing — the outer `Subject` is read from it when the
 * caller has no separate copy. `body` is the already-extracted text body.
 *
 * `isForwarded` is true when EITHER the subject carries a forward prefix OR the body carries a block
 * marker. Both are weak on their own and that is fine: this function reports a shape, and
 * `src/server/email-intake.ts` is where the shape becomes a decision — it holds only when a DISTINCT
 * embedded sender was parsed, because a forward with nobody else in it is the sender's own message and
 * there is no mis-attribution to prevent.
 */
export function analyzeForwarded(headers: Record<string, string>, body: string): ForwardedAnalysis {
  const h = lower(headers);
  const outerSubject = typeof h["subject"] === "string" ? h["subject"] : "";
  const text = (typeof body === "string" ? body : "").slice(0, FORWARD_SCAN_CHARS).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  const prefixed = hasForwardSubjectPrefix(outerSubject);
  const blockStart = findBlockStart(lines);
  const hasBlock = blockStart !== -1;

  if (!prefixed && !hasBlock) {
    return {
      isForwarded: false,
      candidateFrom: null,
      candidateFromHeader: null,
      originalSubject: null,
      originalDate: null,
    };
  }

  // With a block, read from it. Without one — a client that pasted the headers under a `Fwd:` subject
  // and no marker — read from the top of the body, which is where those headers would be.
  const embedded = readEmbeddedHeaders(lines, hasBlock ? blockStart : 0);

  const candidateFrom = embedded.from === null ? null : parseFromAddress(embedded.from);
  const originalSubject = (() => {
    if (embedded.subject !== null && embedded.subject.trim().length > 0) {
      return embedded.subject.replace(/\s+/g, " ").trim().slice(0, ORIGINAL_SUBJECT_MAX);
    }
    const stripped = stripForwardPrefixes(outerSubject);
    return stripped.length === 0 ? null : stripped.slice(0, ORIGINAL_SUBJECT_MAX);
  })();

  return {
    isForwarded: true,
    candidateFrom: candidateFrom === null ? null : candidateFrom.toLowerCase(),
    // Verbatim, so the display name keeps the casing the original sender wrote it in.
    candidateFromHeader:
      embedded.from === null ? null : embedded.from.replace(/\s+/g, " ").trim().slice(0, ORIGINAL_FROM_MAX),
    originalSubject,
    originalDate: embedded.date === null ? null : embedded.date.replace(/\s+/g, " ").trim().slice(0, 200),
  };
}
