// The demo Outbox: messages the app would have delivered, kept so visitors can see them. The Slack
// webhook stand-in writes here, and GET /api/outbox reads it back for the Outbox screen.

import type { Prisma, PrismaClient } from "@prisma/client";

export interface OutboxEntry {
  transport: "slack";
  destination: string;
  title: string;
  payload: Prisma.InputJsonValue;
  at?: Date;
}

export interface OutboxMessage {
  id: string;
  transport: string;
  destination: string;
  title: string;
  payload: unknown;
  createdAt: string;
}

type OutboxDb = Pick<PrismaClient, "demoOutboxMessage">;

export async function recordOutbox(db: OutboxDb, entry: OutboxEntry): Promise<void> {
  await db.demoOutboxMessage.create({
    data: {
      transport: entry.transport,
      destination: entry.destination,
      title: entry.title,
      payload: entry.payload,
      createdAt: entry.at ?? new Date(),
    },
  });
}

export async function listOutbox(db: OutboxDb, limit: number): Promise<OutboxMessage[]> {
  const rows = await db.demoOutboxMessage.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}
