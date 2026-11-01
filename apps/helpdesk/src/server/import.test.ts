/**
 * `importTicketCore`'s pure half — the decisions that are made before any Prisma write.
 *
 * The DB-gated file next door proves the rows land with the original clock. This one pins the rules
 * that decide WHAT lands, because each of them is a place where being wrong would be permanent: a
 * comment attributed to the wrong person, an `externalId` that does not collide with its own re-run,
 * a VOIDED ticket conjured by an importer, an attachment the desk's allowlist should have refused.
 */
import { describe, expect, it } from "vitest";
import { ATTACHMENT_MIME_ALLOWLIST, INGEST_LIMITS } from "@/types/domain";
import {
  IMPORT_AUTHOR_PREFIX,
  IMPORT_EXTERNAL_ID_PREFIX,
  attachmentRejection,
  formatImportedAuthorNote,
  importTicketSchema,
  resolveImportAuthor,
  legacyDeskExternalId,
} from "@/server/import";

const USERS = new Map([["dana@wm-helpdesk.local", "u_dana"]]);

function validTicket(over: Record<string, unknown> = {}) {
  return {
    externalId: "zd:4101",
    subject: "Wire did not arrive",
    description: "The wire I sent on Monday has not landed.",
    category: "WIRE_TRANSFER",
    priority: "HIGH",
    status: "OPEN",
    queueKey: "OPERATIONS",
    requesterName: "Pat Client",
    requesterEmail: "pat@example.invalid",
    createdAt: "2026-03-02T09:15:00Z",
    comments: [],
    ...over,
  };
}

describe("legacyDeskExternalId", () => {
  it("is the one place the `zd:` prefix is spelled", () => {
    expect(legacyDeskExternalId(4101)).toBe("zd:4101");
    expect(legacyDeskExternalId(" 4101 ")).toBe("zd:4101");
    expect(legacyDeskExternalId(4101).startsWith(IMPORT_EXTERNAL_ID_PREFIX)).toBe(true);
  });
});

describe("resolveImportAuthor", () => {
  it("keeps a requester's comment a REQUESTER row with no author id", () => {
    const resolved = resolveImportAuthor({ authorKind: "REQUESTER", authorEmail: "pat@example.invalid" }, USERS);
    expect(resolved).toEqual({ authorKind: "REQUESTER", authorId: null, unresolvedName: null });
  });

  it("attributes a staff comment to a real user when the address resolves", () => {
    const resolved = resolveImportAuthor({ authorKind: "STAFF", authorEmail: "Dana@WM-Helpdesk.local" }, USERS);
    expect(resolved).toEqual({ authorKind: "STAFF", authorId: "u_dana", unresolvedName: null });
  });

  it("falls back to SYSTEM when the agent has no row here, carrying the original name", () => {
    // Never a STAFF row with an invented author: that would attribute a client-facing reply to
    // whoever happened to share a name, and `comment_staff_has_author` forbids a STAFF row with none.
    const resolved = resolveImportAuthor(
      { authorKind: "STAFF", authorEmail: "former@nowhere.invalid", authorName: "Former Agent" },
      USERS,
    );
    expect(resolved).toEqual({ authorKind: "SYSTEM", authorId: null, unresolvedName: "Former Agent" });
  });

  it("falls back to SYSTEM with no name when the archive has neither address nor name", () => {
    expect(resolveImportAuthor({ authorKind: "STAFF" }, USERS)).toEqual({
      authorKind: "SYSTEM",
      authorId: null,
      unresolvedName: null,
    });
  });

  it("never resolves a SYSTEM comment to a user, even when the address would match", () => {
    expect(resolveImportAuthor({ authorKind: "SYSTEM", authorEmail: "dana@wm-helpdesk.local" }, USERS)).toMatchObject({
      authorKind: "SYSTEM",
      authorId: null,
    });
  });
});

describe("formatImportedAuthorNote", () => {
  it("puts the original author above the words they wrote", () => {
    const body = formatImportedAuthorNote("Former Agent", "Checking with the custodian.");
    expect(body.startsWith(`_${IMPORT_AUTHOR_PREFIX} Former Agent._`)).toBe(true);
    expect(body).toContain("Checking with the custodian.");
  });
});

describe("attachmentRejection", () => {
  it("accepts every MIME on the allowlist", () => {
    for (const mime of ATTACHMENT_MIME_ALLOWLIST) expect(attachmentRejection({ mime, size: 10 })).toBeNull();
  });

  it("refuses a MIME outside it and an object over the cap (Decision #69)", () => {
    expect(attachmentRejection({ mime: "application/x-msdownload", size: 10 })).toBe("mime-not-allowed");
    expect(attachmentRejection({ mime: "application/pdf", size: INGEST_LIMITS.attachmentMaxBytes + 1 })).toBe(
      "too-large",
    );
  });
});

describe("importTicketSchema", () => {
  it("accepts a minimal well-formed ticket", () => {
    expect(importTicketSchema.parse(validTicket())).toMatchObject({ externalId: "zd:4101", status: "OPEN" });
  });

  it("refuses an externalId that is not namespaced — the receipt's uniqueness depends on it", () => {
    expect(() => importTicketSchema.parse(validTicket({ externalId: "4101" }))).toThrow();
  });

  it("refuses VOIDED: an importer must not be able to make a ticket disappear from the counters", () => {
    expect(() => importTicketSchema.parse(validTicket({ status: "VOIDED" }))).toThrow(/VOIDED/);
  });

  it("mirrors the DB CHECK: at least one of email or phone", () => {
    expect(() => importTicketSchema.parse(validTicket({ requesterEmail: null }))).toThrow();
    expect(importTicketSchema.parse(validTicket({ requesterEmail: null, requesterPhone: "+14155550123" }))).toMatchObject(
      { requesterPhone: "+14155550123" },
    );
  });

  it("refuses a requester phone that is not E.164 and an unparseable timestamp", () => {
    expect(() => importTicketSchema.parse(validTicket({ requesterEmail: null, requesterPhone: "415 555 0123" }))).toThrow();
    expect(() => importTicketSchema.parse(validTicket({ createdAt: "last tuesday" }))).toThrow();
  });

  it("lower-cases the requester address, so the client API's equality check keeps working", () => {
    expect(importTicketSchema.parse(validTicket({ requesterEmail: "PAT@Example.Invalid" })).requesterEmail).toBe(
      "pat@example.invalid",
    );
  });

  it("refuses a REQUESTER comment marked INTERNAL — a client's words are never an internal note", () => {
    const comment = {
      externalId: "zd:1",
      authorKind: "REQUESTER",
      visibility: "INTERNAL",
      body: "hello",
      createdAt: "2026-03-02T09:15:00Z",
    };
    expect(() => importTicketSchema.parse(validTicket({ comments: [comment] }))).toThrow(/PUBLIC/);
    expect(importTicketSchema.parse(validTicket({ comments: [{ ...comment, visibility: "PUBLIC" }] })).comments).toHaveLength(
      1,
    );
  });

  it("accepts the widened fields the contract's ImportTicketInput does not carry", () => {
    const parsed = importTicketSchema.parse(
      validTicket({ resolution: "COMPLETED", isComplaint: true, escalationTarget: "COMPLIANCE", brand: "CEDAR_RIDGE_DIRECT" }),
    );
    expect(parsed).toMatchObject({
      resolution: "COMPLETED",
      isComplaint: true,
      escalationTarget: "COMPLIANCE",
      brand: "CEDAR_RIDGE_DIRECT",
    });
  });

  it("refuses an enum value that is not the desk's", () => {
    expect(() => importTicketSchema.parse(validTicket({ resolution: "SORTED" }))).toThrow();
    expect(() => importTicketSchema.parse(validTicket({ queueKey: "COMPLIANCE" }))).toThrow();
    expect(() => importTicketSchema.parse(validTicket({ priority: "P1" }))).toThrow();
  });
});
