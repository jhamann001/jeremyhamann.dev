import { describe, expect, it } from "vitest";
import { NOTIFICATION_KINDS } from "@/types/domain";
import { assertPiiLight } from "@/jobs/slack";
import { digestMessage, pushPayload, slackDmLine, wmNumber } from "@/server/notifications-templates";


describe("notification templates — PII-light", () => {
  it("every Slack line passes assertPiiLight, for every kind, with and without a link", () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(() => assertPiiLight(slackDmLine({ kind, ticketNumber: 1042, link: null }))).not.toThrow();
      expect(() =>
        assertPiiLight(slackDmLine({ kind, ticketNumber: 1042, link: "https://desk.example.test/tickets/wm/1042" })),
      ).not.toThrow();
      expect(() => assertPiiLight(slackDmLine({ kind, ticketNumber: null, link: null }))).not.toThrow();
    }
  });

  it("the digest passes assertPiiLight, including its ticket list and inbox link", () => {
    const text = digestMessage({
      unread: 7,
      byKind: NOTIFICATION_KINDS.map((kind, i) => ({ kind, count: i + 1 })),
      tickets: [
        { number: 1042, link: "https://desk.example.test/tickets/wm/1042" },
        { number: 1055, link: null },
      ],
      inboxLink: "https://desk.example.test/inbox",
    });
    expect(() => assertPiiLight(text)).not.toThrow();
  });

  it("the push payload carries a label and a number and no free text", () => {
    const payload = pushPayload({ kind: "MENTION", ticketNumber: 1042, path: "/tickets/wm/1042" });
    expect(payload).toEqual({
      title: "WM Help Desk",
      body: "Mentioned you — HD-1042",
      url: "/tickets/wm/1042",
      tag: "wmhd-MENTION-1042",
    });
    const none = pushPayload({ kind: "REVIEW_REQUESTED", ticketNumber: null, path: "/inbox" });
    expect(none.body).toBe("Awaiting your review");
    expect(none.tag).toBe("wmhd-REVIEW_REQUESTED");
  });
});

describe("notification templates — shape", () => {
  it("writes the WM number one way, everywhere", () => {
    expect(wmNumber(1042)).toBe("HD-1042");
    expect(slackDmLine({ kind: "MENTION", ticketNumber: 1042, link: null })).toContain("HD-1042");
  });

  it("links the number when a link is known and prints it bare when it is not", () => {
    expect(slackDmLine({ kind: "REQUESTER_REPLY", ticketNumber: 1042, link: "https://d.test/tickets/wm/1042" })).toBe(
      "WM Help Desk — Client replied on <https://d.test/tickets/wm/1042|HD-1042>.",
    );
    expect(slackDmLine({ kind: "REQUESTER_REPLY", ticketNumber: 1042, link: null })).toBe(
      "WM Help Desk — Client replied on HD-1042.",
    );
    expect(slackDmLine({ kind: "REVIEW_REQUESTED", ticketNumber: null, link: null })).toBe(
      "WM Help Desk — Awaiting your review.",
    );
  });

  it("uses the singular headline for exactly one unread", () => {
    const one = digestMessage({ unread: 1, byKind: [{ kind: "MENTION", count: 1 }], tickets: [], inboxLink: null });
    expect(one.split("\n")[0]).toBe("WM Help Desk — 1 unread notification in your inbox.");
    const many = digestMessage({ unread: 2, byKind: [], tickets: [], inboxLink: null });
    expect(many.split("\n")[0]).toBe("WM Help Desk — 2 unread notifications in your inbox.");
  });

  it("omits the ticket line and the inbox line when there is nothing to put in them", () => {
    const text = digestMessage({ unread: 3, byKind: [{ kind: "ASSIGNED", count: 3 }], tickets: [], inboxLink: null });
    expect(text).toBe(["WM Help Desk — 3 unread notifications in your inbox.", "• 3 × Assigned to you"].join("\n"));
  });
});

// The DRAFT-copy checks that stood here compared this module with the firm's message-approval documents
// (docs/wave-b/messages/), which stay with the firm and were not part of the portfolio import.
