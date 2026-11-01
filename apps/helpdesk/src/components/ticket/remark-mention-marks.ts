/**
 * remark plugin that chips `@mentions` in an INTERNAL note's markdown (integration round 1).
 *
 * WHY THIS EXISTS RATHER THAN `MentionText` ON THE TIMELINE.
 * the build record asks the integrator to render B1's
 * `MentionText` where `src/components/ticket/comment-item.tsx` draws an INTERNAL body. Done literally,
 * that would REPLACE `MarkdownRenderer` for exactly the comments most likely to need it, and take two
 * things with it: markdown (an internal note is where the desk writes lists, links and code), and the
 * `<mark>` on `[REDACTED:…]` tokens that `remark-redaction-marks.ts` produces — on the channel where a
 * redaction is most likely to appear, and in the same round that widened redaction to seven kinds.
 *
 * So the mention pass is a SECOND mdast plugin beside the redaction one instead: an internal note keeps
 * its markdown, keeps its redaction marks, and gains its mention chips. `MentionText` is unchanged and
 * is still B1's renderer wherever a body is drawn as plain text (the composer preview, the inbox).
 *
 * The vocabulary is `parseMentions` from `@/lib/mentions` — B1's parser, not a second regex — so the
 * token this chips is exactly the token that produced the `Notification` row. A chip on a token nobody
 * was told about, or a told person with no chip, would be worse than no chip at all.
 *
 * THE TEXT IS THE RECORD. Like the redaction plugin this is a RENDER and never an edit: concatenating
 * the segments of a rewritten node reproduces its value exactly.
 *
 * `inlineCode` and `code` are literals, not `text` nodes, so `@handle` inside backticks is never
 * touched; a node already marked (`data.hName` set) is skipped so redaction marks and mention chips
 * cannot wrap each other.
 *
 * Pure, L1-safe: it imports the parser and types, nothing else. No new dependency — the tree is walked
 * by hand, exactly as `remark-redaction-marks.ts` does.
 */
import type { Root, RootContent, Text } from "mdast";
import type { Plugin } from "unified";
import { parseMentions } from "@/lib/mentions";

export const MENTION_CHIP_CLASS = "wm-mention" as const;

export type MentionSegment = { text: string; mention: boolean };

/**
 * Splits a string into alternating plain / mention segments (empty plain segments are dropped).
 * Shared by the plugin and its test.
 */
export function splitMentionTokens(value: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let cursor = 0;
  for (const m of parseMentions(value)) {
    if (m.start > cursor) out.push({ text: value.slice(cursor, m.start), mention: false });
    out.push({ text: value.slice(m.start, m.end), mention: true });
    cursor = m.end;
  }
  if (cursor < value.length) out.push({ text: value.slice(cursor), mention: false });
  return out;
}

type NodeWithData = { type: string; data?: { hName?: unknown } | undefined };
type ParentLike = { children: RootContent[] };

function isParent(node: unknown): node is ParentLike {
  return typeof node === "object" && node !== null && Array.isArray((node as { children?: unknown }).children);
}

function isRewritten(node: NodeWithData): boolean {
  return node.data?.hName !== undefined;
}

function chipNode(value: string): Text {
  const node: Text = { type: "text", value };
  // Same mechanism and the same caveat as `remark-redaction-marks.ts`: `hName` / `hProperties` are
  // declared on mdast `Data` by mdast-util-to-hast's module augmentation, and the cast keeps this file
  // compiling when that augmentation is not part of the current program. `<span>` rather than `<mark>`
  // because a mention is not a redaction — `skipHtml` removes raw HTML, so this is the only route.
  node.data = { hName: "span", hProperties: { className: [MENTION_CHIP_CLASS], "data-mention": "" } } as Text["data"];
  return node;
}

/** Rewrites one text node into segments; returns null when the value holds no mention. */
function splitTextNode(node: Text): RootContent[] | null {
  const segments = splitMentionTokens(node.value);
  if (!segments.some((s) => s.mention)) return null;
  return segments.map((s): RootContent => (s.mention ? chipNode(s.text) : { type: "text", value: s.text }));
}

function walk(parent: ParentLike): void {
  const next: RootContent[] = [];
  let changed = false;
  for (const child of parent.children) {
    if (child.type === "text" && !isRewritten(child)) {
      const replacement = splitTextNode(child);
      if (replacement) {
        next.push(...replacement);
        changed = true;
        continue;
      }
    } else if (child.type !== "inlineCode" && child.type !== "code" && !isRewritten(child) && isParent(child)) {
      walk(child);
    }
    next.push(child);
  }
  if (changed) parent.children = next;
}

/** Chips `@mention` tokens at the mdast level, so they survive `skipHtml`. */
export const remarkMentionMarks: Plugin<[], Root> = function remarkMentionMarks() {
  return (tree: Root): void => {
    walk(tree);
  };
};
