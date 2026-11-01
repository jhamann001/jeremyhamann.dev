/**
 * Link policy and DTO mapping, without a database.
 *
 * The two things worth pinning here are policy, not plumbing: which kinds an operator may create by
 * hand, and which URLs may appear in a link note. Both are refusals a person will meet, so both are
 * stated as cases.
 */
import { describe, expect, it } from "vitest";
import {
  LINK_NOTE_MAX_CHARS,
  LINK_URL_ALLOWLIST,
  MANUAL_LINK_KINDS,
  describeDisallowedUrls,
  disallowedNoteUrls,
  inspectNoteUrls,
  isManualLinkKind,
  liveLinksWhere,
  toTicketLinkDTO,
} from "@/server/ticket-links";
import { TICKET_LINK_INVERSE_LABELS, TICKET_LINK_KINDS, TICKET_LINK_KIND_LABELS } from "@/types/domain";

describe("manual link kinds", () => {
  it("offers RELATED and BLOCKS, and never DUPLICATE_OF", () => {
    expect([...MANUAL_LINK_KINDS]).toEqual(["RELATED", "BLOCKS"]);
    expect(isManualLinkKind("DUPLICATE_OF")).toBe(false);
  });

  it("covers every declared kind in both label maps, so a new kind cannot render blank", () => {
    for (const kind of TICKET_LINK_KINDS) {
      expect(TICKET_LINK_KIND_LABELS[kind]).toBeTruthy();
      expect(TICKET_LINK_INVERSE_LABELS[kind]).toBeTruthy();
      expect(LINK_URL_ALLOWLIST[kind]).toBeDefined();
    }
  });
});

describe("note URL allowlist", () => {
  it("accepts an https link to a firm system", () => {
    expect(disallowedNoteUrls("RELATED", "see https://issues.example.com/cedar-ridge/issue/ticket")).toEqual([]);
    expect(disallowedNoteUrls("RELATED", "https://helpdesk.example.com/tickets/wm/12")).toEqual([]);
  });

  it("refuses a host that is not ours, and names it", () => {
    const bad = disallowedNoteUrls("RELATED", "context at https://pastebin.com/abc123");
    expect(bad).toHaveLength(1);
    expect(bad[0]?.host).toBe("pastebin.com");
    expect(bad[0]?.reason).toBe("host-not-allowed");
    expect(describeDisallowedUrls(bad)).toContain("pastebin.com");
  });

  it("refuses http even on an allowed host — a books-and-records note must not carry one", () => {
    const bad = disallowedNoteUrls("RELATED", "http://issues.example.com/x");
    expect(bad[0]?.reason).toBe("not-https");
    expect(describeDisallowedUrls(bad)).toContain("https");
  });

  it("matches subdomains but never a lookalike suffix", () => {
    expect(disallowedNoteUrls("RELATED", "https://app.issues.example.com/x")).toEqual([]);
    const bad = disallowedNoteUrls("RELATED", "https://issues.example.com.evil.test/x");
    expect(bad).toHaveLength(1);
  });

  it("catches a bare www host, which a person reads as a link", () => {
    const bad = disallowedNoteUrls("RELATED", "www.pastebin.com/abc");
    expect(bad).toHaveLength(1);
    expect(bad[0]?.host).toBe("www.pastebin.com");
  });

  it("ignores trailing sentence punctuation rather than calling it part of the host", () => {
    const [verdict] = inspectNoteUrls("RELATED", "see https://issues.example.com/x.");
    expect(verdict?.url).toBe("https://issues.example.com/x");
    expect(verdict?.allowed).toBe(true);
  });

  it("allows NOTHING on a DUPLICATE_OF link: the link itself is the pointer", () => {
    expect(LINK_URL_ALLOWLIST.DUPLICATE_OF).toEqual([]);
    expect(disallowedNoteUrls("DUPLICATE_OF", "https://issues.example.com/x")).toHaveLength(1);
  });

  it("is quiet about text that merely contains a dot", () => {
    expect(disallowedNoteUrls("RELATED", "Same matter as the 9.30 call with the client.")).toEqual([]);
  });

  it("caps the note so a link row cannot become a comment", () => {
    expect(LINK_NOTE_MAX_CHARS).toBeLessThan(2000);
  });
});

describe("toTicketLinkDTO", () => {
  const from = { id: "t-from", number: 12, subject: "Wire not received", status: "OPEN" as const, queue: { key: "OPERATIONS" as const } };
  const to = { id: "t-to", number: 9, subject: "Wire — original", status: "RESOLVED" as const, queue: { key: "OPERATIONS" as const } };
  const row = {
    id: "link-1",
    kind: "DUPLICATE_OF" as const,
    note: "same wire",
    createdAt: new Date("2026-09-20T12:00:00.000Z"),
    fromTicketId: from.id,
    toTicketId: to.id,
    createdBy: { id: "u1", name: "Ravi", email: "ravi@wm-helpdesk.local", image: null },
    fromTicket: from,
    toTicket: to,
  };

  it("reads outbound from the ticket that owns the link", () => {
    const dto = toTicketLinkDTO(row, from.id);
    expect(dto.inbound).toBe(false);
    expect(dto.otherTicketNumber).toBe(9);
    expect(TICKET_LINK_KIND_LABELS[dto.kind]).toBe("Duplicate of");
  });

  it("reads INVERTED from the other end — one stored row, two correct sentences", () => {
    const dto = toTicketLinkDTO(row, to.id);
    expect(dto.inbound).toBe(true);
    expect(dto.otherTicketNumber).toBe(12);
    expect(TICKET_LINK_INVERSE_LABELS[dto.kind]).toBe("Has duplicate");
  });
});

describe("liveLinksWhere", () => {
  it("covers both directions and excludes soft-removed rows", () => {
    expect(liveLinksWhere("t1")).toEqual({
      removedAt: null,
      OR: [{ fromTicketId: "t1" }, { toTicketId: "t1" }],
    });
  });
});
