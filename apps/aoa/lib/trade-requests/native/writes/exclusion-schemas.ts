// Validation schemas ported verbatim from trade-request d41b6c9 server/src/routes/exclusions.ts:14-17, :19-45 and :55-114 (ticket).
// Keep messages unchanged: they reach the user through the delegated error text.
import { z } from "zod";

const TICKER_REGEX = /^[A-Z0-9.-]+$/;

export const clientIdParamSchema = z.string().min(1).max(100);

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
const batchAddItemSchema = createBodySchema; // same per-item rules as the single-row POST
const batchRemoveIdSchema = z.string().uuid('Invalid exclusion id');

// v3.4 — edit step in the batch endpoint. Unlike adds, both noBuy and noSell
// are REQUIRED here (no defaults) because an inline edit is by definition the
// user explicitly choosing the new flag state — silent defaults would mask
// intent.
const batchEditItemSchema = z
  .object({
    id: z.string().uuid('Invalid exclusion id'),
    noBuy: z.boolean(),
    noSell: z.boolean(),
  })
  .refine((v) => v.noBuy || v.noSell, {
    message: 'At least one of noBuy or noSell must be true',
    path: ['noBuy'],
  });

export const batchBodySchema = z
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
