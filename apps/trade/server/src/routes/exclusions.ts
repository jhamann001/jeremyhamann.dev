import { Router } from 'express';
import { holdDemoQuota, withDemoQuota } from '../demo/guards.js';
import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import type { AuthUser, ClientExclusion, ClientExclusionKind, ExclusionExportRow } from '@trade-request/shared';
import pool from '../db/pool.js';
import logger from '../lib/logger.js';
import * as warehouse from '../services/warehouse.js';
import { AppError } from '../middleware/errorHandler.js';
import { notifyExclusionChange, notifyExclusionBatchChange } from '../services/slack.js';
import { fetchActiveTraderUserIds, notifyUsersSafe } from '../services/notificationInserts.js';

const router = Router();

const TICKER_REGEX = /^[A-Z0-9.-]+$/;
const POSTGRES_UNIQUE_VIOLATION = '23505';

const clientIdParamSchema = z.string().min(1).max(100);
const idParamSchema = z.guid('Invalid exclusion id');

// v3.4 — noBuy/noSell are optional on the per-row schema with `.default(true)`
// so a v3.3 caller that POSTs WITHOUT either field still works (the row lands
// with both flags TRUE, matching today's blanket semantic). A body that
// explicitly sets BOTH fields to false is rejected before the DB hit, mirroring
// the new CHECK constraint and giving the caller a cleaner error than a
// Postgres CHECK violation.
const createBodySchema = z
  .object({
    ticker: z
      .string()
      .trim()
      .min(1, 'Ticker is required')
      .max(20, 'Ticker too long')
      .transform((s) => s.toUpperCase())
      .refine((s) => TICKER_REGEX.test(s), {
        message: 'Ticker may only contain letters, numbers, dots, and dashes',
      }),
    kind: z.enum(['advisor', 'client']),
    reason: z.string().trim().max(500, 'Reason too long').default(''),
    noBuy: z.boolean().default(true),
    noSell: z.boolean().default(true),
  })
  .refine((v) => v.noBuy || v.noSell, {
    message: 'At least one of noBuy or noSell must be true',
    path: ['noBuy'],
  });

const bulkBodySchema = z.object({
  clientIds: z.array(z.string().min(1).max(100)).min(1, 'clientIds is required').max(1000, 'Too many client IDs'),
});

const bulkAccountBodySchema = z.object({
  accountIds: z.array(z.string().min(1).max(100)).min(1, 'accountIds is required').max(1000, 'Too many account IDs'),
});

const batchAddItemSchema = createBodySchema; // same per-item rules as the single-row POST
const batchRemoveIdSchema = z.guid('Invalid exclusion id');

// v3.4 — edit step in the batch endpoint. Unlike adds, both noBuy and noSell
// are REQUIRED here (no defaults) because an inline edit is by definition the
// user explicitly choosing the new flag state — silent defaults would mask
// intent.
const batchEditItemSchema = z
  .object({
    id: z.guid('Invalid exclusion id'),
    noBuy: z.boolean(),
    noSell: z.boolean(),
  })
  .refine((v) => v.noBuy || v.noSell, {
    message: 'At least one of noBuy or noSell must be true',
    path: ['noBuy'],
  });

const batchBodySchema = z
  .object({
    add: z.array(batchAddItemSchema).max(100, 'Too many adds in one batch').default([]),
    remove: z.array(batchRemoveIdSchema).max(100, 'Too many removes in one batch').default([]),
    edit: z.array(batchEditItemSchema).max(100, 'Too many edits in one batch').default([]),
  })
  .refine((b) => b.add.length + b.remove.length + b.edit.length > 0, {
    message: 'Batch must contain at least one add, remove, or edit',
  })
  // Reject duplicate (ticker, kind) pairs WITHIN the same add batch — the DB unique
  // constraint would catch this, but a 400 here is a cleaner failure mode than
  // letting Postgres roll back a partially-progressed transaction.
  .superRefine((b, ctx) => {
    const seen = new Set<string>();
    for (const item of b.add) {
      const key = `${item.kind}:${item.ticker}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate ${item.kind} entry for ${item.ticker} in batch`,
          path: ['add'],
        });
      }
      seen.add(key);
    }
    // Same row can't be both edited and removed in one batch. The modal
    // disables the inline checkboxes on marked-for-removal rows, but a
    // programmatic caller could submit this — and the all-or-nothing
    // semantic gets weird (remove processed first, then the edit 404s on a
    // now-gone row, the whole batch rolls back). Reject up front for a
    // cleaner error.
    const removeIds = new Set(b.remove);
    for (const editItem of b.edit) {
      if (removeIds.has(editItem.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Cannot edit and remove the same exclusion (${editItem.id}) in one batch`,
          path: ['edit'],
        });
      }
    }
  });

type ExclusionRow = {
  id: string;
  client_id: string;
  ticker: string;
  kind: ClientExclusionKind;
  reason: string;
  no_buy: boolean;
  no_sell: boolean;
  created_by_name: string;
  created_at: Date;
};

type AccountExclusion = {
  id: string;
  accountId: string;
  ticker: string;
  kind: ClientExclusionKind;
  reason: string;
  noBuy: boolean;
  noSell: boolean;
  createdByName: string;
  createdAt: string;
};

type AccountExclusionRow = {
  id: string;
  account_id: string;
  ticker: string;
  kind: ClientExclusionKind;
  reason: string;
  no_buy: boolean;
  no_sell: boolean;
  created_by_name: string;
  created_at: Date;
};

/**
 * v3.4 — render the DNB/DNS abbreviation pair for in-app messages, per-row
 * Slack payloads, and any other server-side string formatting. The Slack
 * batch helper has its own copy in `services/slack.ts` because it's invoked
 * from a different module boundary; both must stay in sync (covered by tests).
 */
function formatSide(noBuy: boolean, noSell: boolean): string {
  if (noBuy && noSell) return 'DNB+DNS';
  if (noBuy) return 'DNB';
  return 'DNS';
}

function rowToExclusion(row: ExclusionRow): ClientExclusion {
  return {
    id: row.id,
    clientId: row.client_id,
    ticker: row.ticker,
    kind: row.kind,
    reason: row.reason,
    noBuy: row.no_buy,
    noSell: row.no_sell,
    createdByName: row.created_by_name,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
  };
}

function rowToAccountExclusion(row: AccountExclusionRow): AccountExclusion {
  return {
    id: row.id,
    accountId: row.account_id,
    ticker: row.ticker,
    kind: row.kind,
    reason: row.reason,
    noBuy: row.no_buy,
    noSell: row.no_sell,
    createdByName: row.created_by_name,
    createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
  };
}

/**
 * Firm-wide exclusions export — every client-level AND account-level standing
 * exclusion, flattened into one list for a single CSV download.
 *
 * Unlike the `/bulk` endpoints this takes no id list: the point is a complete
 * picture for review and audit, so scoping it to ids the caller already knows
 * would defeat it.
 *
 * Names are best-effort enrichment from the cached Warehouse client list (no
 * per-client fetches — one cached call covers both scopes). When Warehouse is
 * unconfigured or a client/account has since left the list, the id columns are
 * still authoritative and the name columns come back empty; the export is never
 * failed over missing enrichment.
 *
 * Registered BEFORE the dynamic `/:clientId` paths so Express doesn't match
 * `exclusions` as a clientId value.
 */
router.get('/exclusions/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      res.json({ data: [] });
      return;
    }

    const [clientRows, accountRows] = await Promise.all([
      pool.query<ExclusionRow>(
        `SELECT id, client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
         FROM client_exclusions
         ORDER BY client_id, kind, ticker`,
      ),
      pool.query<AccountExclusionRow>(
        `SELECT id, account_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
         FROM account_exclusions
         ORDER BY account_id, kind, ticker`,
      ),
    ]);

    // Build both lookups from ONE cached clients call. A Warehouse failure
    // degrades to empty names rather than a failed export.
    const clientNameById = new Map<string, string>();
    const accountByUlid = new Map<string, { clientId: string; clientName: string; accountNumber: string }>();
    if (warehouse.isConfigured()) {
      try {
        for (const c of await warehouse.getCachedClients()) {
          clientNameById.set(c.id, c.name);
          for (const a of c.accounts) {
            accountByUlid.set(a.id, { clientId: c.id, clientName: c.name, accountNumber: a.accountNumber });
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Exclusions export: client-name enrichment unavailable; exporting ids only');
      }
    }

    const toIso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

    const data: ExclusionExportRow[] = [
      ...clientRows.rows.map((row) => ({
        scope: 'client' as const,
        clientId: row.client_id,
        clientName: clientNameById.get(row.client_id) ?? '',
        accountId: '',
        accountNumber: '',
        ticker: row.ticker,
        kind: row.kind,
        reason: row.reason,
        noBuy: row.no_buy,
        noSell: row.no_sell,
        createdByName: row.created_by_name,
        createdAt: toIso(row.created_at),
      })),
      ...accountRows.rows.map((row) => {
        const acct = accountByUlid.get(row.account_id);
        return {
          scope: 'account' as const,
          clientId: acct?.clientId ?? '',
          clientName: acct?.clientName ?? '',
          accountId: row.account_id,
          accountNumber: acct?.accountNumber ?? '',
          ticker: row.ticker,
          kind: row.kind,
          reason: row.reason,
          noBuy: row.no_buy,
          noSell: row.no_sell,
          createdByName: row.created_by_name,
          createdAt: toIso(row.created_at),
        };
      }),
    ];

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// Register the literal /exclusions/bulk path BEFORE the dynamic /:clientId
// paths so Express doesn't try to match `bulk` as a clientId value.
router.post('/exclusions/bulk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = bulkBodySchema.parse(req.body);
    const uniqueIds = [...new Set(body.clientIds)];

    if (req.isDemo) {
      const empty: Record<string, ClientExclusion[]> = {};
      for (const id of uniqueIds) empty[id] = [];
      res.json({ data: empty });
      return;
    }

    const { rows } = await pool.query<ExclusionRow>(
      `SELECT id, client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
       FROM client_exclusions
       WHERE client_id = ANY($1::varchar[])
       ORDER BY client_id, kind, ticker`,
      [uniqueIds],
    );

    const grouped: Record<string, ClientExclusion[]> = {};
    for (const id of uniqueIds) grouped[id] = [];
    for (const row of rows) {
      grouped[row.client_id]!.push(rowToExclusion(row));
    }

    res.json({ data: grouped });
  } catch (err) {
    next(err);
  }
});

router.post('/account-exclusions/bulk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = bulkAccountBodySchema.parse(req.body);
    const uniqueIds = [...new Set(body.accountIds)];

    if (req.isDemo) {
      const empty: Record<string, AccountExclusion[]> = {};
      for (const id of uniqueIds) empty[id] = [];
      res.json({ data: empty });
      return;
    }

    const { rows } = await pool.query<AccountExclusionRow>(
      `SELECT id, account_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
       FROM account_exclusions
       WHERE account_id = ANY($1::varchar[])
       ORDER BY account_id, kind, ticker`,
      [uniqueIds],
    );

    const grouped: Record<string, AccountExclusion[]> = {};
    for (const id of uniqueIds) grouped[id] = [];
    for (const row of rows) {
      grouped[row.account_id]!.push(rowToAccountExclusion(row));
    }

    res.json({ data: grouped });
  } catch (err) {
    next(err);
  }
});

/**
 * Atomic batch endpoint for account-level exclusions. Mirrors the
 * client-level batch semantics (all-or-nothing transaction with add/remove/edit
 * in one Apply click) but scoped to a single account ULID.
 */
router.post('/account-exclusions/:accountId/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accountId = clientIdParamSchema.parse(req.params.accountId);
    const body = batchBodySchema.parse(req.body);
    const user = req.user as AuthUser;

    if (req.isDemo) {
      const nowIso = new Date().toISOString();
      const echoedAdds = body.add.map((a) => ({
        id: '00000000-0000-0000-0000-000000000000',
        accountId,
        ticker: a.ticker,
        kind: a.kind,
        reason: a.reason,
        noBuy: a.noBuy,
        noSell: a.noSell,
        createdByName: user.name,
        createdAt: nowIso,
      }));
      res.json({
        data: {
          exclusions: echoedAdds,
          added: echoedAdds.length,
          removed: body.remove.length,
          edited: body.edit.length,
        },
      });
      return;
    }

    const dbClient = await pool.connect();
    let addedCount = 0;
    let removedCount = 0;
    let editedCount = 0;
    let finalList: AccountExclusion[] = [];
    try {
      await dbClient.query('BEGIN');
      await holdDemoQuota(dbClient, 'exclusions', body.add.length - body.remove.length);

      for (const removeId of body.remove) {
        const { rows: existing } = await dbClient.query<AccountExclusionRow>(
          `SELECT id, account_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
           FROM account_exclusions
           WHERE id = $1 AND account_id = $2`,
          [removeId, accountId],
        );
        if (existing.length === 0) {
          throw new AppError(404, `Exclusion ${removeId} not found for this account`);
        }
        await dbClient.query('DELETE FROM account_exclusions WHERE id = $1', [removeId]);
        removedCount += 1;
      }

      for (const editItem of body.edit) {
        const { rows: existing } = await dbClient.query<AccountExclusionRow>(
          `SELECT id, account_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
           FROM account_exclusions
           WHERE id = $1 AND account_id = $2`,
          [editItem.id, accountId],
        );
        if (existing.length === 0) {
          throw new AppError(404, `Exclusion ${editItem.id} not found for this account`);
        }
        const target = existing[0]!;
        try {
          await dbClient.query(`UPDATE account_exclusions SET no_buy = $1, no_sell = $2 WHERE id = $3`, [
            editItem.noBuy,
            editItem.noSell,
            editItem.id,
          ]);
        } catch (dbErr) {
          const code = (dbErr as { code?: string }).code;
          if (code === '23514') {
            throw new AppError(400, `Exclusion ${editItem.id}: at least one of noBuy or noSell must be true`);
          }
          throw dbErr;
        }
        if (target.no_buy !== editItem.noBuy || target.no_sell !== editItem.noSell) editedCount += 1;
      }

      for (const addItem of body.add) {
        try {
          await dbClient.query(
            `INSERT INTO account_exclusions (account_id, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              accountId,
              addItem.ticker,
              addItem.kind,
              addItem.reason,
              addItem.noBuy,
              addItem.noSell,
              user.id,
              user.name,
            ],
          );
        } catch (dbErr) {
          if ((dbErr as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
            throw new AppError(
              409,
              `${addItem.ticker} is already on the ${addItem.kind} exclusion list for this account.`,
            );
          }
          throw dbErr;
        }
        addedCount += 1;
      }

      const { rows } = await dbClient.query<AccountExclusionRow>(
        `SELECT id, account_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
         FROM account_exclusions
         WHERE account_id = $1
         ORDER BY kind, ticker`,
        [accountId],
      );
      finalList = rows.map(rowToAccountExclusion);

      await dbClient.query('COMMIT');
    } catch (txErr) {
      await dbClient.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      dbClient.release();
    }

    res.json({
      data: {
        exclusions: finalList,
        added: addedCount,
        removed: removedCount,
        edited: editedCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Atomic batch endpoint for v3.3. Replaces the per-row POST/DELETE pattern
 * inside the modal so a single Apply click results in ONE Slack message
 * and ONE in-app notification covering every change in the batch.
 *
 * Semantics (all-or-nothing — plan §v3.3):
 *  - Transaction wraps every DB write.
 *  - Removes are processed before adds so a "swap" (delete TSLA + re-add TSLA)
 *    works without tripping the unique constraint.
 *  - Any unique-violation (23505) on an add → ROLLBACK + 409.
 *  - Any missing-id on a remove → ROLLBACK + 404.
 *  - Notifications fire ONLY after a successful COMMIT, so a rolled-back
 *    batch never produces a misleading Slack message.
 */
router.post('/:clientId/exclusions/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = clientIdParamSchema.parse(req.params.clientId);
    const body = batchBodySchema.parse(req.body);
    const user = req.user as AuthUser;

    if (req.isDemo) {
      // Demo mode echoes back what the client requested as if it succeeded,
      // matching the per-row demo behavior. Returns the full standing list
      // shape (always empty in demo) plus a synthetic summary for the
      // client to optimistically re-render.
      const nowIso = new Date().toISOString();
      const echoedAdds = body.add.map((a) => ({
        id: '00000000-0000-0000-0000-000000000000',
        clientId,
        ticker: a.ticker,
        kind: a.kind,
        reason: a.reason,
        noBuy: a.noBuy,
        noSell: a.noSell,
        createdByName: user.name,
        createdAt: nowIso,
      }));
      res.json({
        data: {
          exclusions: echoedAdds,
          added: echoedAdds.length,
          removed: body.remove.length,
          edited: body.edit.length,
        },
      });
      return;
    }

    const dbClient = await pool.connect();
    type RemovedRow = {
      ticker: string;
      kind: ClientExclusionKind;
      reason: string;
      noBuy: boolean;
      noSell: boolean;
    };
    type AddedRow = {
      ticker: string;
      kind: ClientExclusionKind;
      reason: string;
      noBuy: boolean;
      noSell: boolean;
    };
    type EditedRow = {
      ticker: string;
      kind: ClientExclusionKind;
      before: { noBuy: boolean; noSell: boolean };
      after: { noBuy: boolean; noSell: boolean };
    };
    const removedDetails: RemovedRow[] = [];
    const addedDetails: AddedRow[] = [];
    const editedDetails: EditedRow[] = [];
    let finalList: ClientExclusion[] = [];
    try {
      await dbClient.query('BEGIN');
      await holdDemoQuota(dbClient, 'exclusions', body.add.length - body.remove.length);

      // 1. Removes first. SELECT-then-DELETE so we can include the original
      // reasons in the consolidated Slack message even though the rows are
      // about to disappear. A missing id rolls back the whole batch.
      for (const removeId of body.remove) {
        const { rows: existing } = await dbClient.query<ExclusionRow>(
          `SELECT id, client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
           FROM client_exclusions
           WHERE id = $1 AND client_id = $2`,
          [removeId, clientId],
        );
        if (existing.length === 0) {
          throw new AppError(404, `Exclusion ${removeId} not found for this client`);
        }
        const target = existing[0]!;
        await dbClient.query('DELETE FROM client_exclusions WHERE id = $1', [removeId]);
        removedDetails.push({
          ticker: target.ticker,
          kind: target.kind,
          reason: target.reason,
          noBuy: target.no_buy,
          noSell: target.no_sell,
        });
      }

      // 2. Edits next. SELECT-then-UPDATE so we can capture the before/after
      // flag values for the Slack "Changed:" section. The SELECT scopes to
      // (id, client_id) — this is the regression guard against a cross-tenant
      // edit primitive. A missing id (or an id from a different client) rolls
      // back the whole batch. A no-op edit (after == before) is committed
      // silently but does NOT contribute to the notification.
      for (const editItem of body.edit) {
        const { rows: existing } = await dbClient.query<ExclusionRow>(
          `SELECT id, client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
           FROM client_exclusions
           WHERE id = $1 AND client_id = $2`,
          [editItem.id, clientId],
        );
        if (existing.length === 0) {
          throw new AppError(404, `Exclusion ${editItem.id} not found for this client`);
        }
        const target = existing[0]!;
        // The Zod schema already rejects (false, false) but a defensive
        // catch on the CHECK constraint here keeps the all-or-nothing
        // semantic explicit if a future schema change relaxes that refine.
        try {
          await dbClient.query(`UPDATE client_exclusions SET no_buy = $1, no_sell = $2 WHERE id = $3`, [
            editItem.noBuy,
            editItem.noSell,
            editItem.id,
          ]);
        } catch (dbErr) {
          const code = (dbErr as { code?: string }).code;
          if (code === '23514') {
            throw new AppError(400, `Exclusion ${editItem.id}: at least one of noBuy or noSell must be true`);
          }
          throw dbErr;
        }
        if (target.no_buy !== editItem.noBuy || target.no_sell !== editItem.noSell) {
          editedDetails.push({
            ticker: target.ticker,
            kind: target.kind,
            before: { noBuy: target.no_buy, noSell: target.no_sell },
            after: { noBuy: editItem.noBuy, noSell: editItem.noSell },
          });
        }
      }

      // 3. Then adds. Per-row 23505 → 409. Catching this inside the loop lets
      // the error message identify the offending ticker.
      for (const addItem of body.add) {
        try {
          await dbClient.query(
            `INSERT INTO client_exclusions (client_id, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [clientId, addItem.ticker, addItem.kind, addItem.reason, addItem.noBuy, addItem.noSell, user.id, user.name],
          );
        } catch (dbErr) {
          if ((dbErr as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
            throw new AppError(
              409,
              `${addItem.ticker} is already on the ${addItem.kind} exclusion list for this client.`,
            );
          }
          throw dbErr;
        }
        addedDetails.push({
          ticker: addItem.ticker,
          kind: addItem.kind,
          reason: addItem.reason,
          noBuy: addItem.noBuy,
          noSell: addItem.noSell,
        });
      }

      // Re-read the full standing list so the client can replace its local
      // copy with the authoritative server state instead of merging optimistically.
      const { rows } = await dbClient.query<ExclusionRow>(
        `SELECT id, client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
         FROM client_exclusions
         WHERE client_id = $1
         ORDER BY kind, ticker`,
        [clientId],
      );
      finalList = rows.map(rowToExclusion);

      await dbClient.query('COMMIT');
    } catch (txErr) {
      await dbClient.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      dbClient.release();
    }

    // Post-commit notifications. Single Slack message, single in-app fan-out.
    // Failures here must not leak back to the API response — the DB write
    // already succeeded. No-op edits don't contribute to the notification
    // even if they made it through the COMMIT.
    if (addedDetails.length + removedDetails.length + editedDetails.length > 0) {
      const clientName = await resolveClientName(clientId);
      notifyExclusionBatchChange({
        clientId,
        clientName,
        added: addedDetails,
        removed: removedDetails,
        changed: editedDetails,
        changedBy: user.name,
      });

      const inAppSummary = buildInAppSummary(
        clientName,
        addedDetails.length,
        removedDetails.length,
        editedDetails.length,
      );
      void fetchActiveTraderUserIds()
        .then((ids) => notifyUsersSafe(ids, inAppSummary, null))
        .catch(() => {});
    }

    res.json({
      data: {
        exclusions: finalList,
        added: addedDetails.length,
        removed: removedDetails.length,
        edited: editedDetails.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

function buildInAppSummary(clientName: string, addedCount: number, removedCount: number, editedCount: number): string {
  const parts: string[] = [];
  if (addedCount > 0) parts.push(`+${addedCount}`);
  if (removedCount > 0) parts.push(`-${removedCount}`);
  if (editedCount > 0) parts.push(`~${editedCount}`);
  const total = addedCount + removedCount + editedCount;
  // Single-bucket shortcut for the common case — keeps the bell text readable
  // when there's only one kind of change. Multi-bucket falls back to the
  // composite "+X, -Y, ~Z" form which scales cleanly to all three buckets.
  if (parts.length === 1) {
    if (addedCount > 0) return `${clientName}: ${addedCount} exclusion${addedCount > 1 ? 's' : ''} added`;
    if (removedCount > 0) return `${clientName}: ${removedCount} exclusion${removedCount > 1 ? 's' : ''} removed`;
    return `${clientName}: ${editedCount} exclusion${editedCount > 1 ? 's' : ''} updated`;
  }
  return `${clientName}: ${total} exclusions changed (${parts.join(', ')})`;
}

router.get('/:clientId/exclusions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = clientIdParamSchema.parse(req.params.clientId);

    if (req.isDemo) {
      res.json({ data: [] });
      return;
    }

    const { rows } = await pool.query<ExclusionRow>(
      `SELECT id, client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
       FROM client_exclusions
       WHERE client_id = $1
       ORDER BY kind, ticker`,
      [clientId],
    );

    res.json({ data: rows.map(rowToExclusion) });
  } catch (err) {
    next(err);
  }
});

router.post('/:clientId/exclusions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = clientIdParamSchema.parse(req.params.clientId);
    const body = createBodySchema.parse(req.body);
    const user = req.user as AuthUser;

    if (req.isDemo) {
      const now = new Date().toISOString();
      res.status(201).json({
        data: {
          id: '00000000-0000-0000-0000-000000000000',
          clientId,
          ticker: body.ticker,
          kind: body.kind,
          reason: body.reason,
          noBuy: body.noBuy,
          noSell: body.noSell,
          createdByName: user.name,
          createdAt: now,
        },
      });
      return;
    }

    let inserted: ExclusionRow;
    try {
      const { rows } = await withDemoQuota('exclusions', 1, (db) =>
        db.query<ExclusionRow>(
          `INSERT INTO client_exclusions (client_id, ticker, kind, reason, no_buy, no_sell, created_by, created_by_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at`,
          [clientId, body.ticker, body.kind, body.reason, body.noBuy, body.noSell, user.id, user.name],
        ),
      );
      inserted = rows[0]!;
    } catch (dbErr) {
      if ((dbErr as { code?: string }).code === POSTGRES_UNIQUE_VIOLATION) {
        throw new AppError(409, `${body.ticker} is already on the ${body.kind} exclusion list for this client.`);
      }
      throw dbErr;
    }

    const exclusion = rowToExclusion(inserted);

    // Best-effort downstream notifications. Failures must NOT fail the API call.
    const clientName = await resolveClientName(clientId);
    notifyExclusionChange({
      clientId,
      clientName,
      ticker: exclusion.ticker,
      kind: exclusion.kind,
      reason: exclusion.reason,
      noBuy: exclusion.noBuy,
      noSell: exclusion.noSell,
      action: 'added',
      changedBy: user.name,
    });
    void fetchActiveTraderUserIds()
      .then((ids) =>
        notifyUsersSafe(
          ids,
          `Exclusion added for ${clientName}: ${exclusion.ticker} (${exclusion.kind}, ${formatSide(exclusion.noBuy, exclusion.noSell)})`,
          null,
        ),
      )
      .catch(() => {});

    res.status(201).json({ data: exclusion });
  } catch (err) {
    next(err);
  }
});

router.delete('/:clientId/exclusions/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = clientIdParamSchema.parse(req.params.clientId);
    const id = idParamSchema.parse(req.params.id);
    const user = req.user as AuthUser;

    if (req.isDemo) {
      res.json({ data: { deleted: true } });
      return;
    }

    // SELECT-then-DELETE so the Slack alert can include the original reason
    // (otherwise it's gone after DELETE). The plan (§4B) explicitly calls
    // this out.
    const { rows: existing } = await pool.query<ExclusionRow>(
      `SELECT id, client_id, ticker, kind, reason, no_buy, no_sell, created_by_name, created_at
       FROM client_exclusions
       WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (existing.length === 0) {
      throw new AppError(404, 'Exclusion not found');
    }
    const target = existing[0]!;

    await pool.query('DELETE FROM client_exclusions WHERE id = $1', [id]);

    const clientName = await resolveClientName(clientId);
    notifyExclusionChange({
      clientId,
      clientName,
      ticker: target.ticker,
      kind: target.kind,
      reason: target.reason,
      noBuy: target.no_buy,
      noSell: target.no_sell,
      action: 'removed',
      changedBy: user.name,
    });
    void fetchActiveTraderUserIds()
      .then((ids) =>
        notifyUsersSafe(
          ids,
          `Exclusion removed for ${clientName}: ${target.ticker} (${target.kind}, ${formatSide(target.no_buy, target.no_sell)})`,
          null,
        ),
      )
      .catch(() => {});

    res.json({ data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

/**
 * Best-effort client name lookup for Slack / in-app notifications. The local
 * `clients` table is only seeded in dev/test (Warehouse owns the canonical list
 * in production), so this returns the raw `clientId` as a fallback when no
 * match is found. Notification helpers must remain non-blocking — never let
 * a name lookup failure stop the API call.
 */
async function resolveClientName(clientId: string): Promise<string> {
  try {
    const { rows } = await pool.query<{ name: string }>('SELECT name FROM clients WHERE id = $1', [clientId]);
    return rows[0]?.name ?? clientId;
  } catch {
    return clientId;
  }
}

export default router;
