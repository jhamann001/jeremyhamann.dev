import { describe, expect, it } from "vitest";
import { assertPiiLight } from "@/jobs/slack";
import {
  EVENT_ALERTS_CURSOR,
  eventAlertLine,
  eventAlertsWhere,
  eventDigestHeader,
  groupByQueue,
  parseQueueWebhooks,
  toQueueEvent,
} from "@/jobs/event-alerts";
import type { LedgerEvent, QueueEvent } from "@/jobs/event-alerts";

const BASE = "https://desk.example";

function ledgerEvent(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    seq: BigInt(10),
    action: "TICKET_ASSIGNED",
    oldValue: null,
    newValue: "usr_ops_1",
    ticketNumber: 1482,
    priority: "HIGH",
    currentQueueKey: "OPERATIONS",
    ...overrides,
  };
}

describe("eventAlertsWhere", () => {
  it("reads forward from the cursor, ticket-linked rows only, with RESOLVED -> OPEN narrowed in SQL", () => {
    const where = eventAlertsWhere(BigInt(42));
    expect(where.seq).toEqual({ gt: BigInt(42) });
    expect(where.ticketId).toEqual({ not: null });
    expect(where.OR).toEqual([
      { action: "TICKET_ASSIGNED" },
      { action: "TICKET_QUEUE_CHANGED" },
      { action: "TICKET_REOPENED_BY_REQUESTER" },
      { action: "TICKET_STATUS_CHANGED", oldValue: "RESOLVED", newValue: "OPEN" },
    ]);
  });
});

describe("toQueueEvent", () => {
  it("routes an assignment to the ticket's own queue and never carries the assignee", () => {
    const routed = toQueueEvent(ledgerEvent());
    expect(routed).toMatchObject({ kind: "assigned", queueKey: "OPERATIONS", ticketNumber: 1482 });
    expect(JSON.stringify(routed, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("usr_ops_1");
  });

  it("treats a cleared assignment as 'unassigned'", () => {
    expect(toQueueEvent(ledgerEvent({ newValue: null }))).toMatchObject({ kind: "unassigned" });
    expect(toQueueEvent(ledgerEvent({ newValue: "" }))).toMatchObject({ kind: "unassigned" });
  });

  it("announces a hand-off in the destination queue and names the source", () => {
    const routed = toQueueEvent(
      ledgerEvent({
        action: "TICKET_QUEUE_CHANGED",
        oldValue: "CLIENT_SERVICE",
        newValue: "OPERATIONS",
        currentQueueKey: "OPERATIONS",
      }),
    );
    expect(routed).toMatchObject({ kind: "queue-changed", queueKey: "OPERATIONS", fromQueueKey: "CLIENT_SERVICE" });
  });

  it("falls back to the ticket's current queue when the recorded destination is not a queue key", () => {
    const routed = toQueueEvent(
      ledgerEvent({ action: "TICKET_QUEUE_CHANGED", oldValue: "nonsense", newValue: "nonsense" }),
    );
    expect(routed).toMatchObject({ queueKey: "OPERATIONS", fromQueueKey: null });
  });

  it("treats both reopen shapes as a reopen", () => {
    expect(toQueueEvent(ledgerEvent({ action: "TICKET_REOPENED_BY_REQUESTER" }))).toMatchObject({ kind: "reopened" });
    expect(
      toQueueEvent(ledgerEvent({ action: "TICKET_STATUS_CHANGED", oldValue: "RESOLVED", newValue: "OPEN" })),
    ).toMatchObject({ kind: "reopened" });
  });

  it("ignores any other status change, even if one slipped past the SQL filter", () => {
    expect(toQueueEvent(ledgerEvent({ action: "TICKET_STATUS_CHANGED", oldValue: "OPEN", newValue: "RESOLVED" }))).toBeNull();
    expect(toQueueEvent(ledgerEvent({ action: "TICKET_VIEWED" }))).toBeNull();
  });
});

describe("eventAlertLine", () => {
  const event: QueueEvent = {
    seq: BigInt(1),
    kind: "assigned",
    ticketNumber: 1482,
    priority: "HIGH",
    queueKey: "OPERATIONS",
    fromQueueKey: null,
  };

  it("carries what happened, the link, the queue and the priority — and no identity", () => {
    expect(eventAlertLine(event, BASE).text).toBe(
      ":inbox_tray: assigned | <https://desk.example/tickets/wm/1482|HD-1482> | OPERATIONS | HIGH",
    );
  });

  it("names the source queue on a hand-off", () => {
    const line = eventAlertLine({ ...event, kind: "queue-changed", fromQueueKey: "CLIENT_SERVICE" }, BASE);
    expect(line.text).toContain("handed off from CLIENT_SERVICE");
  });

  it("is PII-light for every kind, with and without a base URL", () => {
    for (const kind of ["assigned", "unassigned", "queue-changed", "reopened"] as const) {
      expect(() => assertPiiLight(eventAlertLine({ ...event, kind }, BASE).text)).not.toThrow();
      expect(() => assertPiiLight(eventAlertLine({ ...event, kind }, undefined).text)).not.toThrow();
    }
  });
});

describe("eventDigestHeader", () => {
  it("is singular for one update", () => {
    expect(eventDigestHeader("ADVICE", 1).text).toBe("*WM help desk — ADVICE:* 1 update");
    expect(eventDigestHeader("ADVICE", 4).text).toBe("*WM help desk — ADVICE:* 4 updates");
  });
});

describe("groupByQueue", () => {
  it("keeps ledger order within each queue", () => {
    const make = (seq: number, queueKey: QueueEvent["queueKey"]): QueueEvent => ({
      seq: BigInt(seq),
      kind: "assigned",
      ticketNumber: seq,
      priority: "STANDARD",
      queueKey,
      fromQueueKey: null,
    });
    const grouped = groupByQueue([make(1, "OPERATIONS"), make(2, "ADVICE"), make(3, "OPERATIONS")]);
    expect([...grouped.keys()]).toEqual(["OPERATIONS", "ADVICE"]);
    expect(grouped.get("OPERATIONS")?.map((e) => e.ticketNumber)).toEqual([1, 3]);
  });
});

describe("parseQueueWebhooks", () => {
  it("keeps only known queue keys with https values", () => {
    const raw = JSON.stringify({
      OPERATIONS: "https://hooks.slack.example/ops",
      CLIENT_SERVICE: "http://hooks.slack.example/cs",
      MARKETING: "https://hooks.slack.example/marketing",
      ADVICE: 42,
    });
    expect(parseQueueWebhooks(raw)).toEqual({ OPERATIONS: "https://hooks.slack.example/ops" });
  });

  it("returns an empty map for unset, blank, malformed and non-object values", () => {
    expect(parseQueueWebhooks(undefined)).toEqual({});
    expect(parseQueueWebhooks("   ")).toEqual({});
    expect(parseQueueWebhooks("{not json")).toEqual({});
    expect(parseQueueWebhooks("[]")).toEqual({});
    expect(parseQueueWebhooks('"a string"')).toEqual({});
  });
});

describe("EVENT_ALERTS_CURSOR", () => {
  it("is the stable JobCursor key", () => {
    expect(EVENT_ALERTS_CURSOR).toBe("event-alerts");
  });
});
