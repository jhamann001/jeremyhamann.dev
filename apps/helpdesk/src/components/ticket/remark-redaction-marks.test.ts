/**
 * S6 — redaction highlighting survives `skipHtml`.
 * The test file is `.ts`, so React elements are built with `createElement`, never JSX.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PII_KINDS, PII_REPLACEMENT_PATTERN } from "@/types/domain";
import { MarkdownRenderer } from "@/components/ticket/markdown-renderer";
import {
  REDACTION_MARK_CLASS,
  REDACTION_TOKEN_PATTERN,
  splitRedactionTokens,
} from "@/components/ticket/remark-redaction-marks";

function render(source: string): string {
  return renderToStaticMarkup(createElement(MarkdownRenderer, { source }));
}

function countMarks(html: string): number {
  return (html.match(/<mark\b/g) ?? []).length;
}

describe("splitRedactionTokens", () => {
  it("returns a single plain segment when there is no token", () => {
    expect(splitRedactionTokens("no tokens here")).toEqual([{ text: "no tokens here", redacted: false }]);
  });

  it("returns [] for the empty string", () => {
    expect(splitRedactionTokens("")).toEqual([]);
  });

  it("splits every §f token shape, keeping surrounding text", () => {
    const input = "SSN [REDACTED:SSN], card [REDACTED:CARD ****1111], acct [REDACTED:ACCOUNT ****6789].";
    expect(splitRedactionTokens(input)).toEqual([
      { text: "SSN ", redacted: false },
      { text: "[REDACTED:SSN]", redacted: true },
      { text: ", card ", redacted: false },
      { text: "[REDACTED:CARD ****1111]", redacted: true },
      { text: ", acct ", redacted: false },
      { text: "[REDACTED:ACCOUNT ****6789]", redacted: true },
      { text: ".", redacted: false },
    ]);
  });

  it("handles a token at the start, at the end, and adjacent tokens", () => {
    expect(splitRedactionTokens("[REDACTED:SSN] first")).toEqual([
      { text: "[REDACTED:SSN]", redacted: true },
      { text: " first", redacted: false },
    ]);
    expect(splitRedactionTokens("last [REDACTED:ACCOUNT ****6789]")).toEqual([
      { text: "last ", redacted: false },
      { text: "[REDACTED:ACCOUNT ****6789]", redacted: true },
    ]);
    expect(splitRedactionTokens("[REDACTED:SSN][REDACTED:SSN]")).toEqual([
      { text: "[REDACTED:SSN]", redacted: true },
      { text: "[REDACTED:SSN]", redacted: true },
    ]);
  });

  it("does not treat look-alikes as tokens", () => {
    for (const s of ["[REDACTED:PHONE]", "[REDACTED:CARD ****11]", "REDACTED:SSN", "[redacted:ssn]", "[REDACTED:CARD 1111]"]) {
      expect(splitRedactionTokens(s).every((seg) => !seg.redacted)).toBe(true);
    }
  });

  /**
   * Decision #116 withdrew ROUTING, DOB, PASSPORT and DL. Redaction is irreversible and nothing is
   * backfilled, so tokens of those four shapes are still sitting in bodies written before the change —
   * and they are NOT marked any more, because the pattern narrowed with `PII_KINDS`. The value is
   * still redacted; only the `<mark>` is gone. Asserted rather than left to be discovered, so that
   * restoring the highlight is a decision somebody takes and this test records.
   */
  it("a token from a withdrawn kind is left unmarked (accepted consequence of Decision #116)", () => {
    for (const kind of ["ROUTING", "DOB", "PASSPORT", "DL"]) {
      const segments = splitRedactionTokens(`before [REDACTED:${kind}] after`);
      expect(segments.every((seg) => !seg.redacted), kind).toBe(true);
    }
  });

  /**
   * The parity pin the build record asked for, and the assertion that
   * would have caught the Wave B drift: this file's literal listed only SSN|CARD|ROUTING|ACCOUNT while
   * `PII_KINDS` had gained DOB, PASSPORT and DL, so those three tokens rendered unmarked. It is what
   * keeps the narrowing to three honest in the other direction too.
   *
   * There are three copies of the pattern in the tree — `@/types/domain`, the exported constant here
   * and the inline literal `splitRedactionTokens` hands to `matchAll` (README §3.4 forbids reaching a
   * matcher with the identifier) — so the pin is load-bearing rather than tidy. The second test goes
   * through `splitRedactionTokens` for the same reason: it must not reach `.match()` with the
   * imported constant.
   */
  it("the client pattern is the source of truth's pattern", () => {
    expect(REDACTION_TOKEN_PATTERN.source).toBe(PII_REPLACEMENT_PATTERN.source);
    expect(REDACTION_TOKEN_PATTERN.flags).toBe(PII_REPLACEMENT_PATTERN.flags);
  });

  it("every PII_KINDS token is marked", () => {
    for (const kind of PII_KINDS) {
      expect(splitRedactionTokens(`a [REDACTED:${kind}] b`).some((seg) => seg.redacted)).toBe(true);
    }
  });

  it("is safe to call repeatedly (the shared /g pattern's lastIndex never leaks between calls)", () => {
    PII_REPLACEMENT_PATTERN.lastIndex = 7;
    const a = splitRedactionTokens("[REDACTED:SSN]");
    const b = splitRedactionTokens("[REDACTED:SSN]");
    expect(a).toEqual(b);
    expect(a[0]?.redacted).toBe(true);
    PII_REPLACEMENT_PATTERN.lastIndex = 0;
  });
});

describe("MarkdownRenderer (react-markdown + skipHtml + remark-redaction-marks)", () => {
  it("wraps each redaction token in <mark> with skipHtml on", () => {
    const html = render("SSN [REDACTED:SSN] and card [REDACTED:CARD ****1111]");
    expect(countMarks(html)).toBe(2);
    expect(html).toContain(`class="${REDACTION_MARK_CLASS}"`);
    expect(html).toContain("<mark class=\"wm-redacted\">[REDACTED:SSN]</mark>");
    expect(html).toContain("<mark class=\"wm-redacted\">[REDACTED:CARD ****1111]</mark>");
    // Surrounding text is preserved outside the marks.
    expect(html).toContain("SSN <mark");
    expect(html).toContain("</mark> and card <mark");
  });

  it("drops raw HTML: a source of <mark>raw</mark> renders no <mark", () => {
    const html = render("<mark>raw</mark>");
    expect(countMarks(html)).toBe(0);
    expect(html).not.toContain("<mark");
  });

  it("also drops other raw HTML (script) and never emits it", () => {
    const html = render("hello <script>alert(1)</script> world");
    expect(html).not.toContain("<script");
    expect(html).toContain("hello");
  });

  it("highlights tokens inside emphasis and list items but leaves code spans alone", () => {
    const html = render("- **bold [REDACTED:SSN]**\n- `code [REDACTED:SSN]`\n\n```\nblock [REDACTED:ACCOUNT ****6789]\n```");
    expect(countMarks(html)).toBe(1);
    expect(html).toContain("<mark class=\"wm-redacted\">[REDACTED:SSN]</mark>");
    expect(html).toContain("<code>code [REDACTED:SSN]</code>");
    expect(html).toContain("block [REDACTED:ACCOUNT ****6789]");
  });

  it("renders links with target=_blank and rel=noopener noreferrer", () => {
    const html = render("see [docs](https://example.com/x)");
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("neutralises javascript: links (default url transform)", () => {
    const html = render("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("renders GFM (strikethrough, tables) without HTML passthrough", () => {
    const html = render("~~gone~~\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("<table>");
  });

  it("renders images as their alt text rather than fetching remote content", () => {
    const html = render("![tracking pixel](https://tracker.example/p.gif)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("[tracking pixel]");
  });
});
