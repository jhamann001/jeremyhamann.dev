import { describe, expect, it } from "vitest";
import { parseBrief } from "@/components/prep/brief-markdown";

// The tiny markdown subset the PrepPanel renders for an AI brief. It must never
// throw on an off-format response (the panel is the only way to read a brief the
// firm already paid to generate) and must never emit raw HTML.

describe("parseBrief", () => {
  it("splits the six headings and their bullets", () => {
    const blocks = parseBrief(
      [
        "## Snapshot",
        "- $2.4M across 3 accounts",
        "- Household stage: Client",
        "",
        "## Talking points",
        "- Confirm the Roth conversion window",
      ].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "heading", text: "Snapshot" },
      {
        kind: "bullets",
        items: ["$2.4M across 3 accounts", "Household stage: Client"],
      },
      { kind: "heading", text: "Talking points" },
      { kind: "bullets", items: ["Confirm the Roth conversion window"] },
    ]);
  });

  it("accepts *, • and numbered bullets", () => {
    const blocks = parseBrief("* one\n• two\n1. three");
    expect(blocks).toEqual([{ kind: "bullets", items: ["one", "two", "three"] }]);
  });

  it("strips inline emphasis markers rather than rendering them literally", () => {
    expect(parseBrief("- **Bold** and *em* and `code`")).toEqual([
      { kind: "bullets", items: ["Bold and em and code"] },
    ]);
  });

  it("degrades unknown syntax to a paragraph instead of dropping it", () => {
    expect(parseBrief("Just a sentence with no marker.")).toEqual([
      { kind: "paragraph", text: "Just a sentence with no marker." },
    ]);
  });

  it("never emits an html block — a hallucinated tag stays literal text", () => {
    const blocks = parseBrief("<script>alert(1)</script>");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "<script>alert(1)</script>" },
    ]);
  });

  it("handles empty and whitespace input without throwing", () => {
    expect(parseBrief("")).toEqual([]);
    expect(parseBrief("\n\n  \n")).toEqual([]);
  });
});
