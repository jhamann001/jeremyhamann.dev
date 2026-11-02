import { describe, expect, it } from "vitest";
import {
  EMAIL_SEARCH_MAX_LENGTH, highlightSegments, normalizeEmailSearchTerm, snippetAround,
} from "@/lib/email-search/term";

describe("ticket email search term", () => {
  it("normalizes, trims and bounds the term", () => {
    expect(normalizeEmailSearchTerm("  rebalance  ")).toBe("rebalance");
    expect(normalizeEmailSearchTerm("a")).toBeNull();
    expect(normalizeEmailSearchTerm("   ")).toBeNull();
    expect(normalizeEmailSearchTerm("x".repeat(EMAIL_SEARCH_MAX_LENGTH))).toHaveLength(EMAIL_SEARCH_MAX_LENGTH);
    expect(normalizeEmailSearchTerm("x".repeat(EMAIL_SEARCH_MAX_LENGTH + 1))).toBeNull();
    expect(normalizeEmailSearchTerm(42)).toBeNull();
    expect(normalizeEmailSearchTerm(null)).toBeNull();
    expect(normalizeEmailSearchTerm(`Cafe${String.fromCodePoint(0x0301)}`)).toBe(`Caf${String.fromCodePoint(0x00e9)}`);
  });

  it("rejects control, bidi and zero-width characters instead of stripping them", () => {
    for (const point of [0x0000, 0x000a, 0x202e, 0x200b, 0xfeff, 0x0085, 0x2066]) {
      const raw = `ab${String.fromCodePoint(point)}c`;
      expect(normalizeEmailSearchTerm(raw)).toBeNull();
    }
  });

  it("keeps regex metacharacters, % and _ as literal characters", () => {
    for (const raw of ["50%", "a_b", ".*", "(x|y)", "[a-z]+", "\\d{3}", "$^", "a?b"]) {
      expect(normalizeEmailSearchTerm(raw)).toBe(raw);
    }
  });
});

describe("ticket highlight segments", () => {
  it("matches literally and case-insensitively, splitting text into plain and match segments", () => {
    expect(highlightSegments("Rebalance the REBALANCE plan", "rebalance")).toEqual([
      { text: "Rebalance", match: true }, { text: " the ", match: false },
      { text: "REBALANCE", match: true }, { text: " plan", match: false },
    ]);
  });

  it("treats special characters literally", () => {
    expect(highlightSegments("fee is 50% of a_b, not 50 percent", "50%")).toEqual([
      { text: "fee is ", match: false }, { text: "50%", match: true }, { text: " of a_b, not 50 percent", match: false },
    ]);
    expect(highlightSegments("pattern .* and (x|y)", ".*")).toEqual([
      { text: "pattern ", match: false }, { text: ".*", match: true }, { text: " and (x|y)", match: false },
    ]);
    expect(highlightSegments("abc", "a.c")).toEqual([{ text: "abc", match: false }]);
  });

  it("handles no match, null text, adjacency and non-overlapping repeats", () => {
    expect(highlightSegments("nothing here", "zz")).toEqual([{ text: "nothing here", match: false }]);
    expect(highlightSegments(null, "zz")).toEqual([]);
    expect(highlightSegments("aaaa", "aa")).toEqual([{ text: "aa", match: true }, { text: "aa", match: true }]);
  });

  it("never mis-slices when lower-casing changes string length", () => {
    const segments = highlightSegments("İstanbul review and review", "review");
    expect(segments.map(segment => segment.text).join("")).toBe("İstanbul review and review");
    expect(segments.filter(segment => segment.match).map(segment => segment.text)).toEqual(["review", "review"]);
  });

  it("builds a bounded snippet around the first match", () => {
    const body = `${"lead ".repeat(60)}needle${" tail".repeat(60)}`;
    const snippet = snippetAround(body, "NEEDLE", 20);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBeLessThan(60);
    expect(snippetAround(null, "x")).toBe("");
  });
});
