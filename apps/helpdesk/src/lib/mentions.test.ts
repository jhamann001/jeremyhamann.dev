import { describe, expect, it } from "vitest";
import type { UserRef } from "@/types/domain";
import { WAVE_B_LIMITS } from "@/types/domain";
import { mentionSegments, parseMentions, resolveMentionOwners, resolveMentions } from "@/lib/mentions";

const mia: UserRef = { id: "u_mia", name: "Mia Ops", email: "mia.ops@wm-helpdesk.local", image: null };
const sam: UserRef = { id: "u_sam", name: "Sam Client-Service", email: "sam.cs@wm-helpdesk.local", image: null };
const noName: UserRef = { id: "u_nn", name: null, email: "pat.adviser@wm-helpdesk.local", image: null };
const USERS = [mia, sam, noName];

describe("parseMentions", () => {
  it("finds bare handles and full addresses, with their offsets", () => {
    const body = "Please check @mia.ops and @sam.cs@wm-helpdesk.local before the cutoff.";
    const found = parseMentions(body);
    expect(found.map((m) => m.handle)).toEqual(["mia.ops", "sam.cs@wm-helpdesk.local"]);
    for (const m of found) expect(body.slice(m.start, m.end)).toBe(`@${m.handle}`);
  });

  it("does not treat an address written in prose as a mention", () => {
    expect(parseMentions("Write to client@example.com about it")).toEqual([]);
    expect(parseMentions("a@b@c")).toEqual([]);
  });

  it("matches at the start of the body and after ordinary punctuation", () => {
    expect(parseMentions("@mia.ops please look").map((m) => m.handle)).toEqual(["mia.ops"]);
    expect(parseMentions("(@mia.ops) and [@sam.cs]").map((m) => m.handle)).toEqual(["mia.ops", "sam.cs"]);
  });

  it("trims trailing punctuation off the handle but keeps the token contiguous", () => {
    const body = "Asked @mia.ops. Then @sam.cs, again.";
    const found = parseMentions(body);
    expect(found.map((m) => m.handle)).toEqual(["mia.ops", "sam.cs"]);
    expect(body.slice(found[0].start, found[0].end)).toBe("@mia.ops");
    expect(body.slice(found[1].start, found[1].end)).toBe("@sam.cs");
  });

  it("is bounded by WAVE_B_LIMITS.maxMentionsPerComment — a pasted thread cannot become a fan-out", () => {
    const body = Array.from({ length: 60 }, (_, i) => `@person.${i}`).join(" ");
    expect(parseMentions(body)).toHaveLength(WAVE_B_LIMITS.maxMentionsPerComment);
  });

  it("returns nothing for an empty body and for a non-string", () => {
    expect(parseMentions("")).toEqual([]);
    expect(parseMentions(undefined as unknown as string)).toEqual([]);
  });
});

describe("resolveMentions", () => {
  it("matches the address, the local part, the display name and a separator-free spelling", () => {
    for (const handle of ["mia.ops@wm-helpdesk.local", "mia.ops", "Mia.Ops", "miaops"]) {
      expect(resolveMentions(parseMentions(`hi @${handle} there`), USERS)).toEqual([mia]);
    }
  });

  it("resolves a user with no display name by their address", () => {
    expect(resolveMentions(parseMentions("@pat.adviser ping"), USERS)).toEqual([noName]);
  });

  it("is exact, never fuzzy — a near miss names nobody", () => {
    expect(resolveMentions(parseMentions("@mia.op and @mia.opss"), USERS)).toEqual([]);
  });

  it("de-duplicates by person, in first-mention order", () => {
    const found = resolveMentions(parseMentions("@sam.cs then @mia.ops then @sam.cs@wm-helpdesk.local"), USERS);
    expect(found).toEqual([sam, mia]);
  });

  it("returns nothing when there is nobody to match against", () => {
    expect(resolveMentions(parseMentions("@mia.ops"), [])).toEqual([]);
    expect(resolveMentions([], USERS)).toEqual([]);
  });

  it("resolveMentionOwners keeps the token beside the person and agrees with resolveMentions", () => {
    const tokens = parseMentions("cc @mia.ops and @sam.cs");
    const owners = resolveMentionOwners(tokens, USERS);
    expect(owners.map((o) => o.user)).toEqual(resolveMentions(tokens, USERS));
    expect(owners[0].mention.handle).toBe("mia.ops");
    expect(owners[1].mention.handle).toBe("sam.cs");
  });
});

describe("mentionSegments", () => {
  it("reproduces the body exactly — the stored text is never rewritten", () => {
    const bodies = [
      "Please check @mia.ops and @sam.cs@wm-helpdesk.local before the cutoff.",
      "@mia.ops",
      "no mentions at all",
      "",
      "edge @mia.ops.",
    ];
    for (const body of bodies) {
      expect(mentionSegments(body, USERS).map((s) => s.text).join("")).toBe(body);
    }
  });

  it("chips a resolved mention and leaves an unresolved one as plain text", () => {
    const segments = mentionSegments("@mia.ops and @nobody.here", USERS);
    const chips = segments.filter((s) => s.kind === "mention");
    expect(chips).toHaveLength(1);
    expect(chips[0].text).toBe("@mia.ops");
    expect(segments.map((s) => s.text).join("")).toBe("@mia.ops and @nobody.here");
  });

  it("chips EVERY spelling of a person mentioned twice", () => {
    const body = "@mia.ops … and again @mia.ops@wm-helpdesk.local";
    const chips = mentionSegments(body, USERS).filter((s) => s.kind === "mention");
    expect(chips.map((s) => s.text)).toEqual(["@mia.ops", "@mia.ops@wm-helpdesk.local"]);
  });
});
