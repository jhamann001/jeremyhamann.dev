// PURE: the tiny markdown subset an AI meeting-prep brief is allowed to use.
//
// The meeting_prep DraftKind asks for exactly six '## ' headings with terse
// bullets under each, so a full markdown library would be all cost and no
// benefit. This parser understands headings, bullets and paragraphs and NOTHING
// else — in particular it never emits raw HTML, so a model that hallucinated a
// <script> tag would render as literal text through React's normal escaping.
// Unit-testable without React.

export type BriefBlock =
  | { kind: "heading"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "paragraph"; text: string };

/** Strip the inline emphasis markers a model sprinkles in (**bold**, *em*, `code`). */
function inline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|$)/g, "$1$2")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

/** Parse a brief into renderable blocks. Never throws; unknown syntax degrades
 *  to a paragraph, so an off-format response is still readable. */
export function parseBrief(text: string): BriefBlock[] {
  const out: BriefBlock[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length > 0) {
      out.push({ kind: "bullets", items: bullets });
      bullets = [];
    }
  };
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flush();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flush();
      out.push({ kind: "heading", text: inline(heading[1]) });
      continue;
    }
    const bullet = line.match(/^(?:[-*•]|\d+\.)\s+(.*)$/);
    if (bullet) {
      bullets.push(inline(bullet[1]));
      continue;
    }
    flush();
    out.push({ kind: "paragraph", text: inline(line) });
  }
  flush();
  return out;
}
