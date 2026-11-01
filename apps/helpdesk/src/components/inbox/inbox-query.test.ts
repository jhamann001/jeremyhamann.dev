import { describe, expect, it } from "vitest";
import type { InboxPage, NotificationDTO } from "@/types/domain";
import {
  flattenRows,
  groupRows,
  inboxHref,
  mergePage,
  parseInboxFilters,
} from "@/components/inbox/inbox-query";

function row(id: string, createdAt: string): NotificationDTO {
  return {
    id,
    kind: "MENTION",
    preview: `preview ${id}`,
    createdAt,
    readAt: null,
    dismissedAt: null,
    actor: null,
    ticketId: "t1",
    ticketNumber: 1,
    ticketSubject: "s",
    commentId: null,
    channels: ["IN_APP"],
  };
}

function page(rows: NotificationDTO[], nextCursor: string | null): InboxPage {
  return { rows, unread: rows.length, nextCursor };
}

describe("parseInboxFilters", () => {
  it("defaults to unread-only — the inbox is a work list", () => {
    expect(parseInboxFilters({})).toEqual({ kind: undefined, unreadOnly: true, cursor: undefined });
  });

  it("`?unread=0` widens it to everything", () => {
    expect(parseInboxFilters({ unread: "0" }).unreadOnly).toBe(false);
    // Anything else means the default, rather than being refused.
    expect(parseInboxFilters({ unread: "yes" }).unreadOnly).toBe(true);
  });

  it("keeps a known kind and drops an unknown one", () => {
    expect(parseInboxFilters({ kind: "MENTION" }).kind).toBe("MENTION");
    expect(parseInboxFilters({ kind: "NOPE" }).kind).toBeUndefined();
  });

  it("takes the first value of a repeated key, like every other reader (convention 12)", () => {
    expect(parseInboxFilters({ kind: ["ASSIGNED", "MENTION"] }).kind).toBe("ASSIGNED");
  });

  it("treats an empty cursor as absent", () => {
    expect(parseInboxFilters({ cursor: "" }).cursor).toBeUndefined();
    expect(parseInboxFilters({ cursor: "2026-09-20T00:00:00.000Z|abc" }).cursor).toBe("2026-09-20T00:00:00.000Z|abc");
  });
});

describe("inboxHref", () => {
  it("writes nothing for the default view", () => {
    expect(inboxHref({ unreadOnly: true })).toBe("/inbox");
  });

  it("round-trips through parseInboxFilters", () => {
    const cases = [
      { kind: undefined, unreadOnly: true, cursor: undefined },
      { kind: "MENTION" as const, unreadOnly: false, cursor: undefined },
      { kind: "SLA_BREACH" as const, unreadOnly: true, cursor: "2026-09-20T00:00:00.000Z|abc" },
    ];
    for (const filters of cases) {
      const href = inboxHref(filters);
      const qs = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
      const sp = Object.fromEntries(new URLSearchParams(qs).entries());
      expect(parseInboxFilters(sp), href).toEqual(filters);
    }
  });
});

describe("mergePage / flattenRows", () => {
  const first = page([row("a", "2026-09-20T12:00:00.000Z"), row("b", "2026-09-20T11:00:00.000Z")], "cursor-1");
  const second = page([row("c", "2026-09-19T12:00:00.000Z")], null);

  it("a cursored page that continues the one on screen GROWS the list", () => {
    const acc1 = mergePage(null, first, undefined, "/inbox");
    const acc2 = mergePage(acc1, second, "cursor-1", "/inbox");
    expect(flattenRows(acc2.chunks).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("the same cursor rendered again REPLACES that page in place (a refresh after Mark all read)", () => {
    const acc1 = mergePage(null, first, undefined, "/inbox");
    const refreshed = page([row("a", "2026-09-20T12:00:00.000Z")], "cursor-1");
    const acc2 = mergePage(acc1, refreshed, undefined, "/inbox");
    expect(acc2.chunks).toHaveLength(1);
    expect(flattenRows(acc2.chunks).map((r) => r.id)).toEqual(["a"]);
  });

  it("a different filter starts over — a new filter is a new result set", () => {
    const acc1 = mergePage(null, first, undefined, "/inbox");
    const acc2 = mergePage(acc1, second, undefined, "/inbox?kind=MENTION");
    expect(flattenRows(acc2.chunks).map((r) => r.id)).toEqual(["c"]);
  });

  it("a pasted or stale cursor that continues nothing starts from that page", () => {
    const acc1 = mergePage(null, first, undefined, "/inbox");
    const acc2 = mergePage(acc1, second, "some-other-cursor", "/inbox");
    expect(flattenRows(acc2.chunks).map((r) => r.id)).toEqual(["c"]);
  });

  it("flattenRows de-duplicates by id across chunks", () => {
    const rows = flattenRows([
      { cursor: undefined, rows: [row("a", "2026-09-20T12:00:00.000Z")] },
      { cursor: "c1", rows: [row("a", "2026-09-20T12:00:00.000Z"), row("b", "2026-09-20T11:00:00.000Z")] },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("groupRows — the firm clock decides what 'today' is", () => {
  // 2026-09-20 09:00 ET = 13:00 UTC. Firm midnight that day is 2026-09-20T04:00:00Z.
  const now = new Date("2026-09-20T13:00:00.000Z");

  it("splits on firm-local midnight, not on the container's", () => {
    const grouped = groupRows(
      [
        row("today-early", "2026-09-20T05:00:00.000Z"),
        row("yesterday-late", "2026-09-20T03:00:00.000Z"),
      ],
      now,
    );
    expect(grouped.today.map((r) => r.id)).toEqual(["today-early"]);
    expect(grouped.earlier.map((r) => r.id)).toEqual(["yesterday-late"]);
  });

  it("puts an unreadable timestamp in Earlier rather than dropping the row", () => {
    const grouped = groupRows([row("bad", "not-a-date")], now);
    expect(grouped.earlier.map((r) => r.id)).toEqual(["bad"]);
    expect(grouped.today).toEqual([]);
  });

  it("preserves the order it was given inside each group", () => {
    const grouped = groupRows(
      [row("a", "2026-09-20T12:00:00.000Z"), row("b", "2026-09-20T11:00:00.000Z")],
      now,
    );
    expect(grouped.today.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
