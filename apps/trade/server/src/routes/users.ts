import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '@trade-request/shared';
import { z } from 'zod';
import pool from '../db/pool.js';
import { requireRole, mapRow, ALLOWED_DOMAINS } from '../middleware/auth.js';
import { AppError, sendError } from '../middleware/errorHandler.js';
import { sendChannelMessage, escapeSlack } from '../services/slack.js';
import { sendInviteEmail } from '../services/email.js';
import { DEMO_USERS } from '../fixtures/demo-data.js';
import logger from '../lib/logger.js';
import { isPersonaEmail, isPersonaUser, personaSignInEnabled } from '../demo/personas.js';
import { withDemoQuota } from '../demo/guards.js';

const router = Router();
const paramId = z.string().min(1, 'ID is required').max(50, 'ID is too long');

router.use(requireRole('trader'));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// In the public demo, the persona accounts keep their role and status, so every visitor can sign in as them.
// Ids must be UUIDs there, and the check compares them as UUIDs, so no other spelling of a persona's id
// (upper case, braces, no hyphens) slips past while the route's own query still finds the row.
router.param('id', async (req: Request, res: Response, next: NextFunction, id: string) => {
  try {
    if (req.method === 'GET' || !personaSignInEnabled()) {
      next();
      return;
    }
    if (!UUID_RE.test(id)) {
      sendError(res, 400, 'Invalid user id');
      return;
    }
    if (await isPersonaUser(id)) {
      sendError(res, 403, 'Demo personas can’t be changed. Invite a new user to try this.');
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (_req.isDemo) {
      res.json({ data: DEMO_USERS });
      return;
    }

    const result = await pool.query(
      'SELECT id, google_id, email, name, picture, role, slack_user_id, theme_preference, is_active, last_login, created_at FROM users ORDER BY created_at DESC',
    );
    res.json({ data: result.rows.map(mapRow) });
  } catch (err) {
    next(err);
  }
});

const inviteSchema = z.object({
  email: z
    .string()
    .email()
    .refine(
      (e) => {
        const domain = e.split('@')[1]?.toLowerCase();
        return domain != null && ALLOWED_DOMAINS.includes(domain);
      },
      { message: `Only ${ALLOWED_DOMAINS.map((d) => `@${d}`).join(' or ')} emails allowed` },
    ),
  name: z.string().min(1).max(255),
  role: z.enum(['advisor', 'trader']),
});

router.post('/invite', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      sendError(res, 403, 'Not available in demo mode');
      return;
    }

    const data = inviteSchema.parse(req.body);
    // Persona emails are reserved in any letter case, so no invited account can pass for a persona.
    if (personaSignInEnabled() && isPersonaEmail(data.email)) {
      throw new AppError(409, 'That email belongs to a demo persona');
    }

    let insertResult;
    try {
      insertResult = await withDemoQuota('users', 1, (db) =>
        db.query(`INSERT INTO users (email, name, role, is_active) VALUES ($1, $2, $3, true) RETURNING *`, [
          data.email,
          data.name,
          data.role,
        ]),
      );
    } catch (dbErr: unknown) {
      const pgErr = dbErr as { code?: string };
      if (pgErr.code === '23505') {
        throw new AppError(409, 'User with this email already exists');
      }
      throw dbErr;
    }
    const result = mapRow(insertResult.rows[0]);
    const inviterName = (req.user as AuthUser).name;

    const [emailResult, slackResult] = await Promise.allSettled([
      sendInviteEmail({
        to: result.email,
        inviteeName: result.name,
        role: result.role,
        invitedBy: inviterName,
      }),
      sendChannelMessage(
        `*New User Invited* — ${escapeSlack(result.name)} (${escapeSlack(result.email)}) as ${result.role}. Invited by ${escapeSlack(inviterName)}.`,
      ),
    ]);

    const warnings: string[] = [];
    if (emailResult.status === 'rejected') warnings.push('Invite email could not be sent');
    if (slackResult.status === 'rejected') warnings.push('Slack notification could not be sent');

    res.status(201).json({ ...result, warnings: warnings.length > 0 ? warnings : undefined });
  } catch (err) {
    next(err);
  }
});

const updateRoleSchema = z.object({
  role: z.enum(['advisor', 'trader']),
});

router.patch('/:id/role', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      sendError(res, 403, 'Not available in demo mode');
      return;
    }

    const id = paramId.parse(req.params.id);
    const { role } = updateRoleSchema.parse(req.body);
    const currentUser = req.user as AuthUser;
    if (id === currentUser.id) {
      throw new AppError(400, 'Cannot change your own role');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [id]);

      if (role === 'advisor') {
        const { rows: traders } = await client.query(
          "SELECT COUNT(*) FROM users WHERE role = 'trader' AND is_active = true AND id != $1",
          [id],
        );
        if (parseInt(traders[0].count) < 1) {
          throw new AppError(400, 'Cannot demote the last active trader');
        }
      }
      const result = await client.query('UPDATE users SET role = $1 WHERE id = $2 RETURNING *', [role, id]);
      if (result.rows.length === 0) throw new AppError(404, 'User not found');
      await client.query('COMMIT');
      res.json(mapRow(result.rows[0]));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/deactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      sendError(res, 403, 'Not available in demo mode');
      return;
    }

    const id = paramId.parse(req.params.id);
    const currentUser = req.user as AuthUser;
    if (id === currentUser.id) {
      throw new AppError(400, 'Cannot deactivate your own account');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: targetUser } = await client.query('SELECT role FROM users WHERE id = $1 FOR UPDATE', [id]);
      if (targetUser.length === 0) throw new AppError(404, 'User not found');

      if (targetUser[0].role === 'trader') {
        const { rows: traders } = await client.query(
          "SELECT COUNT(*) FROM users WHERE role = 'trader' AND is_active = true AND id != $1",
          [id],
        );
        if (parseInt(traders[0].count) < 1) {
          throw new AppError(400, 'Cannot deactivate the last active trader');
        }
      }
      const result = await client.query('UPDATE users SET is_active = false WHERE id = $1 RETURNING *', [id]);

      // Cascade-revoke MCP credentials so the deactivated user can't keep
      // querying via /mcp using a previously-issued PAT or OAuth token. The
      // bearer middleware also re-checks is_active on every call, but we
      // want the credentials marked revoked so the Connected Apps UI shows
      // them as such (rather than active-but-silently-rejected).
      const { rowCount: patCount } = await client.query(
        `UPDATE mcp_pats SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [id],
      );
      const { rowCount: refreshCount } = await client.query(
        `UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [id],
      );
      await client.query(
        `UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [id],
      );

      await client.query('COMMIT');

      if ((patCount ?? 0) > 0 || (refreshCount ?? 0) > 0) {
        logger.info(
          {
            event: 'pat_revoked_cascade',
            userId: id,
            patCount: patCount ?? 0,
            oauthFamilyCount: refreshCount ?? 0,
          },
          'Cascade-revoked MCP credentials on user deactivation',
        );
      }

      res.json(mapRow(result.rows[0]));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* best-effort */
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

const slackSchema = z.object({
  slackUserId: z
    .string()
    .max(50)
    .refine((v) => v === '' || /^[UW][A-Z0-9]{3,}$/.test(v), {
      message: 'Must be a valid Slack user ID (e.g. U01ABC23DEF) or empty',
    })
    .default(''),
});

router.patch('/:id/slack', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      sendError(res, 403, 'Not available in demo mode');
      return;
    }

    const id = paramId.parse(req.params.id);
    const { slackUserId } = slackSchema.parse(req.body);
    const result = await pool.query('UPDATE users SET slack_user_id = $1 WHERE id = $2 RETURNING *', [
      slackUserId || null,
      id,
    ]);
    if (result.rows.length === 0) throw new AppError(404, 'User not found');
    res.json(mapRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/reactivate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      sendError(res, 403, 'Not available in demo mode');
      return;
    }

    const id = paramId.parse(req.params.id);
    const result = await pool.query('UPDATE users SET is_active = true WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) throw new AppError(404, 'User not found');
    res.json(mapRow(result.rows[0]));
  } catch (err) {
    next(err);
  }
});

export default router;
