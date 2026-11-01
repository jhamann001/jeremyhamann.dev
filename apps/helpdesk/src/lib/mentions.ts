/**
 * `@mention` parsing and resolution — PURE, layer L1 (module map).
 *
 * Imports nothing but types and one shared limit, so it runs identically in a server action, in a
 * client component that highlights a draft, and in a unit test with no database.
 *
 * THREE RULES, and each of them is a decision rather than an implementation detail:
 *
 *  1. **The stored body is never rewritten.** `parseMentions` returns OFFSETS into the text it was
 *     given; nothing here produces a replacement string. A comment is immutable and it is the
 *     record of what the author typed — turning `@mia.ops` into `<@U01ABCDEF>` at write time would
 *     make the ledger's copy of a note differ from the words a person actually wrote, and would rot
 *     the moment someone's Slack id changed. Chips are a RENDER of the stored text (see
 *     `mentionSegments`), never a substitute for it.
 *  2. **A mention is a claim, not a grant.** Resolution matches against a caller-supplied list of
 *     users; it never widens what anyone may read. `@someone` on a ticket they cannot read produces
 *     a notification addressed to a person whose inbox will show them the row without the subject
 *     (the queue check happens where the inbox is read, not here).
 *  3. **Bounded.** At most `WAVE_B_LIMITS.maxMentionsPerComment` tokens are returned. Beyond that
 *     the rest stay plain text, which is what a 20 000-character note pasted from an email thread
 *     full of addresses must not be able to turn into a fan-out.
 */
import type { UserRef } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";

/** One `@token` found in a body, with the offsets of the whole token (the `@` included). */
export type Mention = { handle: string; start: number; end: number };


/**
 * `@` + a handle, optionally followed by `@domain.tld` so a full address is ONE token rather than
 * two. The lookbehind-free left guard is the capture group: a mention starts the string or follows a
 * character that cannot be part of a handle, which is what keeps `user@example.com` (an address in
 * prose, not a mention) and `a@b@c` from matching.
 *
 * Trailing punctuation is trimmed after the match rather than excluded from it: `@mia.ops.` and
 * `@mia.ops,` are how people actually write, and a handle that ends in `.` or `-` is not one.
 *
 * The handle class `[A-Za-z0-9._%+\-]` is the local-part character set of an address, which also
 * covers `first.last`, `mia_ops` and `mia-ops`. It deliberately excludes whitespace, so `@Mia Ops`
 * parses as `@Mia` — a two-word display name is matched by `resolveMentions` through its
 * dot-normalised form (`mia.ops`), not by guessing where a name stops.
 *
 * A LITERAL, written out twice rather than interpolated from a `HANDLE_CHARS` constant: security scanner's
 * "Non-literal regular expression usage" rule (CWE-185) fires on the `new RegExp(x)` call, not on
 * whether `x` was constant. `.source` and `.flags` are byte-identical to
 * what the constructor produced; the accepted set is unchanged.
 */
const MENTION_RE = /(^|[^A-Za-z0-9._%+\-@])@([A-Za-z0-9._%+\-]+(?:@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})?)/g;

/** Characters a handle may not END on; they are punctuation around the token, not part of it. */
const TRAILING_TRIM = /[.\-_%+]+$/;

/**
 * Every `@token` in `body`, in document order, capped at `WAVE_B_LIMITS.maxMentionsPerComment`.
 *
 * Duplicates are kept: `@mia.ops` written twice is two tokens, because the caller renders BOTH as
 * chips. De-duplication is `resolveMentions`'s job, where it is about people rather than about text.
 */
export function parseMentions(body: string): Mention[] {
  if (typeof body !== "string" || body.length === 0) return [];
  const out: Mention[] = [];
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body)) !== null) {
    if (out.length >= WAVE_B_LIMITS.maxMentionsPerComment) break;
    const lead = m[1] ?? "";
    const raw = m[2] ?? "";
    const handle = raw.replace(TRAILING_TRIM, "");
    if (handle.length === 0) continue;
    const start = m.index + lead.length;
    out.push({ handle, start, end: start + 1 + handle.length });
    // Continue scanning from the end of the token we kept, so trimmed punctuation is re-examined as
    // an ordinary separator rather than being swallowed with the match.
    MENTION_RE.lastIndex = start + 1 + handle.length;
  }
  return out;
}

/** Lower-cased, with runs of whitespace collapsed to a single dot: "Mia  Ops" → "mia.ops". */
function normaliseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ".");
}

/** Every spelling of a user a handle is allowed to match. Lower-cased; empties dropped. */
function handlesFor(user: UserRef): string[] {
  const email = user.email.trim().toLowerCase();
  const local = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
  const name = user.name === null ? "" : normaliseName(user.name);
  // The separator-free forms let `@miaops` find "Mia Ops" / `mia.ops@…` without inviting a fuzzy
  // match: they are still exact comparisons, just of a normalised spelling.
  const compact = (s: string): string => s.replace(/[._\-\s]/g, "");
  return [...new Set([email, local, name, compact(local), compact(name)].filter((s) => s.length > 0))];
}

/**
 * The users a body's mentions actually name, de-duplicated by id and in FIRST-MENTION order.
 *
 * Matching is exact against a normalised spelling (full address, address local part, or the display
 * name with whitespace as dots), case-insensitively. It is deliberately not fuzzy: a near-miss that
 * silently notified the wrong colleague about a client matter is worse in every direction than a
 * mention that quietly matches nobody and renders as plain text.
 *
 * `users` is whatever the caller considers mentionable — in `notifyFromEvent` that is the ACTIVE,
 * non-machine staff accounts, which is why a departed colleague's handle notifies no one.
 */
export function resolveMentions(mentions: Mention[], users: Array<UserRef>): UserRef[] {
  return resolveMentionOwners(mentions, users).map((hit) => hit.user);
}

/** One resolved mention: the token that named someone, and who it named. */
export type ResolvedMention = { mention: Mention; user: UserRef };

/**
 * `resolveMentions` with the TOKEN kept beside the person, one entry per user (first mention wins).
 *
 * The notification core needs the offset to cut a readable snippet out of the note, and re-deriving
 * "which `@token` was this person" afterwards means matching handles a second time in a second
 * place — the kind of duplicated normalisation that drifts. `resolveMentions` is the contract's
 * signature and is a projection of this one, so the two can never disagree.
 */
export function resolveMentionOwners(mentions: Mention[], users: Array<UserRef>): ResolvedMention[] {
  if (mentions.length === 0 || users.length === 0) return [];

  const byHandle = new Map<string, UserRef>();
  for (const u of users) {
    for (const h of handlesFor(u)) {
      // First writer wins, so two accounts sharing a display name resolve to one of them
      // deterministically (by the caller's ordering) rather than to whichever came last.
      if (!byHandle.has(h)) byHandle.set(h, u);
    }
  }

  const seen = new Set<string>();
  const out: ResolvedMention[] = [];
  for (const mention of mentions) {
    const hit = byHandle.get(mention.handle.toLowerCase());
    if (hit === undefined || seen.has(hit.id)) continue;
    seen.add(hit.id);
    out.push({ mention, user: hit });
  }
  return out;
}

/** A run of a body: plain text, or a mention that resolved to a real person. */
export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; user: UserRef };

/**
 * Splits `body` into render segments so a chip can be drawn without altering a character of the
 * stored text: concatenating every segment's `text` reproduces `body` exactly (asserted in the
 * tests). An unresolved `@token` comes back as ordinary text, because a chip that points at nobody
 * reads as a person who was told and was not.
 */
export function mentionSegments(body: string, users: Array<UserRef>): MentionSegment[] {
  const mentions = parseMentions(body);
  if (mentions.length === 0) return body.length === 0 ? [] : [{ kind: "text", text: body }];

  // Every spelling of every RESOLVED person, so a second mention of the same colleague — written
  // as the bare handle the first time and as the full address the second — is a chip both times.
  // Resolution still dedupes by person (that is about who is notified); rendering is about text.
  const byHandle = new Map<string, UserRef>();
  for (const hit of resolveMentionOwners(mentions, users)) {
    for (const h of handlesFor(hit.user)) byHandle.set(h, hit.user);
  }

  const out: MentionSegment[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    const user = byHandle.get(mention.handle.toLowerCase());
    if (user === undefined) continue;
    if (mention.start > cursor) out.push({ kind: "text", text: body.slice(cursor, mention.start) });
    out.push({ kind: "mention", text: body.slice(mention.start, mention.end), user });
    cursor = mention.end;
  }
  if (cursor < body.length) out.push({ kind: "text", text: body.slice(cursor) });
  return out;
}
