/**
 * Mention chips survive `skipHtml`, and an INTERNAL note keeps everything it had (integration round 1).
 *
 * The file is `.ts`, so React elements are built with `createElement`, never JSX — the same constraint
 * `remark-redaction-marks.test.ts` documents.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseMentions } from "@/lib/mentions";
import { MarkdownRenderer } from "@/components/ticket/markdown-renderer";
import { MENTION_CHIP_CLASS, splitMentionTokens } from "@/components/ticket/remark-mention-marks";

function render(source: string, mentions: boolean): string {
  return renderToStaticMarkup(createElement(MarkdownRenderer, { source, mentions }));
}

/**
 * Occurrences of the chip's class attribute, counted by SCANNING rather than by matching.
 *
 * `html.match(new RegExp(`class="${MENTION_CHIP_CLASS}"`, "g"))` was a security scanner CWE-185 finding:
 * a pattern assembled from a value at run time. The needle is a fixed
 * string with no pattern syntax in it, so the build record's "prefer `includes` / `split`
 * over a constructed regex" applies exactly — `split(needle).length - 1` is the same count.
 */
function countChips(html: string): number {
  return html.split(`class="${MENTION_CHIP_CLASS}"`).length - 1;
}

describe("splitMentionTokens", () => {
  it("returns one plain segment when there is no mention", () => {
    expect(splitMentionTokens("no handles here")).toEqual([{ text: "no handles here", mention: false }]);
  });

  it("returns [] for the empty string", () => {
    expect(splitMentionTokens("")).toEqual([]);
  });

  it("splits a mention out of surrounding text", () => {
    expect(splitMentionTokens("please look @mia.ops thanks")).toEqual([
      { text: "please look ", mention: false },
      { text: "@mia.ops", mention: true },
      { text: " thanks", mention: false },
    ]);
  });

  it("concatenating the segments reproduces the input exactly — the text is the record (I8)", () => {
    for (const source of [
      "",
      "plain",
      "@mia.ops",
      "hi @mia.ops and @dana.cs, see HD-14.",
      "an address in prose: someone@example.com is not a mention",
      "trailing punctuation @mia.ops, and @dana.cs.",
    ]) {
      expect(splitMentionTokens(source).map((s) => s.text).join("")).toBe(source);
    }
  });

  it("chips exactly what `parseMentions` found — one vocabulary, not two regexes", () => {
    const source = "hi @mia.ops and @dana.cs — not someone@example.com";
    const chipped = splitMentionTokens(source).filter((s) => s.mention).map((s) => s.text);
    const parsed = parseMentions(source).map((m) => source.slice(m.start, m.end));
    expect(chipped).toEqual(parsed);
    expect(chipped).toEqual(["@mia.ops", "@dana.cs"]);
  });
});

describe("remarkMentionMarks through MarkdownRenderer", () => {
  it("chips a mention when `mentions` is on, and leaves it plain when it is off", () => {
    const source = "please check @mia.ops";
    expect(countChips(render(source, true))).toBe(1);
    expect(countChips(render(source, false))).toBe(0);
    // Either way the words survive.
    expect(render(source, true)).toContain("@mia.ops");
    expect(render(source, false)).toContain("@mia.ops");
  });

  it("never chips inside code — a handle in backticks is a literal", () => {
    expect(countChips(render("run `notify @mia.ops` now", true))).toBe(0);
    expect(countChips(render("```\n@mia.ops\n```", true))).toBe(0);
  });

  it("keeps markdown AND redaction marks on the same body — the whole reason this is a plugin", () => {
    const html = render("**urgent** for @mia.ops — SSN [REDACTED:SSN]\n\n- one\n- two", true);
    expect(html).toContain("<strong>");
    expect(html).toContain("<li>");
    expect(html).toMatch(/<mark\b/);
    expect(countChips(html)).toBe(1);
  });

  it("does not chip an ordinary address written in prose", () => {
    expect(countChips(render("the client wrote from someone@example.com", true))).toBe(0);
  });

  it("a hand-written chip in the source is dropped as HTML — `skipHtml` still governs", () => {
    const html = render('<span class="wm-mention" data-evil="1">@fake</span> and @mia.ops', true);
    // The author's TAGS are gone: no attribute they wrote reaches the document.
    expect(html).not.toContain("data-evil");
    expect(html).not.toContain("&lt;span");
    // What survives is the tag's TEXT, `@fake`, and it is then chipped for the only reason any token
    // is chipped — it is a real mention token. That is the same outcome as typing `@fake` plainly, so
    // there is nothing here an author could not already do, and no HTML of theirs was rendered.
    expect(countChips(html)).toBe(2);
    expect(html).toContain("@fake");
    expect(html).toContain("@mia.ops");
  });
});
