import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '@trade-request/shared';
import { z } from 'zod';
import pool from '../db/pool.js';
import { sendError } from '../middleware/errorHandler.js';
import { revokeFamily } from '../mcp/oauth/store.js';

const router = Router();

const ACCESS_TTL_S = Number(process.env.MCP_ACCESS_TOKEN_TTL_S ?? 60 * 60);
const REFRESH_TTL_S = Number(process.env.MCP_REFRESH_TOKEN_TTL_S ?? 60 * 60 * 24 * 30);

interface SessionRow {
  family_id: string;
  client_id: string;
  client_name: string | null;
  client_created_at: Date;
  refresh_expires_at: Date;
  last_access_at: Date | null;
}

/**
 * List the current user's active MCP sessions (one row per active family —
 * a family being the chain of refresh tokens descended from one authorization).
 *
 * "Last active" is approximated from the most recent refresh-token rotation
 * (`expires_at - REFRESH_TTL`) and the most recently-issued access token within
 * the same (user_id, client_id) pair. Neither is exact — we don't write on
 * every /mcp call to avoid hot-path overhead.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as AuthUser;
    const { rows } = await pool.query<SessionRow>(
      `SELECT
         rt.family_id,
         rt.client_id,
         oc.client_name,
         oc.created_at                              AS client_created_at,
         rt.expires_at                              AS refresh_expires_at,
         (
           SELECT MAX(at.expires_at)
           FROM oauth_access_tokens at
           WHERE at.user_id = rt.user_id
             AND at.client_id = rt.client_id
             AND at.revoked_at IS NULL
         )                                          AS last_access_at
       FROM oauth_refresh_tokens rt
       JOIN oauth_clients oc ON oc.id = rt.client_id
       WHERE rt.user_id = $1
         AND rt.revoked_at IS NULL
         AND rt.rotated_to IS NULL
         AND rt.expires_at > NOW()
       ORDER BY rt.expires_at DESC`,
      [user.id],
    );

    res.json({
      data: rows.map((r) => ({
        familyId: r.family_id,
        clientId: r.client_id,
        clientName: r.client_name ?? 'Unnamed MCP client',
        registeredAt: r.client_created_at.toISOString(),
        // Approximation: when this refresh token was issued (or last rotated).
        lastRefreshedAt: new Date(r.refresh_expires_at.getTime() - REFRESH_TTL_S * 1000).toISOString(),
        // Approximation: when an access token was last minted for this client.
        // If the token was minted within the last hour, the client is probably "active right now".
        lastAccessTokenAt:
          r.last_access_at != null ? new Date(r.last_access_at.getTime() - ACCESS_TTL_S * 1000).toISOString() : null,
        refreshExpiresAt: r.refresh_expires_at.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

const familyIdSchema = z.guid('familyId must be a UUID');

router.delete('/:familyId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as AuthUser;
    const familyId = familyIdSchema.parse(req.params.familyId);

    // Verify the family belongs to this user — revokeFamily itself doesn't
    // check that, and we don't want a logged-in user revoking someone else's
    // session by guessing UUIDs.
    const { rows } = await pool.query(
      'SELECT 1 FROM oauth_refresh_tokens WHERE family_id = $1 AND user_id = $2 LIMIT 1',
      [familyId, user.id],
    );
    if (rows.length === 0) {
      sendError(res, 404, 'Session not found');
      return;
    }

    await revokeFamily(familyId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as AuthUser;
    const { rows } = await pool.query<{ family_id: string }>(
      `SELECT DISTINCT family_id FROM oauth_refresh_tokens
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    );
    for (const row of rows) {
      await revokeFamily(row.family_id);
    }
    res.json({ revokedFamilies: rows.length });
  } catch (err) {
    next(err);
  }
});

export default router;
