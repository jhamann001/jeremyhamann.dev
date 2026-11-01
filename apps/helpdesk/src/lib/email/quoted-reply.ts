/**
 * Quoted-history and signature stripping — pure.
 *
 * A client replying to "your ticket is resolved" sends back their two sentences plus the entire
 * thread. Storing the whole thing makes every ticket unreadable and re-persists the desk's own
 * disclaimer on every round trip, so the intake path cuts the reply at the first point where the
 * quoted history demonstrably begins.
 *
 * The rule is "earliest confident cut wins": every pattern below proposes an index, the smallest
 * one is taken, and the result is refused if it would leave nothing. **Losing a client's words is
 * far worse than keeping some quoted text**, so an aggressive-looking cut that empties the body is
 * discarded and the full text is kept instead.
 *
 * Covered: Gmail ("On … wrote:", including the two-line wrap Gmail produces at narrow widths),
 * Apple Mail (same shape, "On 3 Sep 2026, at 09:12, … wrote:"), Outlook (the underscore rule plus a
 * From:/Sent:/To: header block, and "-----Original Message-----"), mailing-list style `>` quoting,
 * the RFC 3676 `-- ` signature delimiter, and the mobile "Sent from my …" footers.
 */

export type StripResult = {
  /** The reply text with quoted history and signature removed. Never empty when the input was not. */
  body: string;
  /** Characters removed. 0 when nothing was stripped. */
  strippedChars: number;
};

/** Gmail / Apple Mail attribution line, possibly wrapped across two physical lines. */
const ATTRIBUTION_START = /^\s*(?:On|Am|El|Le)\b.{0,400}$/;
const ATTRIBUTION_END = /\b(?:wrote|schrieb|escribió|a écrit)\s*:\s*$/i;

/** Outlook's separator rules and its English header block. */
const OUTLOOK_RULE = /^\s*_{10,}\s*$/;
const ORIGINAL_MESSAGE = /^\s*-{2,}\s*(?:original message|forwarded message|original-nachricht|mensaje original)\s*-{2,}\s*$/i;
const OUTLOOK_FROM = /^\s*(?:From|Von|De)\s*:\s*\S/;
const OUTLOOK_FOLLOW = /^\s*(?:Sent|Date|To|Subject|Gesendet|An|Betreff|Enviado|Para|Asunto|Envoyé|À|Objet)\s*:/i;

/** RFC 3676 signature delimiter: exactly "--" or "-- " on its own line. */
const SIGNATURE_DELIMITER = /^--[ \t]*$/;

/** Mobile and client footers that always begin a signature block. */
const FOOTER_LINES = [
  /^\s*sent from my (?:iphone|ipad|android|samsung|mobile|blackberry|galaxy)\b/i,
  /^\s*get outlook for (?:ios|android)\b/i,
  /^\s*sent (?:from|via) (?:outlook|gmail|yahoo mail|proton ?mail)\b/i,
  /^\s*enviado desde mi (?:iphone|ipad)\b/i,
];

/** Common "everything below is history" separators some desks and clients emit. */
const EXPLICIT_SEPARATORS = [
  /^\s*-{3,}\s*$/, // a bare horizontal rule, only honoured when quoted material follows (see below)
  /^\s*={10,}\s*$/,
  /^\s*#{3,}\s*(?:please (?:type|reply) above this line|reply above this line)\s*#{3,}\s*$/i,
  /^\s*-{2,}\s*please (?:type your )?reply above this line\s*-{2,}\s*$/i,
];

type LineIndex = { line: number; char: number };

function lineOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [];
  let running = 0;
  for (const line of lines) {
    offsets.push(running);
    running += line.length + 1; // +1 for the "\n" the split consumed
  }
  return offsets;
}

/** True when every non-blank line from `from` onwards is a `>` quote — a tail-quoted history. */
function isQuotedTail(lines: readonly string[], from: number): boolean {
  let sawQuote = false;
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (!/^\s*>/.test(line)) return false;
    sawQuote = true;
  }
  return sawQuote;
}

function firstQuotedTailLine(lines: readonly string[]): number | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*>/.test(lines[i]) && isQuotedTail(lines, i)) return i;
  }
  return null;
}

function attributionCut(lines: readonly string[]): number | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!ATTRIBUTION_START.test(line)) continue;
    if (ATTRIBUTION_END.test(line)) return i;
    // Gmail wraps a long attribution over two lines; the second ends with "wrote:".
    const next = lines[i + 1];
    if (next !== undefined && next.trim().length > 0 && ATTRIBUTION_END.test(next) && next.length < 400) return i;
  }
  return null;
}

function outlookHeaderCut(lines: readonly string[]): number | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (!OUTLOOK_FROM.test(lines[i])) continue;
    // A real Outlook block has at least one of Sent/Date/To/Subject within the next three lines.
    for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j += 1) {
      if (OUTLOOK_FOLLOW.test(lines[j])) return i;
    }
  }
  return null;
}

function separatorCut(lines: readonly string[]): number | null {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (OUTLOOK_RULE.test(line) || ORIGINAL_MESSAGE.test(line)) return i;
    for (const pattern of EXPLICIT_SEPARATORS) {
      if (!pattern.test(line)) continue;
      // A bare `---` only counts as history when quoted or header-shaped material follows it;
      // plenty of people use it as a paragraph break.
      if (/^\s*-{3,}\s*$/.test(line)) {
        const follows = lines.slice(i + 1, i + 6);
        const looksLikeHistory = follows.some(
          (l) => /^\s*>/.test(l) || OUTLOOK_FROM.test(l) || ATTRIBUTION_END.test(l) || OUTLOOK_FOLLOW.test(l),
        );
        if (!looksLikeHistory) continue;
      }
      return i;
    }
  }
  return null;
}

function signatureCut(lines: readonly string[]): number | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (SIGNATURE_DELIMITER.test(lines[i])) return i;
    for (const pattern of FOOTER_LINES) {
      if (pattern.test(lines[i])) return i;
    }
  }
  return null;
}

/**
 * True when the kept text still holds a line the client actually wrote: not blank, not a `>` quote,
 * not an attribution line, not a separator. A cut that leaves only "On Mon … wrote:" has taken the
 * whole message, and the caller keeps the original instead.
 */
function hasSubstance(kept: string): boolean {
  for (const line of kept.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^>/.test(trimmed)) continue;
    if (ATTRIBUTION_START.test(line) && ATTRIBUTION_END.test(line)) continue;
    if (OUTLOOK_RULE.test(line) || ORIGINAL_MESSAGE.test(line) || OUTLOOK_FROM.test(line)) continue;
    if (/^[-_=*]{2,}$/.test(trimmed)) continue;
    return true;
  }
  return false;
}

/**
 * Strips quoted history and the trailing signature from a plain-text mail body.
 *
 * Returns the original text unchanged (and `strippedChars: 0`) when nothing matched, when the cut
 * point is at the very start, or when the cut would leave no readable content — a message that is
 * nothing but a forwarded thread is still the client's message and is stored whole.
 */
export function stripQuotedHistory(text: string): StripResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { body: typeof text === "string" ? text : "", strippedChars: 0 };
  }

  const normalised = text.replace(/\r\n?/g, "\n");
  const lines = normalised.split("\n");
  const offsets = lineOffsets(lines);

  const candidates: LineIndex[] = [];
  const add = (line: number | null): void => {
    if (line === null || line <= 0) return;
    candidates.push({ line, char: offsets[line] });
  };

  add(attributionCut(lines));
  add(outlookHeaderCut(lines));
  add(separatorCut(lines));
  add(firstQuotedTailLine(lines));
  add(signatureCut(lines));

  if (candidates.length === 0) return { body: normalised, strippedChars: 0 };

  const cut = candidates.reduce((best, c) => (c.char < best.char ? c : best));
  const kept = normalised.slice(0, cut.char).replace(/\s+$/, "");
  if (!hasSubstance(kept)) return { body: normalised, strippedChars: 0 };

  return { body: kept, strippedChars: normalised.length - kept.length };
}
