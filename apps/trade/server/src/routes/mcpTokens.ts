import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '@trade-request/shared';
import { z } from 'zod';
import { sendError } from '../middleware/errorHandler.js';
import logger from '../lib/logger.js';
import { issuePat, listPatsForUser, revokePat } from '../mcp/oauth/store.js';

const router = Router();

const idSchema = z.guid('id must be a UUID');

const createSchema = z.object({
  name: z
    .string()
    .min(1, 'name is required')
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\x00-\x1f\x7f]+$/, 'name must not contain control characters')
    .max(100, 'name must be 100 characters or fewer')
    .refine((v) => v.trim().length > 0, { message: 'name must not be whitespace-only' }),
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as AuthUser;
    const pats = await listPatsForUser(user.id);
    res.json({
      data: pats.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt.toISOString(),
        lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
        revokedAt: p.revokedAt ? p.revokedAt.toISOString() : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as AuthUser;
    const { name } = createSchema.parse(req.body);

    const audience = process.env.MCP_RESOURCE_URL;
    if (!audience) {
      sendError(res, 503, 'MCP server is not configured (MCP_RESOURCE_URL missing)');
      return;
    }

    const result = await issuePat({ userId: user.id, name: name.trim(), audience });

    logger.info({ event: 'pat_issued', patId: result.id, userId: user.id, name: name.trim() }, 'PAT issued');

    res.status(201).json({
      id: result.id,
      name: name.trim(),
      token: result.token,
      createdAt: result.createdAt.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = req.user as AuthUser;
    const id = idSchema.parse(req.params.id);

    const ok = await revokePat(id, user.id);
    if (!ok) {
      sendError(res, 404, 'Token not found');
      return;
    }

    logger.info({ event: 'pat_revoked', patId: id, userId: user.id, by: 'user' }, 'PAT revoked');
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
