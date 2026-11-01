import pool from '../db/pool.js';
import logger from '../lib/logger.js';

export async function fetchActiveTraderUserIds(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE role = 'trader' AND is_active = true`,
  );
  return rows.map((r) => r.id);
}

export async function insertNotificationsForUsers(
  userIds: string[],
  body: string,
  requestId: string | null,
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    for (const userId of userIds) {
      await pool.query(`INSERT INTO notifications (user_id, body, request_id) VALUES ($1::uuid, $2, $3)`, [
        userId,
        body,
        requestId,
      ]);
    }
  } catch (err) {
    logger.error({ err }, 'Failed to insert notifications');
  }
}

/** Best-effort: logs on failure; does not throw. */
export function notifyUsersSafe(userIds: string[], body: string, requestId: string | null): void {
  void insertNotificationsForUsers(userIds, body, requestId);
}
