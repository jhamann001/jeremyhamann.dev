import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  TradeRequest,
  Account,
  AccountExecutionPlan,
  AuthChannel,
  BaseAllocation,
  EquityStrategy,
  AuthUser,
  HouseholdSiblingHolding,
  HouseholdHoldingsResponse,
  ChecklistItemKey,
} from '@trade-request/shared';
import { isMaterialAllocationChange, CHECKLIST_ITEM_KEYS } from '@trade-request/shared';
import { fetchChecklist, setChecklistItem } from '../services/requestChecklist.js';
import pool from '../db/pool.js';
import logger from '../lib/logger.js';
import { FORCED_ADVISOR_NAME } from '../lib/advisorDisplay.js';
import * as warehouse from '../services/warehouse.js';
import { runEngine, planGenerationEnabled, refuseIfPlansOff } from '../services/engineUse.js';
import { loadHouseholdConfigCached } from '../services/householdConfigCache.js';
import { ActiveAccountsLoadError } from '../services/meridianActiveAccounts.js';
import { resolveHouseholdsForClients } from '../services/householdResolution.js';
import { fetchLatestDriftAllocationsByAccountId } from '../services/positionDriftAccountsPersistence.js';
import { AppError, sendError } from '../middleware/errorHandler.js';
import { requireRole } from '../middleware/auth.js';
import { notifyNewRequest, notifyStatusChange } from '../services/slack.js';
import { fetchActiveTraderUserIds, notifyUsersSafe } from '../services/notificationInserts.js';
import { holdDemoQuota, useFirmNames } from '../demo/guards.js';
import { DEMO_REQUESTS, DEMO_CLIENTS, demoCounts } from '../fixtures/demo-data.js';
import {
  type DbTradeRequestRow,
  type DbAuditLogRow,
  mapRowToRequest,
  loadRequest,
  findRecentDuplicate,
  getRequestCounts,
  listRequests,
  getRequestForUser,
  getLastAllocation,
  findLastAllocationForClient,
} from '../services/requestQueries.js';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

async function resolveStableAccountIdsForPersistence(
  accounts: Account[],
  fromClientAccountData: boolean,
): Promise<Record<string, string>> {
  if (!fromClientAccountData || accounts.length === 0 || !warehouse.isConfigured()) {
    return {};
  }
  try {
    return await warehouse.getAccountIdMap(accounts.map((account) => account.accountNumber));
  } catch {
    // Request creation remains available if the legacy metadata enrichment is
    // temporarily down. The machine endpoint retries this same resolution when
    // The advisor platform reads the request and reports an unresolved account instead of guessing.
    logger.warn(
      { event: 'request_account_id_persistence_failed', accountCount: accounts.length },
      'Stable account id persistence failed',
    );
    return {};
  }
}

function withForcedAdvisor(request: TradeRequest): TradeRequest {
  // Force the client-of-record advisor display to Rachel Moss while
  // preserving the actual submitter from the source record.
  return { ...request, advisor: FORCED_ADVISOR_NAME };
}

// ─── Validation schemas ──────────────────────────────────────────────────────

const accountDataSchema = z.object({
  accountNumber: z.string().min(1, 'Account number is required').max(100),
  accountType: z.enum(['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA']),
  balance: z.coerce.number().min(0, 'Balance cannot be negative'),
});

const ALLOCATION_TRADE_TYPES = ['Initial Funding', 'Rebalance', 'Cash Deposit'] as const;

const createRequestSchema = z
  .object({
    clientId: z.string().min(1).max(100),
    clientName: z.string().min(1).max(255),
    clientIds: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
    clientNames: z.array(z.string().min(1).max(255)).min(1).max(50).optional(),
    tradeType: z.enum(['Initial Funding', 'Rebalance', 'Cash Deposit', 'Raise Cash', 'Liquidate']),
    tradeAmount: z.string().max(100).default(''),
    depositAccount: z.string().max(100).default(''),
    rebalanceAll: z.boolean().default(false),
    selectedAccounts: z.array(z.string().max(100)).min(1).max(50),
    priority: z.enum(['Urgent', 'Standard', 'Low']),
    advisorNotes: z.string().max(5000).default(''),
    residence: z.enum(['NY', 'CA', 'Other']).default('Other'),
    liquidationApproval: z.enum(['Yes', 'No', '']).default(''),
    advisorExclusions: z.string().max(2000).default(''),
    clientExclusions: z.string().max(2000).default(''),
    esgFilters: z
      .object({
        fossilFuels: z.boolean(),
        tobacco: z.boolean(),
        weapons: z.boolean(),
        alcohol: z.boolean(),
        gambling: z.boolean(),
        other: z.boolean().default(false),
        otherDescription: z.string().max(500).default(''),
        none: z.boolean(),
      })
      .default({
        fossilFuels: false,
        tobacco: false,
        weapons: false,
        alcohol: false,
        gambling: false,
        other: false,
        otherDescription: '',
        none: true,
      }),
    riskProfile: z.number().int().min(1).max(25).nullable().default(null),
    equityStrategies: z
      .array(
        z.object({
          id: z.coerce.number(),
          benchmark: z.string().max(255),
          allocation: z.coerce.number().min(0).max(100),
          rationale: z.string().max(5000),
        }),
      )
      .max(3)
      .default([]),
    raiseCashReason: z.string().max(2000).default(''),
    liquidityDeadline: z
      .string()
      .refine((val) => !val || !isNaN(new Date(val).getTime()), {
        message: 'liquidityDeadline must be a valid date string',
      })
      .nullable()
      .default(null),
    liquidateOption: z.enum(['Entire Account', 'Specific Positions', '']).default(''),
    liquidatePositions: z.string().max(2000).default(''),
    accountsData: z.array(accountDataSchema).max(50).optional(),
    manualEntry: z.boolean().optional(),
    manualAccounts: z.array(accountDataSchema).max(50).optional(),
    idempotencyKey: z.guid().optional(),
    assetLocationMode: z.enum(['priority', 'mirror']).default('priority'),
    // Decision log #5: persisted only at submit time when the resolved
    // selection lives in a single firm household, otherwise both null.
    // `createRequestSchema` is shared between POST and PUT; the PUT
    // handler (`requests.ts:956`) deliberately omits these from its
    // UPDATE so the submit-time tag is immutable after creation.
    householdId: z.number().int().positive().nullable().optional(),
    householdName: z.string().min(1).max(255).nullable().optional(),
  })
  .superRefine((data, ctx) => {
    const isFullForm = (ALLOCATION_TRADE_TYPES as readonly string[]).includes(data.tradeType);

    if (isFullForm) {
      if (data.riskProfile == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Risk profile is required for this trade type',
          path: ['riskProfile'],
        });
      }
      if (!data.residence) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Residence is required for this trade type',
          path: ['residence'],
        });
      }
      if (!data.liquidationApproval) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Liquidation approval is required for this trade type',
          path: ['liquidationApproval'],
        });
      }
      if (data.equityStrategies.length > 0) {
        const totalAlloc = data.equityStrategies.reduce((sum, s) => sum + s.allocation, 0);
        if (Math.abs(totalAlloc - 100) > 0.01) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Equity strategy allocations must sum to 100% (got ${totalAlloc}%)`,
            path: ['equityStrategies'],
          });
        }
        for (let i = 0; i < data.equityStrategies.length; i++) {
          if (!data.equityStrategies[i].benchmark.trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Each equity strategy must have a benchmark',
              path: ['equityStrategies', i, 'benchmark'],
            });
          }
        }
      }
      if (data.tradeType === 'Cash Deposit') {
        if (!data.tradeAmount) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Deposit amount is required', path: ['tradeAmount'] });
        }
        if (!data.depositAccount) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Deposit account is required',
            path: ['depositAccount'],
          });
        }
      }
    }

    if (data.tradeType === 'Raise Cash') {
      if (!data.tradeAmount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Cash amount is required for Raise Cash',
          path: ['tradeAmount'],
        });
      }
      if (!data.raiseCashReason.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Reason is required for Raise Cash',
          path: ['raiseCashReason'],
        });
      }
    }

    if (data.tradeType === 'Liquidate') {
      if (!data.liquidateOption) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Liquidation option is required',
          path: ['liquidateOption'],
        });
      }
      if (data.liquidateOption === 'Specific Positions' && !data.liquidatePositions.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Positions to liquidate must be specified',
          path: ['liquidatePositions'],
        });
      }
    }

    if (data.clientIds && !data.clientNames) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clientNames is required when clientIds is provided',
        path: ['clientNames'],
      });
    }
    if (!data.clientIds && data.clientNames) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clientIds is required when clientNames is provided',
        path: ['clientIds'],
      });
    }
    if (data.clientIds && data.clientNames && data.clientIds.length !== data.clientNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clientIds and clientNames must have the same length',
        path: ['clientNames'],
      });
    }
  });

type CreateRequestBody = z.infer<typeof createRequestSchema>;

const updateStatusSchema = z.object({
  status: z.enum([
    'Pending Review',
    'Needs Info',
    'Pending Current Asset Liquidation',
    'Approved',
    'Rejected',
    'Completed',
  ]),
  note: z.string().max(2000).default(''),
  expectedUpdatedAt: z
    .string()
    .refine((val) => !isNaN(new Date(val).getTime()), { message: 'expectedUpdatedAt must be a valid ISO timestamp' }),
});

const isoTimestamp = z.string().refine((val) => !isNaN(new Date(val).getTime()), {
  message: 'expectedUpdatedAt must be a valid ISO timestamp',
});

// Resubmission's optimistic-concurrency token. Required on the advisor platform
// channel; optional on standalone sessions, whose client does not send it.
const delegatedResubmitConcurrencySchema = z.object({ expectedUpdatedAt: isoTimestamp });
const sessionResubmitConcurrencySchema = z.object({ expectedUpdatedAt: isoTimestamp.optional() });

const paramId = z.string().min(1, 'ID is required').max(50, 'ID is too long');

const runEngineSchema = z.object({
  holdings: z.record(z.string(), 
    z.object({
      cash: z.number().min(0, 'Holdings cannot be negative'),
      fixed: z.number().min(0, 'Holdings cannot be negative'),
      equity: z.number().min(0, 'Holdings cannot be negative'),
    }),
  ),
  // Already-invested same-mandate sibling accounts to hold as fixed context for
  // household-aware asset location (trader-picked; default none ⇒ today's
  // selected-only behavior). Their holdings are fetched live; they are never
  // traded — the engine tags their plans `action: 'recommend'`.
  fixedContextAccountNumbers: z.array(z.string().min(1).max(100)).max(50).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function auditChannel(req: Request): AuthChannel {
  return req.authChannel ?? 'standalone';
}

function generateRequestId(): string {
  return `REQ-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

import { getRiskAllocation } from '@trade-request/shared/allocations';

function toISODate(val: unknown): string | null {
  if (!val) return null;
  const d = val instanceof Date ? val : new Date(String(val));
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
}

async function validateStrategyRationales(body: CreateRequestBody, baseAllocation: BaseAllocation): Promise<void> {
  if (!(ALLOCATION_TRADE_TYPES as readonly string[]).includes(body.tradeType)) return;

  let rationaleRequired = body.tradeType === 'Initial Funding';

  if (['Rebalance', 'Cash Deposit'].includes(body.tradeType)) {
    const isManualClient = body.manualEntry === true || body.clientId.startsWith('manual-');
    const previousAllocation = isManualClient ? null : await findLastAllocationForClient(body.clientId);
    rationaleRequired =
      !previousAllocation ||
      isMaterialAllocationChange(
        { riskProfile: body.riskProfile!, baseAllocation, equityStrategies: body.equityStrategies },
        previousAllocation,
      );
  }

  if (!rationaleRequired) return;

  const issues: z.ZodIssue[] = body.equityStrategies.flatMap((strategy, index) =>
    strategy.rationale.trim()
      ? []
      : [
          {
            code: z.ZodIssueCode.custom,
            message: 'Each equity strategy must have a rationale for a new or materially changed allocation',
            path: ['equityStrategies', index, 'rationale'],
          },
        ],
  );

  if (issues.length > 0) {
    throw new z.ZodError(issues);
  }
}

async function lookupAccountTypes(accountNumbers: string[]): Promise<Record<string, Account['accountType']>> {
  if (warehouse.isConfigured()) {
    return warehouse.getAccountTypeMap(accountNumbers);
  }
  const { rows } = await pool.query(
    'SELECT account_number, account_type FROM accounts WHERE account_number = ANY($1)',
    [accountNumbers],
  );
  const map: Record<string, Account['accountType']> = {};
  for (const row of rows) {
    map[row.account_number] = row.account_type;
  }
  return map;
}

async function lookupAccountClientIds(accountNumbers: string[]): Promise<Record<string, string>> {
  if (warehouse.isConfigured()) {
    return warehouse.getAccountClientIdMap(accountNumbers);
  }
  const { rows } = await pool.query('SELECT account_number, client_id FROM accounts WHERE account_number = ANY($1)', [
    accountNumbers,
  ]);
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.account_number] = row.client_id;
  }
  return map;
}

function buildClientNameMap(clientIds: string[], clientNames: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  clientIds.forEach((id, i) => {
    map[id] = clientNames[i] ?? '';
  });
  return map;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get('/counts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      res.json(demoCounts());
      return;
    }
    res.json(await getRequestCounts(req.user as AuthUser));
  } catch (err) {
    next(err);
  }
});

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    before: z.string().max(200).optional(),
    all: z.enum(['true', 'false']).optional(),
    q: z.string().max(200).optional(),
  })
  .refine((data) => !(data.all === 'true' && data.q != null && data.q.trim().length > 0), {
    message: 'Cannot combine search (q) with export mode (all=true)',
    path: ['q'],
  });

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      const q = (req.query.q as string | undefined)?.trim().toLowerCase() ?? '';
      const filtered = q
        ? DEMO_REQUESTS.filter(
            (r) =>
              r.id.toLowerCase().includes(q) ||
              r.clientName.toLowerCase().includes(q) ||
              r.tradeType.toLowerCase().includes(q) ||
              r.status.toLowerCase().includes(q) ||
              FORCED_ADVISOR_NAME.toLowerCase().includes(q) ||
              r.submittedBy.toLowerCase().includes(q),
          )
        : DEMO_REQUESTS;
      res.json({ data: filtered.map(withForcedAdvisor), nextCursor: null });
      return;
    }

    const query = listQuerySchema.parse(req.query);
    const result = await listRequests(req.user as AuthUser, {
      limit: query.limit,
      before: query.before,
      q: query.q,
      fetchAll: query.all === 'true',
    });

    if (result.truncated !== undefined) {
      res.json({ data: result.data, truncated: result.truncated });
      return;
    }
    res.json({ data: result.data, nextCursor: result.nextCursor });
  } catch (err) {
    next(err);
  }
});

// ─── Last allocation for a client ────────────────────────────────────────────
// Registered before /:id so the static segment is not shadowed by the param.

router.get('/last-allocation/:clientId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      const cid = String(req.params.clientId);
      const match = DEMO_REQUESTS.find(
        (r) =>
          r.clientIds.includes(cid) &&
          ['Initial Funding', 'Rebalance'].includes(r.tradeType) &&
          ['Approved', 'Completed'].includes(r.status) &&
          r.riskProfile != null,
      );
      if (!match) {
        res.json(null);
        return;
      }
      res.json({
        riskProfile: match.riskProfile,
        baseAllocation: match.baseAllocation,
        equityStrategies: match.equityStrategies,
      });
      return;
    }

    const clientId = paramId.parse(req.params.clientId);
    res.json(await getLastAllocation(req.user as AuthUser, clientId));
  } catch (err) {
    next(err);
  }
});

// ─── Get single request ──────────────────────────────────────────────────────

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      const match = DEMO_REQUESTS.find((r) => r.id === req.params.id);
      if (!match) {
        sendError(res, 404, `Request ${req.params.id} not found`);
        return;
      }
      res.json({ data: withForcedAdvisor(match) });
      return;
    }

    const id = paramId.parse(req.params.id);
    res.json({ data: await getRequestForUser(req.user as AuthUser, id) });
  } catch (err) {
    next(err);
  }
});

// ─── Create request (both advisors and traders can create) ──────────────────

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createRequestSchema.parse(req.body);
    body.selectedAccounts = [...new Set(body.selectedAccounts)];
    await useFirmNames(body);

    if (req.isDemo) {
      const user = req.user as AuthUser;
      const now = new Date().toISOString();
      const fakeId = `REQ-DEMO${String(Date.now()).slice(-4)}`;
      const demoRequest: TradeRequest = {
        id: fakeId,
        clientId: body.clientId,
        clientName: body.clientName,
        clientIds: body.clientIds ?? [body.clientId],
        clientNames: body.clientNames ?? [body.clientName],
        advisor: FORCED_ADVISOR_NAME,
        submittedBy: user.name,
        tradeType: body.tradeType,
        tradeAmount: body.tradeAmount ?? '',
        depositAccount: body.depositAccount ?? '',
        rebalanceAll: body.rebalanceAll ?? false,
        status: 'Pending Review',
        date: now,
        updatedAt: now,
        selectedAccounts: body.selectedAccounts,
        totalValue: 0,
        priority: body.priority ?? 'Standard',
        advisorNotes: body.advisorNotes ?? '',
        residence: body.residence ?? 'Other',
        liquidationApproval: body.liquidationApproval ?? '',
        advisorExclusions: body.advisorExclusions ?? '',
        clientExclusions: body.clientExclusions ?? '',
        esgFilters: body.esgFilters ?? {
          fossilFuels: false,
          tobacco: false,
          weapons: false,
          alcohol: false,
          gambling: false,
          other: false,
          otherDescription: '',
          none: true,
        },
        riskProfile: body.riskProfile ?? null,
        baseAllocation: { equity: 0, fixed: 0, cash: 0 },
        equityStrategies: body.equityStrategies ?? [],
        raiseCashReason: body.raiseCashReason ?? '',
        liquidityDeadline: body.liquidityDeadline ?? null,
        liquidateOption: body.liquidateOption ?? '',
        liquidatePositions: body.liquidatePositions ?? '',
        executionPlan: [],
        auditLog: [
          { date: now, user: user.name, action: 'Created Request', notes: 'Demo mode.', channel: 'standalone' },
        ],
      };
      res.status(201).json({ data: demoRequest });
      return;
    }
    const user = req.user as AuthUser;

    // ─── Duplicate-submission guards ─────────────────────────────────────────
    // Both run BEFORE account resolution and the asset-location engine: a retry
    // shouldn't pay for the Warehouse fan-out that made the first attempt slow
    // enough to time out in the first place.
    //
    // Guard 1 is the client-supplied idempotency key. Guard 2 matches on
    // content and needs nothing from the client, so it holds even if the client
    // sends no key, sends a fresh one after a failed attempt, or the advisor
    // submits from a second tab. Either way we return the request that already
    // exists rather than creating another — the advisor's browser then lands on
    // the real request instead of showing a second failure.
    const returnExisting = async (existingId: string, reason: 'idempotency-key' | 'duplicate-content') => {
      if (reason === 'duplicate-content') {
        logger.warn(
          {
            existingId,
            advisorId: user.id,
            tradeType: body.tradeType,
            clientCount: (body.clientIds ?? [body.clientId]).length,
            accountCount: body.selectedAccounts.length,
          },
          'Suppressed duplicate trade request submission',
        );
        // Record the suppressed attempt on the surviving request. Best-effort:
        // a failure here must not turn a successful dedup into a 500.
        try {
          await pool.query(
            'INSERT INTO audit_logs (request_id, user_name, user_id, action, notes, channel) VALUES ($1,$2,$3,$4,$5,$6)',
            [
              existingId,
              user.name,
              user.id,
              'Duplicate Submission Suppressed',
              'An identical request was submitted again within the duplicate-detection window; no new request was created.',
              auditChannel(req),
            ],
          );
        } catch (err) {
          logger.error({ err, existingId }, 'Failed to log suppressed duplicate submission');
        }
      }
      const dup = await loadRequest(existingId);
      res.status(200).json({ data: dup });
    };

    if (body.idempotencyKey) {
      const { rows: existing } = await pool.query(
        'SELECT id FROM trade_requests WHERE idempotency_key = $1 AND advisor_id = $2',
        [body.idempotencyKey, user.id],
      );
      if (existing.length > 0) {
        await returnExisting(existing[0].id, 'idempotency-key');
        return;
      }
    }

    const recentDuplicateId = await findRecentDuplicate({
      advisorId: user.id,
      clientId: body.clientId,
      tradeType: body.tradeType,
      tradeAmount: body.tradeAmount || null,
      selectedAccounts: body.selectedAccounts,
    });
    if (recentDuplicateId) {
      await returnExisting(recentDuplicateId, 'duplicate-content');
      return;
    }

    if (!body.manualEntry && user.role === 'advisor') {
      const allClientIds = body.clientIds ?? [body.clientId];
      if (warehouse.isConfigured()) {
        for (const cId of allClientIds) {
          const accts = await warehouse.getClientAccounts(cId);
          if (accts.length === 0) {
            throw new AppError(403, `Client ${cId} not found or you do not have access`);
          }
        }
      }
    }

    const isFullForm = ['Initial Funding', 'Rebalance', 'Cash Deposit'].includes(body.tradeType);
    const baseAllocation =
      isFullForm && body.riskProfile ? getRiskAllocation(body.riskProfile) : { equity: 0, fixed: 0, cash: 0 };

    let accounts: Account[];
    if (body.manualEntry && body.manualAccounts?.length) {
      accounts = body.manualAccounts.map((a, i) => ({
        id: a.accountNumber || `manual-${Date.now()}-${i}`,
        clientId: body.clientId,
        accountNumber: a.accountNumber,
        accountType: a.accountType,
        balance: a.balance,
        holdings: { cash: a.balance, fixed: 0, equity: 0 },
      }));
    } else if (body.accountsData?.length) {
      const acctDataMap = new Map(body.accountsData.map((a) => [a.accountNumber, a]));
      const missing = body.selectedAccounts.filter((n) => !acctDataMap.has(n));
      if (missing.length > 0) {
        throw new AppError(400, `Account data missing for: ${missing.join(', ')}`);
      }
      accounts = body.selectedAccounts.map((n) => {
        const a = acctDataMap.get(n)!;
        return {
          id: a.accountNumber,
          clientId: body.clientId,
          accountNumber: a.accountNumber,
          accountType: a.accountType,
          balance: a.balance,
          holdings: { cash: a.balance, fixed: 0, equity: 0 },
        };
      });
    } else if (warehouse.isConfigured()) {
      const allClientIds = body.clientIds ?? [body.clientId];
      let warehouseAccounts: Account[] = [];
      try {
        const results = await Promise.all(allClientIds.map((cId) => warehouse.getClientAccounts(cId)));
        warehouseAccounts = results.flat();
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new AppError(
          502,
          isTimeout
            ? 'Account data source timed out. Please try again in a moment.'
            : 'Unable to retrieve account data. Please try again later.',
        );
      }
      const warehouseAcctMap = new Map(warehouseAccounts.map((a) => [a.accountNumber, a]));
      const missing = body.selectedAccounts.filter((n) => !warehouseAcctMap.has(n));
      if (missing.length > 0) {
        throw new AppError(400, `Account(s) not found for the selected client(s): ${missing.join(', ')}`);
      }
      accounts = body.selectedAccounts.map((n) => warehouseAcctMap.get(n)!);
    } else {
      const allClientIds = body.clientIds ?? [body.clientId];
      const { rows: accountRows } = await pool.query(
        'SELECT * FROM accounts WHERE account_number = ANY($1) AND client_id = ANY($2)',
        [body.selectedAccounts, allClientIds],
      );
      if (accountRows.length !== body.selectedAccounts.length) {
        throw new AppError(400, 'One or more selected accounts do not belong to the specified client(s)');
      }
      interface DbAccountRow {
        id: string;
        client_id: string;
        account_number: string;
        account_type: string;
        balance: string;
        cash_holding: string;
        fixed_holding: string;
        equity_holding: string;
      }
      accounts = accountRows.map((row: DbAccountRow) => ({
        id: row.id,
        clientId: row.client_id,
        accountNumber: row.account_number,
        accountType: row.account_type as Account['accountType'],
        balance: parseFloat(row.balance) || 0,
        holdings: {
          cash: parseFloat(row.cash_holding) || 0,
          fixed: parseFloat(row.fixed_holding) || 0,
          equity: parseFloat(row.equity_holding) || 0,
        },
      }));
    }

    const totalValue = accounts.reduce((sum, a) => sum + a.balance, 0);
    const accountIdByNumber = await resolveStableAccountIdsForPersistence(
      accounts,
      !body.manualEntry && Boolean(body.accountsData?.length),
    );
    await validateStrategyRationales(body, baseAllocation);

    const rebalanceAll = ['Initial Funding', 'Rebalance'].includes(body.tradeType) ? true : body.rebalanceAll;

    const resolvedIds = body.clientIds ?? [body.clientId];
    const resolvedNames = body.clientNames ?? [body.clientName];
    const clientNameMap = buildClientNameMap(resolvedIds, resolvedNames);

    let executionPlan: AccountExecutionPlan[] = [];
    if (planGenerationEnabled() && ['Initial Funding', 'Rebalance'].includes(body.tradeType) && body.riskProfile) {
      const { plans } = await runEngine('service', {
        tradeType: body.tradeType,
        tradeAmount: body.tradeAmount,
        depositAccountNumber: body.depositAccount,
        rebalanceAll,
        totalValue,
        baseAllocation,
        riskProfile: body.riskProfile,
        clientName: body.clientName,
        clientNameMap,
        accounts,
        equityStrategies: body.equityStrategies,
        residence: body.residence,
        assetLocationMode: body.assetLocationMode,
      });
      executionPlan = plans;
    }

    let auditNote: string;
    if (isFullForm) {
      auditNote = `Risk Profile ${body.riskProfile} applied.`;
    } else if (body.tradeType === 'Raise Cash') {
      auditNote = `Cash raise requested: ${body.tradeAmount}. Priority: ${body.priority}.`;
    } else {
      auditNote = `${body.liquidateOption} liquidation requested. Priority: ${body.priority}.`;
    }

    // NOTE: the idempotency-key and duplicate-content checks now run near the
    // top of this handler, before account resolution. The 23505 recovery inside
    // the insert loop below still covers the race where a concurrent request
    // commits between our check and our insert.

    let insertedRow!: DbTradeRequestRow;
    let auditRow!: DbAuditLogRow;
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const id = generateRequestId();
      const txClient = await pool.connect();
      try {
        await txClient.query('BEGIN');
        await holdDemoQuota(txClient, 'requests', 1);

        const resolvedClientIds = body.clientIds ?? [body.clientId];
        const resolvedClientNames = body.clientNames ?? [body.clientName];

        const {
          rows: [trRow],
        } = await txClient.query(
          `INSERT INTO trade_requests
            (id, client_id, client_name, client_ids, client_names, advisor_id, trade_type, trade_amount, deposit_account, rebalance_all, status, total_value,
             selected_accounts, account_metadata, priority, advisor_notes,
             residence, liquidation_approval, advisor_exclusions, client_exclusions,
             esg_filters, risk_profile, base_allocation, equity_strategies,
             raise_cash_reason, liquidity_deadline, liquidate_option, liquidate_positions,
             execution_plan, idempotency_key, asset_location_mode,
             household_id, household_name,
             created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,date_trunc('milliseconds', NOW()),date_trunc('milliseconds', NOW()))
           RETURNING *`,
          [
            id,
            body.clientId,
            body.clientName,
            JSON.stringify(resolvedClientIds),
            JSON.stringify(resolvedClientNames),
            user.id,
            body.tradeType,
            body.tradeAmount || null,
            body.depositAccount || null,
            rebalanceAll,
            'Pending Review',
            totalValue,
            body.selectedAccounts,
            JSON.stringify(
              accounts.map((a) => ({
                accountId: body.manualEntry
                  ? null
                  : (accountIdByNumber[a.accountNumber] ?? (body.accountsData?.length ? null : a.id)),
                accountNumber: a.accountNumber,
                accountType: a.accountType,
                balance: a.balance,
              })),
            ),
            body.priority,
            body.advisorNotes || null,
            isFullForm ? body.residence : null,
            isFullForm ? body.liquidationApproval === 'Yes' : null,
            isFullForm ? body.advisorExclusions || null : null,
            isFullForm ? body.clientExclusions || null : null,
            isFullForm ? JSON.stringify(body.esgFilters) : null,
            isFullForm ? body.riskProfile : null,
            isFullForm ? JSON.stringify(baseAllocation) : null,
            isFullForm ? JSON.stringify(body.equityStrategies) : null,
            body.tradeType === 'Raise Cash' ? body.raiseCashReason || null : null,
            body.tradeType === 'Raise Cash' && body.liquidityDeadline ? toISODate(body.liquidityDeadline) : null,
            body.tradeType === 'Liquidate' ? body.liquidateOption || null : null,
            body.tradeType === 'Liquidate' ? body.liquidatePositions || null : null,
            executionPlan.length > 0 ? JSON.stringify(executionPlan) : null,
            body.idempotencyKey || null,
            body.assetLocationMode,
            // Decision log #5 + DB CHECK constraint
            // `trade_requests_household_id_name_paired`: both NULL or both set.
            // The route enforces the pairing at the application layer here so a
            // client that sends one field but not the other is normalized to
            // (null, null) before hitting the DB constraint.
            body.householdId != null && body.householdName != null ? body.householdId : null,
            body.householdId != null && body.householdName != null ? body.householdName : null,
          ],
        );

        const {
          rows: [aRow],
        } = await txClient.query(
          'INSERT INTO audit_logs (request_id, user_name, user_id, action, notes, channel) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
          [id, user.name, user.id, 'Created Request', auditNote, auditChannel(req)],
        );

        await txClient.query('COMMIT');
        insertedRow = trRow;
        auditRow = aRow;
        break;
      } catch (err: unknown) {
        try {
          await txClient.query('ROLLBACK');
        } catch {
          /* best-effort */
        }
        if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
          if (body.idempotencyKey) {
            const { rows: existing } = await pool.query(
              'SELECT id FROM trade_requests WHERE idempotency_key = $1 AND advisor_id = $2',
              [body.idempotencyKey, user.id],
            );
            if (existing.length > 0) {
              const dup = await loadRequest(existing[0].id);
              res.status(200).json({ data: dup });
              return;
            }
          }
          if (attempt < MAX_RETRIES - 1) continue;
        }
        throw err;
      } finally {
        txClient.release();
      }
    }

    // Note: we no longer overwrite `advisor_name` on the inserted row — that
    // column carries the actual submitter (joined from `users.name`) and is
    // surfaced as `submittedBy` by `mapRowToRequest`. The `advisor` display
    // is forced to Rachel Moss inside `mapRowToRequest`.
    insertedRow.advisor_name = user.name;
    const request = mapRowToRequest(insertedRow, [auditRow]);

    notifyNewRequest({
      requestId: request.id,
      clientName: request.clientName,
      clientNames: body.clientNames,
      tradeType: body.tradeType,
      priority: body.priority,
      submittedBy: user.name,
      totalValue,
      accounts: body.selectedAccounts,
      advisorNotes: body.advisorNotes || undefined,
    });

    void fetchActiveTraderUserIds()
      .then((ids) =>
        notifyUsersSafe(ids, `New trade request ${request.id} submitted for ${request.clientName}`, request.id),
      )
      .catch((err) => logger.error({ err }, 'Failed to enqueue trader notifications for new request'));

    res.status(201).json({ data: request });
  } catch (err) {
    next(err);
  }
});

// ─── Resubmit / update request ("Needs Info" status) ────────────────────────
// Advisors can only resubmit their own requests. Traders can resubmit any
// request — this is intentional so ops can unblock workflows on an advisor's
// behalf (e.g. advisor is out of office).

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = paramId.parse(req.params.id);
    const body = createRequestSchema.parse(req.body);
    await useFirmNames(body);
    body.selectedAccounts = [...new Set(body.selectedAccounts)];
    const { expectedUpdatedAt } = (
      req.authChannel === 'opsPortal' ? delegatedResubmitConcurrencySchema : sessionResubmitConcurrencySchema
    ).parse(req.body);

    if (req.isDemo) {
      const match = DEMO_REQUESTS.find((r) => r.id === id);
      if (!match) {
        sendError(res, 404, `Request ${id} not found`);
        return;
      }
      res.json({
        data: withForcedAdvisor({ ...match, status: 'Pending Review', updatedAt: new Date().toISOString() }),
      });
      return;
    }
    const user = req.user as AuthUser;

    const { rows: existing } = await pool.query<DbTradeRequestRow>('SELECT * FROM trade_requests WHERE id = $1', [id]);
    if (existing.length === 0) throw new AppError(404, `Request ${id} not found`);

    const row = existing[0];
    if (user.role === 'advisor' && row.advisor_id !== user.id) {
      throw new AppError(403, 'You do not have access to this request');
    }
    if (expectedUpdatedAt && new Date(row.updated_at).getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw new AppError(409, 'Request was modified by another user. Please refresh and try again.');
    }
    if (row.status !== 'Needs Info') {
      throw new AppError(409, 'Only requests in "Needs Info" status can be resubmitted.');
    }

    const isFullForm = ['Initial Funding', 'Rebalance', 'Cash Deposit'].includes(body.tradeType);
    const baseAllocation =
      isFullForm && body.riskProfile ? getRiskAllocation(body.riskProfile) : { equity: 0, fixed: 0, cash: 0 };

    let accounts: Account[];
    if (body.manualEntry && body.manualAccounts?.length) {
      accounts = body.manualAccounts.map((a, i) => ({
        id: a.accountNumber || `manual-${Date.now()}-${i}`,
        clientId: body.clientId,
        accountNumber: a.accountNumber,
        accountType: a.accountType,
        balance: a.balance,
        holdings: { cash: a.balance, fixed: 0, equity: 0 },
      }));
    } else if (body.accountsData?.length) {
      const acctDataMap = new Map(body.accountsData.map((a) => [a.accountNumber, a]));
      const missing = body.selectedAccounts.filter((n) => !acctDataMap.has(n));
      if (missing.length > 0) {
        throw new AppError(400, `Account data missing for: ${missing.join(', ')}`);
      }
      accounts = body.selectedAccounts.map((n) => {
        const a = acctDataMap.get(n)!;
        return {
          id: a.accountNumber,
          clientId: body.clientId,
          accountNumber: a.accountNumber,
          accountType: a.accountType,
          balance: a.balance,
          holdings: { cash: a.balance, fixed: 0, equity: 0 },
        };
      });
    } else if (warehouse.isConfigured()) {
      const allClientIds = body.clientIds ?? [body.clientId];
      let warehouseAccounts: Account[] = [];
      try {
        const results = await Promise.all(allClientIds.map((cId) => warehouse.getClientAccounts(cId)));
        warehouseAccounts = results.flat();
      } catch (err) {
        const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        throw new AppError(
          502,
          isTimeout
            ? 'Account data source timed out. Please try again in a moment.'
            : 'Unable to retrieve account data. Please try again later.',
        );
      }
      const warehouseAcctMap = new Map(warehouseAccounts.map((a) => [a.accountNumber, a]));
      const missingAccts = body.selectedAccounts.filter((n) => !warehouseAcctMap.has(n));
      if (missingAccts.length > 0) {
        throw new AppError(400, `Account(s) not found for the selected client(s): ${missingAccts.join(', ')}`);
      }
      accounts = body.selectedAccounts.map((n) => warehouseAcctMap.get(n)!);
    } else {
      const allClientIds = body.clientIds ?? [body.clientId];
      const { rows: accountRows } = await pool.query(
        'SELECT * FROM accounts WHERE account_number = ANY($1) AND client_id = ANY($2)',
        [body.selectedAccounts, allClientIds],
      );
      if (accountRows.length !== body.selectedAccounts.length) {
        throw new AppError(400, 'One or more selected accounts do not belong to the specified client(s)');
      }
      interface DbAccountRow {
        id: string;
        client_id: string;
        account_number: string;
        account_type: string;
        balance: string;
        cash_holding: string;
        fixed_holding: string;
        equity_holding: string;
      }
      accounts = accountRows.map((ar: DbAccountRow) => ({
        id: ar.id,
        clientId: ar.client_id,
        accountNumber: ar.account_number,
        accountType: ar.account_type as Account['accountType'],
        balance: parseFloat(ar.balance) || 0,
        holdings: {
          cash: parseFloat(ar.cash_holding) || 0,
          fixed: parseFloat(ar.fixed_holding) || 0,
          equity: parseFloat(ar.equity_holding) || 0,
        },
      }));
    }

    const totalValue = accounts.reduce((sum, a) => sum + a.balance, 0);
    const accountIdByNumber = await resolveStableAccountIdsForPersistence(
      accounts,
      !body.manualEntry && Boolean(body.accountsData?.length),
    );
    await validateStrategyRationales(body, baseAllocation);
    const rebalanceAll = ['Initial Funding', 'Rebalance'].includes(body.tradeType) ? true : body.rebalanceAll;

    const resolvedIds = body.clientIds ?? [body.clientId];
    const resolvedNames = body.clientNames ?? [body.clientName];
    const clientNameMap = buildClientNameMap(resolvedIds, resolvedNames);

    let executionPlan: AccountExecutionPlan[] = [];
    if (planGenerationEnabled() && ['Initial Funding', 'Rebalance'].includes(body.tradeType) && body.riskProfile) {
      const { plans } = await runEngine('service', {
        tradeType: body.tradeType,
        tradeAmount: body.tradeAmount,
        depositAccountNumber: body.depositAccount,
        rebalanceAll,
        totalValue,
        baseAllocation,
        riskProfile: body.riskProfile,
        clientName: body.clientName,
        clientNameMap,
        accounts,
        equityStrategies: body.equityStrategies,
        residence: body.residence,
        assetLocationMode: body.assetLocationMode,
      });
      executionPlan = plans;
    }

    const txClient = await pool.connect();
    try {
      await txClient.query('BEGIN');

      // Decision log #5: `household_id` and `household_name` are
      // submit-time-only and immutable after creation. DO NOT add them
      // to this UPDATE — the regression test
      // `requests.test.ts → PUT does not mutate persisted household tag`
      // guards this contract.
      const updateResult = await txClient.query(
        `UPDATE trade_requests SET
          client_id = $1, client_name = $2, client_ids = $3, client_names = $4,
          trade_type = $5, trade_amount = $6, deposit_account = $7, rebalance_all = $8,
          status = 'Pending Review', total_value = $9,
          selected_accounts = $10, account_metadata = $11, priority = $12, advisor_notes = $13,
          residence = $14, liquidation_approval = $15, advisor_exclusions = $16, client_exclusions = $17,
          esg_filters = $18, risk_profile = $19, base_allocation = $20, equity_strategies = $21,
          raise_cash_reason = $22, liquidity_deadline = $23, liquidate_option = $24, liquidate_positions = $25,
          ${planGenerationEnabled() ? 'execution_plan = $26' : 'execution_plan = COALESCE($26::jsonb, execution_plan)'}, asset_location_mode = $27, updated_at = date_trunc('milliseconds', NOW())
        WHERE id = $28 AND status = 'Needs Info'${expectedUpdatedAt ? ' AND updated_at = $29' : ''}
        RETURNING id`,
        [
          body.clientId,
          body.clientName,
          JSON.stringify(resolvedIds),
          JSON.stringify(resolvedNames),
          body.tradeType,
          body.tradeAmount || null,
          body.depositAccount || null,
          rebalanceAll,
          totalValue,
          body.selectedAccounts,
          JSON.stringify(
            accounts.map((a) => ({
              accountId: body.manualEntry
                ? null
                : (accountIdByNumber[a.accountNumber] ?? (body.accountsData?.length ? null : a.id)),
              accountNumber: a.accountNumber,
              accountType: a.accountType,
              balance: a.balance,
            })),
          ),
          body.priority,
          body.advisorNotes || null,
          isFullForm ? body.residence : null,
          isFullForm ? body.liquidationApproval === 'Yes' : null,
          isFullForm ? body.advisorExclusions || null : null,
          isFullForm ? body.clientExclusions || null : null,
          isFullForm ? JSON.stringify(body.esgFilters) : null,
          isFullForm ? body.riskProfile : null,
          isFullForm ? JSON.stringify(baseAllocation) : null,
          isFullForm ? JSON.stringify(body.equityStrategies) : null,
          body.tradeType === 'Raise Cash' ? body.raiseCashReason || null : null,
          body.tradeType === 'Raise Cash' && body.liquidityDeadline ? toISODate(body.liquidityDeadline) : null,
          body.tradeType === 'Liquidate' ? body.liquidateOption || null : null,
          body.tradeType === 'Liquidate' ? body.liquidatePositions || null : null,
          executionPlan.length > 0 ? JSON.stringify(executionPlan) : null,
          body.assetLocationMode,
          id,
          ...(expectedUpdatedAt ? [expectedUpdatedAt] : []),
        ],
      );

      if (updateResult.rows.length === 0) {
        throw new AppError(409, 'Request was modified by another user. Please refresh and try again.');
      }

      await txClient.query(
        'INSERT INTO audit_logs (request_id, user_name, user_id, action, notes, channel) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          id,
          user.name,
          user.id,
          'Request Resubmitted',
          body.advisorNotes || 'Advisor updated and resubmitted request.',
          auditChannel(req),
        ],
      );

      await txClient.query('COMMIT');
    } catch (err) {
      try {
        await txClient.query('ROLLBACK');
      } catch {
        /* rollback best-effort */
      }
      throw err;
    } finally {
      txClient.release();
    }

    const request = await loadRequest(id);

    notifyStatusChange({
      requestId: id,
      clientName: body.clientName,
      newStatus: 'Pending Review',
      note: 'Advisor resubmitted request with updates.',
      changedBy: user.name,
      advisorSlackId: null,
    });

    void fetchActiveTraderUserIds()
      .then((traderIds) => notifyUsersSafe(traderIds, `Trade request ${id} resubmitted for ${body.clientName}`, id))
      .catch((err) => logger.error({ err }, 'Failed to enqueue trader notifications for resubmit'));

    res.json({ data: request });
  } catch (err) {
    next(err);
  }
});

// ─── Update status (traders only) ───────────────────────────────────────────

const checklistBodySchema = z.object({
  key: z.enum(CHECKLIST_ITEM_KEYS as unknown as [string, ...string[]]),
  checked: z.boolean(),
  value: z.string().max(2000).optional(),
});

// Pre-approval checklist. GET is mount-level requireAuth (any user who reaches
// the request). NOTE for prod hardening: route GET through the same per-user
// visibility as GET /:id. PUT is trader-only and locks once the request is decided.
router.get('/:id/checklist', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      res.json({ checklist: {} });
      return;
    }
    const id = paramId.parse(req.params.id);
    const checklist = await fetchChecklist(pool, id);
    if (checklist === null) throw new AppError(404, `Request ${id} not found`);
    res.json({ checklist });
  } catch (err) {
    if (err instanceof z.ZodError) {
      sendError(res, 400, 'Validation failed');
      return;
    }
    next(err);
  }
});

router.put('/:id/checklist', requireRole('trader'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      res.json({ checklist: {} });
      return;
    }
    const id = paramId.parse(req.params.id);
    const body = checklistBodySchema.parse(req.body);
    const user = req.user as AuthUser;
    const result = await setChecklistItem(
      pool,
      id,
      body.key as ChecklistItemKey,
      { checked: body.checked, value: body.value },
      user.name,
    );
    if (!result.ok) {
      if (result.reason === 'not_found') throw new AppError(404, `Request ${id} not found`);
      throw new AppError(409, 'Checklist is locked — the request has already been decided.');
    }
    res.json({ checklist: result.checklist });
  } catch (err) {
    if (err instanceof z.ZodError) {
      sendError(res, 400, 'Validation failed');
      return;
    }
    next(err);
  }
});

router.put('/:id/status', requireRole('trader'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.isDemo) {
      const match = DEMO_REQUESTS.find((r) => r.id === req.params.id);
      if (!match) {
        sendError(res, 404, `Request ${req.params.id} not found`);
        return;
      }
      const newStatus = req.body.status ?? match.status;
      res.json({ data: withForcedAdvisor({ ...match, status: newStatus, updatedAt: new Date().toISOString() }) });
      return;
    }

    const id = paramId.parse(req.params.id);
    const body = updateStatusSchema.parse(req.body);
    const user = req.user as AuthUser;

    const { rows: existing } = await pool.query<{
      status: string;
      client_id: string;
      client_name: string | null;
      advisor_id: string | null;
      advisor_slack_id: string | null;
    }>(
      `SELECT tr.status, tr.client_id, tr.client_name, tr.advisor_id, u.slack_user_id AS advisor_slack_id
       FROM trade_requests tr
       LEFT JOIN users u ON u.id = tr.advisor_id
       WHERE tr.id = $1`,
      [id],
    );
    if (existing.length === 0) throw new AppError(404, `Request ${id} not found`);

    if (['Approved', 'Rejected', 'Completed'].includes(existing[0].status)) {
      throw new AppError(409, `Cannot modify a ${existing[0].status.toLowerCase()} request.`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const updateResult = await client.query(
        "UPDATE trade_requests SET status = $1, updated_at = date_trunc('milliseconds', NOW()) WHERE id = $2 AND updated_at = $3 RETURNING id",
        [body.status, id, body.expectedUpdatedAt],
      );
      if (updateResult.rows.length === 0) {
        throw new AppError(409, 'Request was modified by another user. Please refresh and try again.');
      }

      await client.query(
        'INSERT INTO audit_logs (request_id, user_name, user_id, action, notes, channel) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          id,
          user.name,
          user.id,
          `Status changed to ${body.status}`,
          body.note || 'No additional notes.',
          auditChannel(req),
        ],
      );

      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* rollback best-effort */
      }
      throw err;
    } finally {
      client.release();
    }

    const request = await loadRequest(id);

    notifyStatusChange({
      requestId: id,
      clientName: existing[0].client_name ?? '',
      newStatus: body.status,
      note: body.note,
      changedBy: user.name,
      advisorSlackId: existing[0].advisor_slack_id ?? null,
    });

    const advisorId = existing[0].advisor_id;
    if (advisorId) {
      notifyUsersSafe([advisorId], `Trade request ${id} status updated to: ${body.status}`, id);
    }

    res.json({ data: request });
  } catch (err) {
    next(err);
  }
});

// ─── Classified holdings for run-engine pre-fill (traders only) ──────────────

router.get(
  '/:id/classified-holdings',
  requireRole('trader'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await refuseIfPlansOff('service');
      if (req.isDemo) {
        const match = DEMO_REQUESTS.find((r) => r.id === req.params.id);
        if (!match) {
          sendError(res, 404, `Request ${req.params.id} not found`);
          return;
        }
        const holdings: Record<string, { cash: number; fixed: number; equity: number }> = {};
        for (const acctNum of match.selectedAccounts) {
          const client = DEMO_CLIENTS.find((c) => c.accounts.some((a) => a.accountNumber === acctNum));
          const acct = client?.accounts.find((a) => a.accountNumber === acctNum);
          holdings[acctNum] = acct?.holdings ?? { cash: 0, fixed: 0, equity: 0 };
        }
        res.json({ data: holdings, source: 'demo' });
        return;
      }

      const id = paramId.parse(req.params.id);

      const { rows } = await pool.query('SELECT selected_accounts FROM trade_requests WHERE id = $1', [id]);
      if (rows.length === 0) throw new AppError(404, `Request ${id} not found`);

      const selectedAccounts: string[] = rows[0].selected_accounts ?? [];
      if (selectedAccounts.length === 0) {
        res.json({ data: {} });
        return;
      }

      if (!warehouse.isStockRecordConfigured()) {
        res.json({ data: {}, source: 'unavailable' });
        return;
      }

      const holdings = await warehouse.getClassifiedHoldings(selectedAccounts);
      res.json({ data: holdings, source: 'stock_record' });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Household sibling holdings (read-only context, traders only) ────────────
//
// Returns the NON-selected accounts in the request's household, enriched with
// current allocation + target + drift from the latest nightly drift run. The
// selected, editable holdings continue to come from `/classified-holdings`.
//
// Silent-fallback contract (mirrors `households.ts`): demo, unconfigured
// Warehouse, missing household data, or a drift-query failure all degrade to an
// empty/partial result with a `source` flag — never a hard error — so the
// modal falls back to today's selected-only behavior.

const EMPTY_HOUSEHOLD_HOLDINGS: HouseholdHoldingsResponse = {
  data: { siblings: [], driftRunDate: null },
  source: 'unavailable',
};

router.get(
  '/:id/household-holdings',
  requireRole('trader'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await refuseIfPlansOff('service');
      if (req.isDemo) {
        const match = DEMO_REQUESTS.find((r) => r.id === req.params.id);
        if (!match) {
          sendError(res, 404, `Request ${req.params.id} not found`);
          return;
        }
        const selected = new Set(match.selectedAccounts);
        const clientIds = match.clientIds?.length ? match.clientIds : [match.clientId];
        const siblings: HouseholdSiblingHolding[] = DEMO_CLIENTS.filter((c) => clientIds.includes(c.id))
          .flatMap((c) => c.accounts)
          .filter((a) => !selected.has(a.accountNumber))
          .map((a) => ({
            accountId: a.id,
            accountNumber: a.accountNumber,
            accountTitle: a.accountNumber,
            accountType: a.accountType,
            balance: a.balance,
            status: null,
            positionCashPct: null,
            positionFixedPct: null,
            positionEquityPct: null,
            templateCashPct: null,
            templateFixedPct: null,
            templateEquityPct: null,
            maxBucketDeltaPct: null,
            worstBucket: null,
            hasDrift: false,
          }));
        const demoResponse: HouseholdHoldingsResponse = {
          data: { siblings, driftRunDate: null },
          source: 'demo',
        };
        res.json(demoResponse);
        return;
      }

      const id = paramId.parse(req.params.id);

      const { rows } = await pool.query(
        'SELECT client_id, client_ids, selected_accounts FROM trade_requests WHERE id = $1',
        [id],
      );
      if (rows.length === 0) throw new AppError(404, `Request ${id} not found`);

      const row = rows[0] as { client_id: string; client_ids: string[] | null; selected_accounts: string[] | null };
      const selectedAccountNumbers = new Set(row.selected_accounts ?? []);
      const clientIds = row.client_ids ?? [row.client_id];

      // Without Warehouse the Client.id values are local UUIDs, not Apex ULIDs,
      // so the household config (keyed by ULID) can't match. Silent fallback.
      if (!warehouse.isConfigured()) {
        res.json(EMPTY_HOUSEHOLD_HOLDINGS);
        return;
      }

      let householdConfig;
      try {
        householdConfig = await loadHouseholdConfigCached();
      } catch (err) {
        if (err instanceof ActiveAccountsLoadError) {
          logger.warn({ err, requestId: id }, 'household_data_unavailable for household-holdings — silent fallback');
          res.json(EMPTY_HOUSEHOLD_HOLDINGS);
          return;
        }
        throw err;
      }

      const clients = await warehouse.getCachedClients();

      // The request stores selected accounts as custodian numbers; the resolver
      // (and the drift table) key on Apex ULIDs. Translate via the cached clients.
      const ulidByAccountNumber = new Map<string, string>();
      for (const client of clients) {
        for (const acct of client.accounts) ulidByAccountNumber.set(acct.accountNumber, acct.id);
      }
      const selectedUlids = new Set<string>();
      for (const num of selectedAccountNumbers) {
        const ulid = ulidByAccountNumber.get(num);
        if (ulid) selectedUlids.add(ulid);
      }

      const resolution = resolveHouseholdsForClients({
        clientIds,
        accountIds: Array.from(selectedUlids),
        clients,
        householdConfig,
      });

      // Union every household account that is NOT in the selected set, deduped.
      const siblingByUlid = new Map<string, HouseholdSiblingHolding>();
      for (const household of resolution.households) {
        const selectedInHousehold = new Set(household.selectedAccountIds);
        for (const acct of household.accounts) {
          if (selectedInHousehold.has(acct.accountId) || selectedUlids.has(acct.accountId)) continue;
          if (siblingByUlid.has(acct.accountId)) continue;
          siblingByUlid.set(acct.accountId, {
            accountId: acct.accountId,
            accountNumber: acct.accountNumber,
            accountTitle: acct.accountTitle,
            accountType: acct.accountType,
            balance: acct.balance,
            status: null,
            positionCashPct: null,
            positionFixedPct: null,
            positionEquityPct: null,
            templateCashPct: null,
            templateFixedPct: null,
            templateEquityPct: null,
            maxBucketDeltaPct: null,
            worstBucket: null,
            hasDrift: false,
          });
        }
      }

      // Enrich with the latest drift run. A query failure is non-fatal — the
      // siblings still render balance-only ("no model data").
      let driftRunDate: string | null = null;
      if (siblingByUlid.size > 0) {
        try {
          const allocations = await fetchLatestDriftAllocationsByAccountId(pool, Array.from(siblingByUlid.keys()));
          for (const [ulid, alloc] of allocations) {
            const sibling = siblingByUlid.get(ulid);
            if (!sibling) continue;
            // `no_template` rows have no model to compare against: the drift
            // delta is already null, and the persisted template pcts are 0 —
            // null them too so the wire contract stays honest (target null ⟺
            // no model target) and the UI shows an em-dash rather than "0%".
            const hasTarget = alloc.status !== 'no_template';
            sibling.hasDrift = true;
            sibling.status = alloc.status;
            sibling.positionCashPct = alloc.positionCashPct;
            sibling.positionFixedPct = alloc.positionFixedPct;
            sibling.positionEquityPct = alloc.positionEquityPct;
            sibling.templateCashPct = hasTarget ? alloc.templateCashPct : null;
            sibling.templateFixedPct = hasTarget ? alloc.templateFixedPct : null;
            sibling.templateEquityPct = hasTarget ? alloc.templateEquityPct : null;
            sibling.maxBucketDeltaPct = alloc.maxBucketDeltaPct;
            sibling.worstBucket = alloc.worstBucket;
            driftRunDate = alloc.runDateLocal;
          }
        } catch (err) {
          logger.warn({ err, requestId: id }, 'drift allocation enrichment failed for household-holdings');
        }
      }

      const siblings = Array.from(siblingByUlid.values()).sort(
        (a, b) => a.accountTitle.localeCompare(b.accountTitle) || a.accountId.localeCompare(b.accountId),
      );

      const response: HouseholdHoldingsResponse = { data: { siblings, driftRunDate }, source: 'drift' };
      res.json(response);
    } catch (err) {
      next(err);
    }
  },
);

// ─── Run engine (traders only) ──────────────────────────────────────────────

const runEngineFullSchema = runEngineSchema.extend({
  expectedUpdatedAt: z
    .string()
    .refine((val) => !isNaN(new Date(val).getTime()), { message: 'expectedUpdatedAt must be a valid ISO timestamp' }),
});

router.post('/:id/run-engine', requireRole('trader'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await refuseIfPlansOff('service');
    if (req.isDemo) {
      const match = DEMO_REQUESTS.find((r) => r.id === req.params.id);
      if (!match) {
        sendError(res, 404, `Request ${req.params.id} not found`);
        return;
      }
      res.json({ data: withForcedAdvisor({ ...match, updatedAt: new Date().toISOString() }) });
      return;
    }

    const id = paramId.parse(req.params.id);
    const body = runEngineFullSchema.parse(req.body);
    const user = req.user as AuthUser;

    const { rows } = await pool.query('SELECT * FROM trade_requests WHERE id = $1', [id]);
    if (rows.length === 0) throw new AppError(404, `Request ${id} not found`);
    const tr = rows[0];

    const selectedAccounts: string[] = tr.selected_accounts ?? [];

    const [accountTypeMap, accountClientIdMap] = await Promise.all([
      lookupAccountTypes(selectedAccounts),
      lookupAccountClientIds(selectedAccounts),
    ]);

    // Validate all accounts were found
    const missing = selectedAccounts.filter((a) => !accountTypeMap[a]);
    if (missing.length > 0) {
      throw new AppError(400, `Account(s) not found in database: ${missing.join(', ')}`);
    }

    const missingHoldings = selectedAccounts.filter((a) => !body.holdings[a]);
    if (missingHoldings.length > 0) {
      throw new AppError(400, `Holdings required for all selected accounts. Missing: ${missingHoldings.join(', ')}`);
    }

    const accounts: Account[] = selectedAccounts.map((accNum: string) => {
      const override = body.holdings[accNum];
      const cash = override?.cash ?? 0;
      const fixed = override?.fixed ?? 0;
      const equity = override?.equity ?? 0;
      const balance = cash + fixed + equity;
      return {
        id: accNum,
        clientId: accountClientIdMap[accNum] ?? tr.client_id,
        accountNumber: accNum,
        accountType: accountTypeMap[accNum],
        balance,
        holdings: { cash, fixed, equity },
      };
    });

    const totalValue = accounts.reduce((sum, a) => sum + a.balance, 0);
    const baseAllocation: BaseAllocation = tr.base_allocation ?? { equity: 0, fixed: 0, cash: 0 };
    const equityStrategies: EquityStrategy[] = tr.equity_strategies ?? [];

    if (tr.risk_profile == null) {
      throw new AppError(400, 'Request has no risk profile set. Cannot run engine.');
    }

    // Fixed-context siblings: already-invested, same-mandate accounts the trader
    // chose to account for (household-aware location). Held constant — never
    // traded — but counted toward the household total + ideal location so the
    // selected accounts are located to fill the household's real gap. Their
    // current holdings come live from the stock record. Guarded: any account we
    // can't resolve/fetch is simply dropped (fall back toward selected-only).
    const contextNumbers = (body.fixedContextAccountNumbers ?? []).filter((a) => !selectedAccounts.includes(a));
    let fixedContextAccounts: Account[] = [];
    if (contextNumbers.length > 0 && warehouse.isStockRecordConfigured()) {
      try {
        const [ctxTypes, ctxClientIds, ctxHoldings] = await Promise.all([
          lookupAccountTypes(contextNumbers),
          lookupAccountClientIds(contextNumbers),
          warehouse.getClassifiedHoldings(contextNumbers),
        ]);
        fixedContextAccounts = contextNumbers
          .filter((a) => ctxTypes[a] && ctxHoldings[a])
          .map((accNum) => {
            const h = ctxHoldings[accNum];
            return {
              id: accNum,
              clientId: ctxClientIds[accNum] ?? tr.client_id,
              accountNumber: accNum,
              accountType: ctxTypes[accNum],
              balance: h.cash + h.fixed + h.equity,
              holdings: { cash: h.cash, fixed: h.fixed, equity: h.equity },
            };
          });
      } catch (err) {
        logger.warn(
          { err, requestId: id },
          'fixed-context holdings unavailable; running selected-only (household context skipped)',
        );
        fixedContextAccounts = [];
      }
    }

    const storedClientIds: string[] = tr.client_ids ?? [tr.client_id];
    const storedClientNames: string[] = tr.client_names ?? [tr.client_name ?? ''];
    const clientNameMap = buildClientNameMap(storedClientIds, storedClientNames);

    const { plans: plan } = await runEngine('service', {
      tradeType: tr.trade_type,
      tradeAmount: tr.trade_amount ?? '',
      depositAccountNumber: tr.deposit_account ?? '',
      rebalanceAll: tr.rebalance_all ?? true,
      totalValue,
      baseAllocation,
      riskProfile: tr.risk_profile,
      clientName: tr.client_name ?? '',
      clientNameMap,
      accounts,
      fixedContextAccounts,
      equityStrategies,
      residence: tr.residence ?? 'Other',
      assetLocationMode: tr.asset_location_mode ?? 'priority',
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const engineResult = await client.query(
        "UPDATE trade_requests SET execution_plan = $1, total_value = $2, updated_at = date_trunc('milliseconds', NOW()) WHERE id = $3 AND updated_at = $4 RETURNING id",
        [JSON.stringify(plan), totalValue, id, body.expectedUpdatedAt],
      );
      if (engineResult.rows.length === 0) {
        throw new AppError(409, 'Request was modified by another user. Please refresh and try again.');
      }

      await client.query(
        'INSERT INTO audit_logs (request_id, user_name, user_id, action, notes, channel) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          id,
          user.name,
          user.id,
          'Ran Asset Location Engine',
          'Current holdings verified and optimization triggered.',
          auditChannel(req),
        ],
      );

      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* rollback best-effort */
      }
      throw err;
    } finally {
      client.release();
    }

    const request = await loadRequest(id);

    const advisorId = tr.advisor_id as string | null | undefined;
    if (advisorId) {
      notifyUsersSafe([advisorId], `Trader ran the Asset Location Engine for request ${id}`, id);
    }

    res.json({ data: request });
  } catch (err) {
    next(err);
  }
});

export default router;
