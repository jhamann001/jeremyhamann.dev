// ticket household email content search: shared, client-safe term rules.
// Literal, case-insensitive matching on subject and retained body. No pattern
// syntax: %, _, regex metacharacters and backslashes are ordinary characters.

export const EMAIL_SEARCH_MIN_LENGTH = 2;
export const EMAIL_SEARCH_MAX_LENGTH = 200;
export const EMAIL_SEARCH_PAGE_SIZE = 50;

// Control characters (C0, DEL, C1) and directional / zero-width formatting code
// points never form part of a search term; they are rejected rather than stripped.
// Numeric ranges (not a character class) keep such code points out of the source.
const DISALLOWED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff],
];
function hasDisallowed(term: string): boolean {
  for (const character of term) {
    const point = character.codePointAt(0) ?? 0;
    if (DISALLOWED_RANGES.some(([low, high]) => point >= low && point <= high)) return true;
  }
  return false;
}

/** Returns the normalized term, or null when it is not searchable. */
export function normalizeEmailSearchTerm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const term = raw.normalize("NFC").trim();
  const length = [...term].length;
  if (length < EMAIL_SEARCH_MIN_LENGTH || length > EMAIL_SEARCH_MAX_LENGTH) return null;
  if (hasDisallowed(term)) return null;
  return term;
}

export type HighlightSegment = { text: string; match: boolean };

// Case-insensitive literal comparison that never trusts index arithmetic across a
// lower-cased copy (lower-casing can change string length for some characters).
function matchesAt(text: string, index: number, needle: string, length: number): boolean {
  return text.slice(index, index + length).toLowerCase() === needle;
}

/** Splits text into plain and matching segments, for rendering as text nodes only. */
export function highlightSegments(text: string | null, term: string | null): HighlightSegment[] {
  if (!text) return [];
  if (!term) return [{ text, match: false }];
  const needle = term.toLowerCase();
  const length = term.length;
  const first = needle[0];
  const segments: HighlightSegment[] = [];
  let plainStart = 0;
  let index = 0;
  while (index <= text.length - length) {
    if (text[index].toLowerCase() === first && matchesAt(text, index, needle, length)) {
      if (index > plainStart) segments.push({ text: text.slice(plainStart, index), match: false });
      segments.push({ text: text.slice(index, index + length), match: true });
      index += length;
      plainStart = index;
    } else {
      index += 1;
    }
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart), match: false });
  return segments;
}

/** A short window of the body around its first match (or its start), whitespace collapsed. */
export function snippetAround(body: string | null, term: string | null, radius = 70): string {
  const clean = (body ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const segments = term ? highlightSegments(clean, term) : [];
  let offset = 0;
  let at = -1;
  for (const segment of segments) {
    if (segment.match) { at = offset; break; }
    offset += segment.text.length;
  }
  if (at < 0) return clean.length > radius * 2 ? `${clean.slice(0, radius * 2)}…` : clean;
  const start = Math.max(0, at - radius);
  const end = Math.min(clean.length, at + (term?.length ?? 0) + radius);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}
