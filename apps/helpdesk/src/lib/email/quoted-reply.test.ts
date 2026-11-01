import { describe, expect, it } from "vitest";
import { stripQuotedHistory } from "@/lib/email/quoted-reply";
import { fixture, parseRawMessage } from "@/lib/email/__fixtures__/inbound-corpus";

describe("stripQuotedHistory", () => {
  it("leaves a message with no quoted history untouched", () => {
    const text = "Hello,\n\nCould you send the August statement?\n\nThank you,\nMarla";
    expect(stripQuotedHistory(text)).toEqual({ body: text, strippedChars: 0 });
  });

  it("cuts at the Gmail attribution line", () => {
    const text = [
      "That worked, thank you.",
      "",
      "On Mon, Sep 14, 2026 at 11:04 AM Your Service Team <service@example.com> wrote:",
      "> The August statement is attached.",
    ].join("\n");
    const result = stripQuotedHistory(text);
    expect(result.body).toBe("That worked, thank you.");
    expect(result.strippedChars).toBeGreaterThan(0);
  });

  it("cuts at an attribution that Gmail wrapped across two lines", () => {
    const text = [
      "Yes please.",
      "",
      "On Mon, Sep 14, 2026 at 11:04 AM Your Service Team",
      "<service@example.com> wrote:",
      "> body",
    ].join("\n");
    expect(stripQuotedHistory(text).body).toBe("Yes please.");
  });

  it("cuts at the Apple Mail attribution form", () => {
    const text = "Confirmed.\n\nOn 3 Sep 2026, at 09:12, Client Service <service@example.com> wrote:\n\nOld";
    expect(stripQuotedHistory(text).body).toBe("Confirmed.");
  });

  it("cuts at Outlook's underscore rule", () => {
    const text = `Partial, please.\n\n${"_".repeat(32)}\nFrom: Your Service Team\nSent: Thursday\nOld message`;
    expect(stripQuotedHistory(text).body).toBe("Partial, please.");
  });

  it("cuts at an Outlook From:/Sent: header block with no rule above it", () => {
    const text = "Partial, please.\n\nFrom: Your Service Team <ops@example.com>\nSent: Thursday\nTo: Dean\n\nOld";
    expect(stripQuotedHistory(text).body).toBe("Partial, please.");
  });

  it("cuts at -----Original Message----- and at a forwarded-message rule", () => {
    expect(stripQuotedHistory("New text\n\n-----Original Message-----\nFrom: a").body).toBe("New text");
    expect(stripQuotedHistory("New text\n\n---------- Forwarded message ---------\nFrom: a").body).toBe("New text");
  });

  it("cuts at the start of a tail of '>' quoted lines", () => {
    const text = "Short answer: yes.\n\n> previous line one\n>\n> previous line two";
    expect(stripQuotedHistory(text).body).toBe("Short answer: yes.");
  });

  it("does NOT cut at a '>' line that is followed by more original text", () => {
    const text = "You wrote:\n> a point\nand my answer is no.";
    expect(stripQuotedHistory(text).body).toBe(text);
  });

  it("cuts at the RFC 3676 signature delimiter", () => {
    const text = "Please proceed.\n\n--\nMarla Whitfield\nPartner";
    expect(stripQuotedHistory(text).body).toBe("Please proceed.");
  });

  it("cuts at mobile footers", () => {
    expect(stripQuotedHistory("Yes, go ahead.\n\nSent from my iPhone").body).toBe("Yes, go ahead.");
    expect(stripQuotedHistory("Yes, go ahead.\n\nGet Outlook for iOS").body).toBe("Yes, go ahead.");
  });

  it("does not treat a bare '---' paragraph break as history", () => {
    const text = "First point.\n\n---\n\nSecond point, still mine.";
    expect(stripQuotedHistory(text)).toEqual({ body: text, strippedChars: 0 });
  });

  it("does treat '---' as history when quoted material follows it", () => {
    const text = "First point.\n\n---\n> old thread line";
    expect(stripQuotedHistory(text).body).toBe("First point.");
  });

  it("takes the EARLIEST cut when several patterns match", () => {
    const text = [
      "Answer.",
      "",
      "--",
      "Marla",
      "",
      "On Mon, Sep 14, 2026 at 11:04 AM Team <a@b.test> wrote:",
      "> old",
    ].join("\n");
    expect(stripQuotedHistory(text).body).toBe("Answer.");
  });

  it("keeps the whole message when stripping would leave nothing", () => {
    const onlyHistory = "On Mon, Sep 14, 2026 at 11:04 AM Team <a@b.test> wrote:\n> everything is quoted";
    expect(stripQuotedHistory(onlyHistory)).toEqual({ body: onlyHistory, strippedChars: 0 });

    const onlySignature = "--\nMarla Whitfield";
    expect(stripQuotedHistory(onlySignature)).toEqual({ body: onlySignature, strippedChars: 0 });
  });

  it("handles empty and whitespace-only input without throwing", () => {
    expect(stripQuotedHistory("")).toEqual({ body: "", strippedChars: 0 });
    expect(stripQuotedHistory("   \n  ")).toEqual({ body: "   \n  ", strippedChars: 0 });
  });

  it("normalises CRLF before cutting, and reports the characters removed", () => {
    const text = "Answer.\r\n\r\nOn Mon wrote:\r\n> old";
    const result = stripQuotedHistory(text);
    expect(result.body).toBe("Answer.");
    expect(result.strippedChars).toBe("Answer.\n\nOn Mon wrote:\n> old".length - "Answer.".length);
  });

  it("strips the Gmail history out of the corpus reply fixture", () => {
    const { body } = parseRawMessage(fixture("reply-message-id").raw);
    const result = stripQuotedHistory(body);
    expect(result.body).toContain("can you also send July again?");
    expect(result.body).not.toContain("The August statement is attached.");
    expect(result.body).not.toContain("not tax or legal advice");
  });

  it("strips the Outlook history out of the corpus reply fixture", () => {
    const { body } = parseRawMessage(fixture("outlook-quoted-reply").raw);
    const result = stripQuotedHistory(body);
    expect(result.body).toContain("Partial, please. I want to keep the two municipal bonds where they are.");
    expect(result.body).not.toContain("full or partial transfer?");
    expect(result.body).not.toContain("Sent: Thursday");
    // The sender's own sign-off is kept: only the history below Outlook's rule is history.
    expect(result.body).toContain("Dean Okonkwo");
  });
});
