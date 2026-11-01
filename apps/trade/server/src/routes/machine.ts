import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { AccountType, RequestStatus, TradeRequest } from '@trade-request/shared';
import logger from '../lib/logger.js';
import { sendError } from '../middleware/errorHandler.js';
import { listRequestsForClientIds } from '../services/requestQueries.js';
import { engineUseReport } from '../services/engineUse.js';
import * as warehouse from '../services/warehouse.js';
import { changeServiceState, readServiceState, SERVICE_MODES } from '../services/serviceMode.js';

const router = Router();

// An cedar_ridge_user_id — the cross-system client key Ops Portal sends. It is NOT a
// bare UUID: it carries a `user-` prefix (e.g. user-ae66b3c8-d257-4a6a-a8fd-
// d1c3641db27b) and is the exact value stored in trade_request.client_id /
// client_ids. This mirrors OPS_PORTAL's ingest format `^user-[0-9a-f-]{36}$`.
// (Validating as a bare UUID — the original bug — 400s every real id.)
const CEDAR_RIDGE_USER_ID = z.string().regex(/^user-[0-9a-f-]{36}$/, 'must be a user-<uuid> cedar_ridge_user_id');

const querySchema = z
  .object({
    cedar_ridge_user_id: CEDAR_RIDGE_USER_ID.optional(),
    cedar_ridge_user_ids: z.string().max(2000).optional(),
  })
  .refine((q) => q.cedar_ridge_user_id || q.cedar_ridge_user_ids, {
    message: 'cedar_ridge_user_id or cedar_ridge_user_ids is required',
  });

/**
 * Mask an Apex account number, preserving the last 4. Empty stays empty.
 * Used on every account-bearing field so no full account number leaves the
 * machine surface.
 */
export function maskAccount(n: string): string {
  const s = (n ?? '').trim();
  if (!s) return '';
  return s.length <= 4 ? '****' : `****${s.slice(-4)}`;
}

/**
 * Historical requests sometimes persisted the deposit display label instead
 * of the Apex account number (for example `ZZ10004 ($180,000.00)`). Recover
 * only the narrow, well-formed account-number prefix. Anything ambiguous stays
 * unresolved so Ops Portal can require human review rather than guessing.
 */
export function canonicalAccountNumber(value: string): string | null {
  const withoutAmount = (value ?? '')
    .trim()
    .replace(/\s*\(\s*\$[\d,]+(?:\.\d{1,2})?\s*\)\s*$/, '')
    .trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(withoutAmount)) return null;
  return withoutAmount;
}

function requestAccountNumbers(tr: TradeRequest): string[] {
  const metadataNumbers = (tr.accountMetadata ?? [])
    .map((account) => canonicalAccountNumber(account.accountNumber))
    .filter((accountNumber): accountNumber is string => accountNumber != null);
  const source =
    metadataNumbers.length > 0
      ? metadataNumbers
      : (tr.selectedAccounts ?? [])
          .map(canonicalAccountNumber)
          .filter((accountNumber): accountNumber is string => accountNumber != null);
  return [...new Set(source)];
}

/** Resolve only missing identities on accounts that the machine projection uses. */
function unresolvedAccountNumbers(tr: TradeRequest): string[] {
  const persistedAccounts = tr.accountMetadata ?? [];
  if (persistedAccounts.length === 0) return requestAccountNumbers(tr);
  return persistedAccounts
    .filter((account) => account.accountId == null)
    .map((account) => canonicalAccountNumber(account.accountNumber))
    .filter((accountNumber): accountNumber is string => accountNumber != null);
}

/**
 * Redacted, machine-facing projection of a TradeRequest. Drops client-name PII
 * (`clientName`/`clientNames`), `submittedBy`, advisor/client notes and
 * exclusions, ESG/risk/allocation detail, execution-plan detail, and the audit
 * log; masks every account number. Keeps `clientId`/`clientIds` (= cedarRidge
 * user ids, not names) so a batch caller can group rows by user.
 */
export interface MachineTradeRequest {
  id: string;
  clientId: string;
  clientIds: string[];
  status: RequestStatus;
  tradeType: TradeRequest['tradeType'];
  priority: TradeRequest['priority'];
  createdAt: string;
  updatedAt: string;
  totalValue: number;
  advisor: string;
  householdId: number | null;
  householdName: string | null;
  selectedAccounts: string[];
  accounts: Array<{
    accountId: string | null;
    accountNumber: string;
    accountType: AccountType | null;
    balance: number;
  }>;
  liquidateOption: TradeRequest['liquidateOption'];
  liquidationApproval: TradeRequest['liquidationApproval'];
  profile: MachineTradeProfile | null;
}

export interface MachineTradeProfileInstruction {
  key: string;
  label: string;
  value: string;
}

/**
 * Narrow, approved-only facts used by OPS_PORTAL's Client Portrait. Free-form advisor
 * notes, strategy rationales, execution plans and audit entries never leave
 * the Trade Request service.
 */
export interface MachineTradeProfile {
  decidedAt: string;
  riskScore: number | null;
  instructions: MachineTradeProfileInstruction[];
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}%`;
}

function profileDecisionAt(tr: TradeRequest): string {
  const latestApproval = tr.auditLog.find((entry) => entry.action === 'Status changed to Approved');
  const latestCompletion = tr.auditLog.find((entry) => entry.action === 'Status changed to Completed');
  return latestApproval?.date ?? latestCompletion?.date ?? tr.updatedAt ?? tr.date;
}

function activeEsgRestrictions(tr: TradeRequest): string[] {
  if (tr.esgFilters.none) return [];
  const restrictions: string[] = [];
  if (tr.esgFilters.fossilFuels) restrictions.push('Fossil fuels');
  if (tr.esgFilters.tobacco) restrictions.push('Tobacco');
  if (tr.esgFilters.weapons) restrictions.push('Weapons');
  if (tr.esgFilters.alcohol) restrictions.push('Alcohol');
  if (tr.esgFilters.gambling) restrictions.push('Gambling');
  if (tr.esgFilters.other) {
    restrictions.push(tr.esgFilters.otherDescription.trim() || 'Other ESG restriction');
  }
  return restrictions;
}

export function toMachineTradeProfile(tr: TradeRequest): MachineTradeProfile | null {
  const qualifies =
    (tr.status === 'Approved' || tr.status === 'Completed') &&
    (tr.tradeType === 'Initial Funding' || tr.tradeType === 'Rebalance');
  if (!qualifies) return null;

  const instructions: MachineTradeProfileInstruction[] = [];
  const allocation = tr.baseAllocation;
  if (allocation.equity + allocation.fixed + allocation.cash > 0) {
    instructions.push({
      key: 'target_allocation',
      label: 'Target allocation',
      value: `${formatPercent(allocation.equity)} equity · ${formatPercent(allocation.fixed)} fixed income · ${formatPercent(allocation.cash)} cash`,
    });
  }

  const strategies = tr.equityStrategies
    .filter((strategy) => strategy.benchmark.trim() && strategy.allocation > 0)
    .map((strategy) => `${strategy.benchmark.trim()} ${formatPercent(strategy.allocation)}`);
  if (strategies.length > 0) {
    instructions.push({
      key: 'equity_strategy',
      label: strategies.length === 1 ? 'Equity strategy' : 'Equity strategies',
      value: strategies.join(' · '),
    });
  }

  if (tr.residence === 'CA' || tr.residence === 'NY') {
    instructions.push({
      key: 'tax_preference',
      label: 'Tax preference',
      value: tr.residence === 'CA' ? 'California municipal preference' : 'New York municipal preference',
    });
  }

  const restrictions = activeEsgRestrictions(tr);
  const advisorExclusions = tr.advisorExclusions.trim();
  const clientExclusions = tr.clientExclusions.trim();
  if (advisorExclusions) restrictions.push(`Advisor: ${advisorExclusions}`);
  if (clientExclusions) restrictions.push(`Client: ${clientExclusions}`);
  instructions.push({
    key: 'restrictions',
    label: 'Restrictions',
    value: restrictions.length > 0 ? restrictions.join(' · ') : 'None',
  });

  return {
    decidedAt: profileDecisionAt(tr),
    riskScore: tr.riskProfile,
    instructions,
  };
}

function resolvedAccountId(accountIdByNumber: Readonly<Record<string, string>>, accountNumber: string): string | null {
  return Object.hasOwn(accountIdByNumber, accountNumber) ? (accountIdByNumber[accountNumber] ?? null) : null;
}

export function toMachineTradeRequest(
  tr: TradeRequest,
  accountIdByNumber: Readonly<Record<string, string>> = {},
): MachineTradeRequest {
  const persistedAccounts = tr.accountMetadata ?? [];
  const accounts =
    persistedAccounts.length > 0
      ? persistedAccounts.flatMap((account) => {
          const persistedNumber = account.accountNumber.trim();
          if (!persistedNumber) return [];
          const accountNumber = canonicalAccountNumber(persistedNumber) ?? persistedNumber;
          return [
            {
              accountId: account.accountId ?? resolvedAccountId(accountIdByNumber, accountNumber),
              accountNumber: maskAccount(accountNumber),
              accountType: account.accountType,
              balance: account.balance,
            },
          ];
        })
      : requestAccountNumbers(tr).map((accountNumber) => ({
          accountId: resolvedAccountId(accountIdByNumber, accountNumber),
          accountNumber: maskAccount(accountNumber),
          // Legacy rows did not persist account metadata. Account type and AUM
          // are unknown here; Ops Portal renders both from its own Apex mirror.
          accountType: null,
          balance: 0,
        }));

  return {
    id: tr.id,
    clientId: tr.clientId,
    clientIds: tr.clientIds,
    status: tr.status,
    tradeType: tr.tradeType,
    priority: tr.priority,
    createdAt: tr.date,
    updatedAt: tr.updatedAt,
    totalValue: tr.totalValue,
    advisor: tr.advisor,
    householdId: tr.householdId ?? null,
    householdName: tr.householdName ?? null,
    selectedAccounts: (tr.selectedAccounts ?? []).map((value) => maskAccount(canonicalAccountNumber(value) ?? value)),
    accounts,
    liquidateOption: tr.liquidateOption,
    liquidationApproval: tr.liquidationApproval,
    profile: toMachineTradeProfile(tr),
  };
}

/**
 * GET /api/machine/trade-requests
 *
 * Machine-to-machine read (OIDC-gated by requireMachineAuth at mount time).
 * Returns a client's — or a household's — trade requests as a redacted
 * projection, all statuses, most-recent first.
 *
 *   ?cedar_ridge_user_id=user-<uuid>
 *   ?cedar_ridge_user_ids=user-<uuid>,user-<uuid>,...   (household union, deduped, 1-50 ids)
 *
 * Unknown/absent client → 200 { data: [] } (NOT 404). No-store, no-PII logging.
 */
router.get('/trade-requests', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, 'Validation failed', { issues: parsed.error.issues });
      return;
    }

    let ids: string[];
    if (parsed.data.cedar_ridge_user_ids) {
      ids = [
        ...new Set(
          parsed.data.cedar_ridge_user_ids
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      const each = z.array(CEDAR_RIDGE_USER_ID).max(50).safeParse(ids);
      if (!each.success || ids.length === 0) {
        sendError(res, 400, 'cedar_ridge_user_ids must be 1-50 user-<uuid> ids');
        return;
      }
    } else {
      ids = [parsed.data.cedar_ridge_user_id!];
    }

    const requests = await listRequestsForClientIds(ids);
    const accountNumbers = [...new Set(requests.flatMap(unresolvedAccountNumbers))];
    let accountIdByNumber: Record<string, string> = {};
    if (accountNumbers.length > 0 && warehouse.isMachineAccountIdentityConfigured()) {
      try {
        accountIdByNumber = await warehouse.getMachineAccountIdMap(accountNumbers);
      } catch {
        // Legacy rows may lack the persisted ULID. A resolver outage must not
        // take down the machine feed; Ops Portal will flag a null accountId for review.
        logger.warn(
          { event: 'machine_trade_requests_account_resolution_failed', accountCount: accountNumbers.length },
          'Machine trade-request account resolution failed',
        );
      }
    }
    const data = requests.map((request) => toMachineTradeRequest(request, accountIdByNumber));

    res.set('Cache-Control', 'no-store, private');
    // Counts only — never log ids or any request content (PII discipline).
    logger.info(
      { event: 'machine_trade_requests_read', requestId: req.requestId, idCount: ids.length, rowCount: data.length },
      'machine trade-requests read',
    );
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

const engineUseQuery = z.object({ days: z.coerce.number().int().min(1).max(31).default(7) });

/** Engine-use report for OPS_PORTAL's cutover controller. Counts only; no request data. */
router.get('/engine-use', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = engineUseQuery.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, 'Validation failed', { issues: parsed.error.issues });
      return;
    }
    const report = await engineUseReport(parsed.data.days);
    res.set('Cache-Control', 'no-store, private');
    logger.info(
      {
        event: 'machine_engine_use_read',
        requestId: req.requestId,
        windowDays: report.windowDays,
        coveredDays: report.coveredDays,
      },
      'machine engine-use read',
    );
    res.json(report);
  } catch (err) {
    next(err);
  }
});

/**
 * The identities that may change the service mode or a sender switch: OPS_PORTAL's cutover controller.
 * SERVICE_MODE_CONTROLLER_SA when set, otherwise the existing Ops Portal caller list (OPS_PORTAL_DELEGATED_CALLER_SA);
 * both are comma-separated service-account emails.
 */
export function serviceModeControllers(): Set<string> {
  const raw = process.env.SERVICE_MODE_CONTROLLER_SA || process.env.OPS_PORTAL_DELEGATED_CALLER_SA || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

const SENDER = z.enum(['on', 'off']);
const serviceModeChangeSchema = z
  .object({
    mode: z.enum(SERVICE_MODES).optional(),
    digestSender: SENDER.optional(),
    driftSender: SENDER.optional(),
    reason: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine((b) => b.mode !== undefined || b.digestSender !== undefined || b.driftSender !== undefined, {
    message: 'mode, digestSender or driftSender is required',
  });

/** GET /api/machine/service-mode — the current mode and both sender switches (any machine caller). */
router.get('/service-mode', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const state = await readServiceState();
    res.set('Cache-Control', 'no-store, private');
    logger.info(
      { event: 'machine_service_mode_read', requestId: req.requestId, mode: state.mode },
      'service mode read',
    );
    res.json(state);
  } catch (err) {
    next(err);
  }
});

/** PUT /api/machine/service-mode — change the mode and/or a sender switch (controller identity only). */
router.put('/service-mode', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const controllers = serviceModeControllers();
    if (controllers.size === 0) {
      sendError(res, 503, 'Service mode control is not configured');
      return;
    }
    if (!req.machineCaller || !controllers.has(req.machineCaller)) {
      logger.warn(
        { event: 'machine_service_mode_change_refused', requestId: req.requestId },
        'caller is not the controller',
      );
      sendError(res, 403, 'Forbidden');
      return;
    }
    const parsed = serviceModeChangeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, 400, 'Validation failed', { issues: parsed.error.issues });
      return;
    }
    const { reason, ...change } = parsed.data;
    const state = await changeServiceState(change, req.machineCaller, reason);
    res.set('Cache-Control', 'no-store, private');
    logger.info(
      {
        event: 'machine_service_mode_changed',
        requestId: req.requestId,
        mode: state.mode,
        digestSender: state.digestSender,
        driftSender: state.driftSender,
      },
      'service mode changed',
    );
    res.json(state);
  } catch (err) {
    next(err);
  }
});

export default router;
