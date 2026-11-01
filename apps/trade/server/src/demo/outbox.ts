// The demo outbox: messages the app would have delivered, kept so visitors can see them.
// The Slack and email stand-ins write here; GET /api/outbox reads it back with readable destinations.

import type { Pool, PoolClient } from 'pg';
import pool from '../db/pool.js';
import { readSecret } from '../lib/secrets.js';

export type OutboxTransport = 'slack' | 'email';

export interface OutboxMessage {
  id: string;
  transport: OutboxTransport;
  destination: string;
  /** "#trade-requests", "Rachel Moss (DM)" or the email address. */
  destinationLabel: string;
  subject: string | null;
  body: string;
  createdAt: string;
}

export async function recordOutbox(
  message: { transport: OutboxTransport; destination: string; subject?: string | null; body: string; at?: Date },
  db: Pool | PoolClient = pool,
): Promise<void> {
  await db.query(
    'INSERT INTO outbox_messages (transport, destination, subject, body, created_at) VALUES ($1, $2, $3, $4, $5)',
    [message.transport, message.destination, message.subject ?? null, message.body, message.at ?? new Date()],
  );
}

/** One email's HTML, for the Outbox to show in a frame of its own; null if there is no such email. */
export async function getOutboxEmailBody(id: string, db: Pool | PoolClient = pool): Promise<string | null> {
  const { rows } = await db.query<{ body: string }>(
    "SELECT body FROM outbox_messages WHERE id = $1::uuid AND transport = 'email'",
    [id],
  );
  return rows[0]?.body ?? null;
}

/** Slack channel ids the app is configured with, named the way the firm's workspace names them. */
function channelLabels(): Map<string, string> {
  const labels = new Map<string, string>();
  // Read the way the Slack client reads them (a mounted secret first, then the environment).
  const trades = readSecret('SLACK_CHANNEL_ID');
  const drift = readSecret('DRIFT_SLACK_CHANNEL_ID');
  if (trades) labels.set(trades, '#trade-requests');
  if (drift) labels.set(drift, '#drift-alerts');
  return labels;
}

export async function listOutbox(limit: number, db: Pool | PoolClient = pool): Promise<OutboxMessage[]> {
  const { rows } = await db.query<{
    id: string;
    transport: OutboxTransport;
    destination: string;
    subject: string | null;
    body: string;
    created_at: Date;
    member_name: string | null;
  }>(
    // Slack member ids aren't unique across users, so the label takes the earliest user with that id
    // rather than joining (a join would repeat the message once per match).
    `SELECT o.id, o.transport, o.destination, o.subject, o.body, o.created_at,
            (SELECT u.name FROM users u
              WHERE o.transport = 'slack' AND u.slack_user_id = o.destination
              ORDER BY u.created_at LIMIT 1) AS member_name
       FROM outbox_messages o
      ORDER BY o.created_at DESC
      LIMIT $1`,
    [limit],
  );
  const channels = channelLabels();
  return rows.map((r) => ({
    id: r.id,
    transport: r.transport,
    destination: r.destination,
    destinationLabel:
      r.transport === 'email' ? r.destination : channels.get(r.destination) ?? (r.member_name ? `${r.member_name} (DM)` : r.destination),
    subject: r.subject,
    body: r.body,
    createdAt: r.created_at.toISOString(),
  }));
}
