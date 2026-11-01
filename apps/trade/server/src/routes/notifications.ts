import { Router } from 'express';
import { z } from 'zod';
import pool from '../db/pool.js';
import { AppError } from '../middleware/errorHandler.js';
import { DEMO_NOTIFICATIONS } from '../fixtures/demo-data.js';
import type { AuthUser } from '@trade-request/shared';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  unreadOnly: z.enum(['true', 'false']).optional(),
});

const paramId = z.guid('Invalid notification id');

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      const unreadCount = DEMO_NOTIFICATIONS.filter((n) => !n.isRead).length;
      res.json({ data: DEMO_NOTIFICATIONS, unreadCount });
      return;
    }

    const query = listQuerySchema.parse(req.query);
    const user = req.user as AuthUser;
    const unreadOnly = query.unreadOnly === 'true';

    const { rows } = await pool.query<{
      id: string;
      body: string;
      request_id: string | null;
      read_at: Date | null;
      created_at: Date;
    }>(
      `SELECT id, body, request_id, read_at, created_at
       FROM notifications
       WHERE user_id = $1
         ${unreadOnly ? 'AND read_at IS NULL' : ''}
       ORDER BY created_at DESC
       LIMIT $2`,
      [user.id, query.limit],
    );

    const { rows: countRows } = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [user.id],
    );
    const unreadCount = parseInt(countRows[0]?.c ?? '0', 10);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        message: r.body,
        isRead: r.read_at != null,
        date: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
        requestId: r.request_id,
      })),
      unreadCount,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      res.status(204).send();
      return;
    }

    const id = paramId.parse(req.params.id);
    const user = req.user as AuthUser;

    const { rowCount } = await pool.query(
      `UPDATE notifications SET read_at = date_trunc('milliseconds', NOW())
       WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
      [id, user.id],
    );

    if (rowCount === 0) {
      const { rows } = await pool.query('SELECT 1 FROM notifications WHERE id = $1 AND user_id = $2', [id, user.id]);
      if (rows.length === 0) throw new AppError(404, 'Notification not found');
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      res.status(204).send();
      return;
    }

    const user = req.user as AuthUser;
    await pool.query(
      `UPDATE notifications SET read_at = date_trunc('milliseconds', NOW())
       WHERE user_id = $1 AND read_at IS NULL`,
      [user.id],
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
