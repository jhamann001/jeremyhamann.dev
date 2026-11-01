import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getOutboxEmailBody, listOutbox } from '../demo/outbox.js';
import { sendError } from '../middleware/errorHandler.js';

// The demo outbox: Slack messages and emails the app would have delivered (see demo/outbox.ts).
const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
    res.json({ data: await listOutbox(limit) });
  } catch (err) {
    next(err);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// An email's HTML on its own, for the Outbox's frame. It carries its own policy: the email's inline styles
// apply (a srcdoc frame would inherit the app's policy, which blocks them), and nothing may load or run.
const EMAIL_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'; sandbox";

router.get('/:id/body', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = String(req.params.id);
    if (!UUID_RE.test(id)) {
      sendError(res, 400, 'Invalid message id');
      return;
    }
    const body = await getOutboxEmailBody(id);
    if (body === null) {
      sendError(res, 404, 'No such email');
      return;
    }
    res.set({
      'Content-Security-Policy': EMAIL_POLICY,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
    });
    res.send(body);
  } catch (err) {
    next(err);
  }
});

export default router;
