/**
 * The demo Outbox: every client email and Slack message the app would have sent, as the stand-ins received
 * them. The stand-in sender files emails here, the Slack stand-in files posts, and the Outbox screen reads
 * them back. Demo only (src/lib/demo/mode.ts); emptied by each reset.
 */
import type { Prisma } from "@prisma/client";
import type { DbTx } from "@/lib/db";
import type { QueueKey } from "@/types/domain";

export type OutboxTransport = "email" | "slack";

export type OutboxEntry = {
  transport: OutboxTransport;
  /** The recipient's address, or the Slack channel. */
  destination: string;
  title: string;
  payload: Prisma.InputJsonValue;
  /** The MessageDelivery an email was filed for. */
  deliveryId?: string;
  at?: Date;
};

/** An email as the outbox lease hands it to a sender: already rendered, addressed and threaded. */
export type OutboxEmailPayload = {
  ticketNumber: number;
  from: string;
  fromName: string;
  replyTo: string;
  to: string;
  subject: string;
  textBody: string;
  messageId: string;
  inReplyTo: string | null;
  references: string | null;
};

export type OutboxSlackPayload = { text: string };

export type OutboxMessage = {
  id: string;
  transport: OutboxTransport;
  destination: string;
  title: string;
  payload: unknown;
  deliveryId: string | null;
  createdAt: string;
};

type OutboxDb = Pick<DbTx, "demoOutboxMessage">;

export async function recordOutbox(db: OutboxDb, entry: OutboxEntry): Promise<void> {
  await db.demoOutboxMessage.create({
    data: {
      transport: entry.transport,
      destination: entry.destination,
      title: entry.title,
      payload: entry.payload,
      deliveryId: entry.deliveryId ?? null,
      createdAt: entry.at ?? new Date(),
    },
  });
}

/** Whether the sender already filed this delivery: a lease that expired and was taken again is filed once. */
export async function isDeliveryFiled(db: OutboxDb, deliveryId: string): Promise<boolean> {
  return (await db.demoOutboxMessage.count({ where: { deliveryId } })) > 0;
}

export async function listOutbox(db: OutboxDb, limit: number): Promise<OutboxMessage[]> {
  const rows = await db.demoOutboxMessage.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit });
  return rows.map((r) => ({ ...r, transport: r.transport as OutboxTransport, createdAt: r.createdAt.toISOString() }));
}

export async function findOutboxMessage(db: OutboxDb, id: string): Promise<OutboxMessage | null> {
  const r = await db.demoOutboxMessage.findUnique({ where: { id } });
  return r === null ? null : { ...r, transport: r.transport as OutboxTransport, createdAt: r.createdAt.toISOString() };
}

/** The tickets a message is about: an email's own, or the HD- numbers a Slack post names. */
export function outboxTicketNumbers(message: Pick<OutboxMessage, "transport" | "payload">): number[] {
  const payload = (message.payload ?? {}) as Partial<OutboxEmailPayload & OutboxSlackPayload>;
  if (message.transport === "email") return typeof payload.ticketNumber === "number" ? [payload.ticketNumber] : [];
  return [...new Set([...String(payload.text ?? "").matchAll(/\bHD-(\d{1,9})\b/g)].map((m) => Number(m[1])))];
}

type ScopedDb = OutboxDb & Pick<DbTx, "ticket">;

/**
 * The messages a viewer may see: only those whose every ticket sits in a queue they can read, so the Outbox
 * shows no more than the desk does (client service reads no advisor tickets, for one). A Slack post that names
 * no ticket is the desk's own and shows to everyone.
 */
export async function visibleOutbox(
  db: ScopedDb,
  messages: OutboxMessage[],
  canRead: (queue: QueueKey) => boolean,
): Promise<OutboxMessage[]> {
  const numbers = [...new Set(messages.flatMap(outboxTicketNumbers))];
  const tickets =
    numbers.length === 0
      ? []
      : await db.ticket.findMany({ where: { number: { in: numbers } }, select: { number: true, queue: { select: { key: true } } } });
  const queueOf = new Map(tickets.map((t) => [t.number, t.queue.key as QueueKey]));
  return messages.filter((m) =>
    outboxTicketNumbers(m).every((n) => {
      const queue = queueOf.get(n);
      return queue !== undefined && canRead(queue);
    }),
  );
}

/** The latest `limit` messages the viewer may see, read from a few times as many so a narrow view still fills. */
export async function listOutboxFor(
  db: ScopedDb,
  canRead: (queue: QueueKey) => boolean,
  limit: number,
): Promise<OutboxMessage[]> {
  return (await visibleOutbox(db, await listOutbox(db, limit * 4), canRead)).slice(0, limit);
}
