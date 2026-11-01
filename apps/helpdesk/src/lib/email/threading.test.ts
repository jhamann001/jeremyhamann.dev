import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_IDS, parseMessageIdList, ticketNumberFromSubject } from "@/lib/email/threading";

describe("parseMessageIdList", () => {
  it("returns a single In-Reply-To id without its angle brackets, lower-cased", () => {
    expect(parseMessageIdList("<WM.abc123.7F31A2@example.com>")).toEqual([
      "wm.abc123.7f31a2@example.com",
    ]);
  });

  it("returns every References entry in header order", () => {
    const raw = "<a@x.test> <b@x.test>\n <c@x.test>";
    expect(parseMessageIdList(raw)).toEqual(["a@x.test", "b@x.test", "c@x.test"]);
  });

  it("de-duplicates while preserving first-seen order", () => {
    expect(parseMessageIdList("<a@x.test> <b@x.test> <A@X.test>")).toEqual(["a@x.test", "b@x.test"]);
  });

  it("ignores phrases, commas and stray text around the ids", () => {
    expect(parseMessageIdList('Marla Whitfield <a@x.test>, "quoted" <b@x.test>;')).toEqual([
      "a@x.test",
      "b@x.test",
    ]);
  });

  it("accepts bare ids when the header carries no angle brackets at all", () => {
    expect(parseMessageIdList("wm.abc.def@example.com")).toEqual(["wm.abc.def@example.com"]);
    expect(parseMessageIdList("a@x.test, b@x.test")).toEqual(["a@x.test", "b@x.test"]);
  });

  it("returns [] for absent, empty or whitespace-only input", () => {
    expect(parseMessageIdList(null)).toEqual([]);
    expect(parseMessageIdList(undefined)).toEqual([]);
    expect(parseMessageIdList("")).toEqual([]);
    expect(parseMessageIdList("   \n ")).toEqual([]);
  });

  it("caps a hostile References header at MAX_MESSAGE_IDS", () => {
    const raw = Array.from({ length: MAX_MESSAGE_IDS + 40 }, (_, i) => `<id${i}@x.test>`).join(" ");
    expect(parseMessageIdList(raw)).toHaveLength(MAX_MESSAGE_IDS);
  });

  it("drops an absurdly long id rather than storing it", () => {
    expect(parseMessageIdList(`<${"a".repeat(500)}@x.test>`)).toEqual([]);
  });
});

describe("ticketNumberFromSubject", () => {
  it("reads the bracketed form the outbound subject carries", () => {
    expect(ticketNumberFromSubject("[HD-1041] Statement request")).toBe(1041);
    expect(ticketNumberFromSubject("Re: [HD-1041] Statement request")).toBe(1041);
    expect(ticketNumberFromSubject("RE: FW: [hd-7] tiny")).toBe(7);
    expect(ticketNumberFromSubject("Statement request [HD-1041]")).toBe(1041);
  });

  it("tolerates whitespace inside the brackets", () => {
    expect(ticketNumberFromSubject("[ HD-204 ] hello")).toBe(204);
  });

  it("accepts a bare HD-n when a rewriter stripped the brackets", () => {
    expect(ticketNumberFromSubject("Re: HD-1041 Statement request")).toBe(1041);
  });

  it("prefers the bracketed number when both appear", () => {
    expect(ticketNumberFromSubject("HD-9 ... [HD-1041] ...")).toBe(1041);
  });

  it("returns null when there is no WM reference", () => {
    expect(ticketNumberFromSubject("Statement request")).toBeNull();
    expect(ticketNumberFromSubject("")).toBeNull();
    expect(ticketNumberFromSubject("[HD-] empty")).toBeNull();
  });

  it("does not read a longer token as a ticket number", () => {
    expect(ticketNumberFromSubject("order SWM-1041 shipped")).toBeNull();
    expect(ticketNumberFromSubject("HD-1041A")).toBeNull();
  });

  it("refuses a number outside the storable range instead of truncating it", () => {
    expect(ticketNumberFromSubject("[HD-3000000000]")).toBeNull();
    expect(ticketNumberFromSubject("[HD-0]")).toBeNull();
  });
});
