import { describe, expect, it } from "vitest";
import type { QueueKey } from "@/types/domain";
import { canReadQueue } from "@/lib/rbac";
import { takeDemoQuota } from "./limits";
import { outboxTicketNumbers, visibleOutbox, type OutboxMessage } from "./outbox";

const message = (id: string, transport: "email" | "slack", payload: unknown): OutboxMessage => ({
  id,
  transport,
  destination: transport === "email" ? "client@example.com" : "advice-desk",
  title: id,
  payload,
  deliveryId: null,
  createdAt: "2026-10-28T14:00:00.000Z",
});

const queues: Record<number, QueueKey> = { 2479: "OPERATIONS", 2463: "CLIENT_SERVICE", 2470: "ADVICE" };
const db = {
  ticket: {
    findMany: async ({ where }: { where: { number: { in: number[] } } }) =>
      where.number.in.filter((n) => n in queues).map((n) => ({ number: n, queue: { key: queues[n]! } })),
  },
} as never;

describe("the Outbox's scope", () => {
  it("finds the tickets a message is about: an email's own, or the HD- numbers a Slack post names", () => {
    expect(outboxTicketNumbers(message("e", "email", { ticketNumber: 2470 }))).toEqual([2470]);
    expect(outboxTicketNumbers(message("s", "slack", { text: "<https://x/tickets/wm/2470|HD-2470> and HD-2479, HD-2470" }))).toEqual([
      2470, 2479,
    ]);
    expect(outboxTicketNumbers(message("d", "slack", { text: "Morning digest: all clear" }))).toEqual([]);
  });

  it("shows client service no advisor mail, and compliance everything", async () => {
    const all = [
      message("ops-email", "email", { ticketNumber: 2479 }),
      message("advice-email", "email", { ticketNumber: 2470 }),
      message("advice-alert", "slack", { text: "SLA breached on HD-2470" }),
      message("mixed-alert", "slack", { text: "SLA warnings: HD-2463, HD-2470" }),
      message("digest", "slack", { text: "Morning digest: all clear" }),
      message("unknown-ticket", "email", { ticketNumber: 9999 }),
    ];
    const ids = async (groups: Parameters<typeof canReadQueue>[0]) =>
      (await visibleOutbox(db, all, (q) => canReadQueue(groups, q))).map((m) => m.id);

    expect(await ids(["client_services"])).toEqual(["ops-email", "digest"]);
    expect(await ids(["compliance_officers"])).toEqual(["ops-email", "advice-email", "advice-alert", "mixed-alert", "digest"]);
  });
});

describe("the demo's per-visitor quotas", () => {
  it("allows the limit in a window, then refuses until the window turns over", () => {
    const at = new Date("2026-10-28T14:00:00Z");
    for (let i = 0; i < 6; i++) expect(takeDemoQuota("outbox:2001:db8::1", 6, 60_000, at)).toBe(true);
    expect(takeDemoQuota("outbox:2001:db8::1", 6, 60_000, at)).toBe(false);
    expect(takeDemoQuota("outbox:2001:db8::2", 6, 60_000, at)).toBe(true);
    expect(takeDemoQuota("outbox:2001:db8::1", 6, 60_000, new Date(at.getTime() + 60_000))).toBe(true);
  });
});
