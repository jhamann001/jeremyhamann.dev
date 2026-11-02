import "server-only";
import type { Prisma } from "@prisma/client";

// The demo Outbox: what the app would have sent in production (Slack posts, the closeout checklist webhook,
// Operations alerts), kept in demo.outbox_message so visitors can read it on /outbox. Nothing leaves the demo.
// The app login may add and read rows, never change or remove them; the nightly reset empties the table.
// Reads are under row security (migration 20261107120100_demo_outbox_scope): run `listOutbox` in the reader's
// `withUserScope`, and a persona sees the messages about the households and clients it can see, admin and
// operations every message. Outside a scope it reads nothing.

type OutboxDb = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">;

/** What a message is about. Leave it out for a message about no single record: only admin and operations read it. */
export interface OutboxSubject {
  householdSfId?: string | null;
  clientSfId?: string | null;
  /** The client's id across the firm's systems (mirror.client.cedar_ridge_user_id), as a trade request names it. */
  cedarRidgeUserId?: string | null;
}

export interface OutboxEntry {
  /** Where it would have gone: "Slack" or "n8n". */
  channel: string;
  /** The Slack channel, direct message or webhook, as a reader would name it. */
  destination: string;
  title: string;
  detail: string;
  /** The message as it would have been delivered: Slack text, or the webhook's JSON body. */
  body: string;
  about?: OutboxSubject;
}

export interface OutboxMessage extends Omit<OutboxEntry, "about"> {
  id: string;
  createdAt: string;
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
/** An id the column can hold, or none: an id too long to be real names nothing, so the message stays staff-only. */
const subjectId = (value: string | null | undefined, max: number) => (value && value.length <= max ? value : null);

export async function recordOutbox(db: OutboxDb, entry: OutboxEntry): Promise<void> {
  const about = entry.about ?? {};
  await db.$executeRaw`
    INSERT INTO demo.outbox_message (channel, destination, title, detail, body, household_sf_id, client_sf_id, cedar_ridge_user_id)
    VALUES (${clip(entry.channel, 40)}, ${clip(entry.destination, 120)}, ${clip(entry.title || "Message", 200)},
            ${clip(entry.detail, 500)}, ${clip(entry.body, 8000)}, ${subjectId(about.householdSfId, 64)},
            ${subjectId(about.clientSfId, 64)}, ${subjectId(about.cedarRidgeUserId, 100)})`;
}

/** A trade request's client, read from the request itself (the trade-request tables have no row security). */
export async function tradeRequestSubject(db: OutboxDb, requestId: string): Promise<OutboxSubject> {
  const [row] = await db.$queryRaw<{ client_id: string }[]>`
    SELECT client_id FROM trade_request.trade_requests WHERE id = ${requestId}`;
  return { cedarRidgeUserId: row?.client_id ?? null };
}

export async function listOutbox(db: OutboxDb, limit = 100): Promise<OutboxMessage[]> {
  const rows = await db.$queryRaw<
    { id: bigint; channel: string; destination: string; title: string; detail: string; body: string; created_at: Date }[]
  >`
    SELECT id, channel, destination, title, detail, body, created_at
      FROM demo.outbox_message
     ORDER BY created_at DESC, id DESC
     LIMIT ${Math.max(1, Math.min(limit, 200))}`;
  return rows.map(({ id, created_at, ...row }) => ({ ...row, id: id.toString(), createdAt: created_at.toISOString() }));
}

/** A Slack message's first line as a title (formatting stripped), and the rest as its detail. */
export function slackSummary(text: string): { title: string; detail: string } {
  const plain = text
    .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const [first = "", ...rest] = plain.split("\n").map((line) => line.trim()).filter(Boolean);
  return { title: first, detail: rest.join(" · ") };
}
