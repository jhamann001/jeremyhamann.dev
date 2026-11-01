/**
 * remark plugin that highlights PII redaction tokens.
 *
 * `MarkdownRenderer` runs react-markdown with `skipHtml`, so `<mark>` cannot be injected into the
 * markdown source — it would be stripped. Instead this plugin rewrites the mdast: every `text` node
 * whose value contains a `[REDACTED:…]` token is split into alternating plain `text` nodes and token
 * `text` nodes carrying `data.hName = "mark"`, which mdast-util-to-hast turns into `<mark>` elements.
 *
 * Pure and layer-L1-safe (type-only imports now that the token pattern is a local literal — see
 * `REDACTION_TOKEN_PATTERN`). No new dependency: the tree is walked
 * by hand rather than through `unist-util-visit`. `inlineCode` / `code` are literals, not `text`
 * nodes, so they are never touched; children of a node already marked (`data.hName === "mark"`) are
 * skipped so a second pass cannot double-wrap.
 */
import type { Root, RootContent, Text } from "mdast";
import type { Plugin } from "unified";

export const REDACTION_MARK_CLASS = "wm-redacted" as const;

export type RedactionSegment = { text: string; redacted: boolean };

/**
 * The redaction-token pattern, written out as a LITERAL.
 *
 * It used to be `new RegExp(PII_REPLACEMENT_PATTERN.source, "g")`, rebuilt per call so the exported
 * `/g` pattern's `lastIndex` could not leak between calls. security scanner SAST "Non-literal regular expression
 * usage leading to ReDoS" (CWE-185) fires on any `new RegExp(x)` whose argument is not a literal
 * string — a `.source` read is not a literal, and a helper that built it once at module load would
 * not be one either. A second literal is the prescribed fix.
 *
 * It also removes the statefulness outright rather than working around it: nothing here calls
 * `.exec` / `.test` on this object, so its `lastIndex` stays 0, and `String.prototype.matchAll`
 * clones the regex rather than advancing it. `PII_REPLACEMENT_PATTERN` may now carry any `lastIndex`
 * at all without changing what this function returns — which is what the existing "safe to call
 * repeatedly" test asserts.
 *
 * Linear and fully bounded (CWE-1333): a fixed alternation of three literal words, one optional group,
 * and `\*{4}\d{4}` — no nested quantifier, no unbounded `.*`, nothing that can backtrack.
 *
 * MUST stay character-for-character identical to `PII_REPLACEMENT_PATTERN` in `@/types/domain`, the
 * source of truth for the token shape `src/lib/pii.ts` writes. Exported so a test can pin the two
 * sources equal
 *
 * IT HAS DRIFTED BEFORE, in both directions, and the pin §5 asked for is what catches it. Wave B
 * widened the kind list to seven while this copy still listed four, so a `[REDACTED:DOB]` rendered
 * as ordinary text with no redaction mark. Decision #116 narrows the list to three (SSN, CARD,
 * ACCOUNT) and this literal narrows with it.
 *
 * KNOWN CONSEQUENCE, accepted rather than hidden: redaction is irreversible and nothing is
 * backfilled, so `[REDACTED:ROUTING]`, `[REDACTED:DOB]`, `[REDACTED:PASSPORT]` and `[REDACTED:DL]`
 * tokens written before Decision #116 are still in stored bodies — and they no longer get a
 * `<mark>`. The value is still redacted; only the highlight is missing. Widening THIS literal to the
 * seven historical names would restore the highlight without changing what is redacted, but it would
 * also break the character-for-character pin above, so it is a deliberate decision for the desk to
 * take rather than a drift to fix silently.
 *
 * It is NOT what `splitRedactionTokens` passes to `matchAll`. CWE-185 fires on the matcher, not only
 * on a `new RegExp`: a pattern reaching `.matchAll()` / `.match()` as an identifier is reported even
 * when the identifier is a literal. So the scan below carries its own copy
 * of the same literal, and this export is the constant a parity assertion pins — the shape §3.4
 * prescribes, and the reason the pin in §5 is worth having rather than optional.
 */
export const REDACTION_TOKEN_PATTERN = /\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g;

/**
 * Splits a string into alternating plain / redaction-token segments (empty plain segments are
 * dropped). Shared by the plugin and its test.
 */
export function splitRedactionTokens(value: string): RedactionSegment[] {
  const out: RedactionSegment[] = [];
  let last = 0;
  // The literal, inline — see `REDACTION_TOKEN_PATTERN` above for why it is not the identifier.
  for (const m of value.matchAll(/\[REDACTED:(SSN|CARD|ACCOUNT)(?: \*{4}\d{4})?\]/g)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: value.slice(last, start), redacted: false });
    out.push({ text: m[0], redacted: true });
    last = start + m[0].length;
  }
  if (last < value.length) out.push({ text: value.slice(last), redacted: false });
  return out;
}

type NodeWithData = { type: string; data?: { hName?: unknown } | undefined };
type ParentLike = { children: RootContent[] };

function isParent(node: unknown): node is ParentLike {
  return (
    typeof node === "object" &&
    node !== null &&
    Array.isArray((node as { children?: unknown }).children)
  );
}

function isMarkNode(node: NodeWithData): boolean {
  return node.data?.hName === "mark";
}

function markNode(value: string): Text {
  const node: Text = { type: "text", value };
  // `hName` / `hProperties` are declared on mdast `Data` by mdast-util-to-hast's module augmentation
  // (a transitive dependency of react-markdown). The cast keeps this file compiling even when that
  // augmentation is not part of the current program.
  node.data = { hName: "mark", hProperties: { className: [REDACTION_MARK_CLASS] } } as Text["data"];
  return node;
}

/** Rewrites one text node into segments; returns null when the value has no token. */
function splitTextNode(node: Text): RootContent[] | null {
  const segments = splitRedactionTokens(node.value);
  if (!segments.some((s) => s.redacted)) return null;
  return segments.map((s): RootContent => (s.redacted ? markNode(s.text) : { type: "text", value: s.text }));
}

function walk(parent: ParentLike): void {
  const next: RootContent[] = [];
  let changed = false;
  for (const child of parent.children) {
    if (child.type === "text" && !isMarkNode(child)) {
      const replacement = splitTextNode(child);
      if (replacement) {
        next.push(...replacement);
        changed = true;
        continue;
      }
    } else if (child.type !== "inlineCode" && child.type !== "code" && !isMarkNode(child) && isParent(child)) {
      walk(child);
    }
    next.push(child);
  }
  if (changed) parent.children = next;
}

/** Wraps `[REDACTED:…]` tokens in `<mark class="wm-redacted">` at the mdast level (survives `skipHtml`). */
export const remarkRedactionMarks: Plugin<[], Root> = function remarkRedactionMarks() {
  return (tree: Root): void => {
    walk(tree);
  };
};
