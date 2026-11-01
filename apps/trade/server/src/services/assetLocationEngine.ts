import type {
  Account,
  AccountType,
  AccountExecutionPlan,
  EngineInput,
  EngineResult,
  Holdings,
  SleeveInstruction,
  Trade,
  ValidationIssue,
  ValidationResult,
  VarianceAnalysis,
  EquityStrategy,
  CashDepositContext,
} from '@trade-request/shared';
import {
  selectModel,
  getProfile,
  getModelDisplayName,
  type ModelKey,
  type FundPosition,
} from '../data/allocationProfiles.js';
import { INSTRUMENTS } from '../data/instruments.js';
import logger from '../lib/logger.js';

// ─── Internal types ──────────────────────────────────────────────────────────

interface WorkingAccount {
  accountNumber: string;
  clientId: string;
  accountType: AccountType;
  balance: number;
  holdings: Holdings;
  newCapacity: number;
  isDepositAccount: boolean;
  alloc: Holdings;
  /**
   * True for already-invested same-mandate siblings supplied as fixed context:
   * they're counted toward the household total and the ideal location, but
   * their trades are advisory (`action: 'recommend'`). False = traded now.
   */
  fixed: boolean;
}

// ─── Priority matrix for cross-account asset location ────────────────────────

const PRIORITY_MATRIX: Record<keyof Holdings, AccountType[]> = {
  cash: ['Taxable', 'Joint', 'Traditional IRA', 'Roth IRA'],
  fixed: ['Traditional IRA', 'Taxable', 'Joint', 'Roth IRA'],
  equity: ['Roth IRA', 'Taxable', 'Joint', 'Traditional IRA'],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseDeposit(tradeType: string, tradeAmount: string): number {
  if (tradeType !== 'Cash Deposit') return 0;
  return parseFloat(String(tradeAmount).replace(/[^0-9.-]+/g, '')) || 0;
}

export function extractLastNames(clientName: string): string {
  const parts = clientName.split(/\s*&\s*|\s+and\s+/i);
  if (parts.length === 1) {
    const words = parts[0].trim().split(/\s+/);
    return words[words.length - 1] || clientName;
  }
  return parts
    .map((part) => {
      const words = part.trim().split(/\s+/);
      return words[words.length - 1];
    })
    .join('/');
}

export function buildTemplateName(
  clientName: string,
  clientNameMap: Record<string, string> | undefined,
  accountClientId: string,
  accountType: AccountType,
  modelKey: ModelKey,
  riskLevel: number,
  equityStrategies: EquityStrategy[],
): string {
  let lastNames: string;
  if (accountType === 'Joint') {
    lastNames = extractLastNames(clientName);
  } else if (clientNameMap?.[accountClientId]) {
    lastNames = extractLastNames(clientNameMap[accountClientId]);
  } else {
    lastNames = extractLastNames(clientName);
  }
  const modelName = getModelDisplayName(modelKey);
  const benchmarks = equityStrategies.map((s) => s.benchmark).join('/') || 'DI';
  return `${lastNames} ${accountType} ${modelName} Risk ${riskLevel} ${benchmarks}`;
}

function resolveAssetLabel(symbol: string): string {
  const inst = INSTRUMENTS[symbol];
  return inst ? `${symbol} – ${inst.name}` : symbol;
}

// ─── Cross-account allocation (priority-matrix based) ────────────────────────

function allocateToAccounts(assetClass: keyof Holdings, targetAmount: number, accounts: WorkingAccount[]): void {
  // Within a single `preferredType`, distribute `fillThisType` proportionally
  // to each peer's remaining capacity. When `peers.length === 1` and the lone
  // peer's `spaceLeft` equals `totalSpace`, `share = fillThisType * 1` and the
  // loop collapses byte-identically to the prior sequential-fill behavior —
  // i.e. zero regression for households with at most one account per type.
  // See docs/plans/2026-q4-engine-within-type-spread.md (Appendix A) for the
  // byte-identity argument.
  const spaceLeft = (a: WorkingAccount): number => a.newCapacity - (a.alloc.cash + a.alloc.fixed + a.alloc.equity);

  let remaining = targetAmount;
  for (const preferredType of PRIORITY_MATRIX[assetClass]) {
    if (remaining <= 0) break;

    const peers = accounts.filter((a) => a.accountType === preferredType && spaceLeft(a) > 0);
    if (peers.length === 0) continue;

    const totalSpace = peers.reduce((s, a) => s + spaceLeft(a), 0);
    const fillThisType = Math.min(remaining, totalSpace);

    for (const acct of peers) {
      const share = fillThisType * (spaceLeft(acct) / totalSpace);
      acct.alloc[assetClass] += share;
    }
    remaining -= fillThisType;
  }
  if (remaining > 1) {
    logger.warn({ assetClass, targetAmount, remaining }, 'Under-allocation: could not fully allocate target');
  }
}

function allocateDepositOnly(
  deposit: number,
  accountType: AccountType,
  baseAllocation: { cash: number; fixed: number; equity: number },
): Holdings {
  const ranked: (keyof Holdings)[] = ['cash', 'fixed', 'equity'];
  ranked.sort((a, b) => PRIORITY_MATRIX[a].indexOf(accountType) - PRIORITY_MATRIX[b].indexOf(accountType));

  const totalPct = baseAllocation.cash + baseAllocation.fixed + baseAllocation.equity;
  const alloc: Holdings = { cash: 0, fixed: 0, equity: 0 };
  if (totalPct <= 0) return alloc;

  let remaining = deposit;
  for (const assetClass of ranked) {
    if (remaining <= 0) break;
    const share = deposit * (baseAllocation[assetClass] / totalPct);
    const fill = Math.min(remaining, share);
    alloc[assetClass] = fill;
    remaining -= fill;
  }
  if (remaining > 0.01) alloc[ranked[0]] += remaining;
  return alloc;
}

function buildVariance(acct: WorkingAccount, deposit: number): VarianceAnalysis {
  return {
    preTrade: {
      cash: acct.holdings.cash,
      fixed: acct.holdings.fixed,
      equity: acct.holdings.equity,
    },
    postTrade: { ...acct.alloc },
  };
}

function describeSleeve(sleeve: keyof Holdings): string {
  if (sleeve === 'cash') return 'Cash/MMF';
  if (sleeve === 'fixed') return 'Fixed income';
  return 'Equity';
}

function buildSleeveInstructions(acct: WorkingAccount, deposit: number): SleeveInstruction[] {
  return (['cash', 'fixed', 'equity'] as const)
    .map((sleeve) => {
      const current = acct.holdings[sleeve];
      const target = acct.alloc[sleeve];
      const delta = target - current;
      let source: SleeveInstruction['source'] = 'existing_holdings';
      if (acct.isDepositAccount && deposit > 0 && delta > 0) {
        source = current > 0 ? 'mixed' : 'new_usd_deposit';
      }
      return {
        sleeve,
        current,
        target,
        delta,
        source,
        rationale:
          acct.isDepositAccount && deposit > 0
            ? `${describeSleeve(sleeve)} target after applying the new USD deposit separately from existing holdings.`
            : `${describeSleeve(sleeve)} target from the asset-location allocation.`,
      };
    })
    .filter((instruction) => Math.abs(instruction.delta) > 1);
}

function buildCashDepositContext(acct: WorkingAccount, deposit: number): CashDepositContext | undefined {
  if (!acct.isDepositAccount || deposit <= 0) return undefined;
  const existingCash = acct.holdings.cash;
  const targetCash = acct.alloc.cash;
  const availableCash = existingCash + deposit;
  return {
    depositAmount: deposit,
    depositAccountNumber: acct.accountNumber,
    existingCash,
    availableCash,
    targetCash,
    cashToDeploy: Math.max(0, availableCash - targetCash),
  };
}

// ─── Fund-level trade generation ─────────────────────────────────────────────

function generateFundTrades(
  acct: WorkingAccount,
  deposit: number,
  positions: FundPosition[],
  equityStrategies: EquityStrategy[],
): Trade[] {
  const trades: Trade[] = [];
  const accountValue = acct.newCapacity;

  // Pre-trade holdings per asset class
  const startCash = acct.holdings.cash;
  const startFixed = acct.holdings.fixed;
  const startEquity = acct.holdings.equity;

  // Actual targets from the cross-account priority-matrix allocation
  const targetCash = acct.alloc.cash;
  const targetFixed = acct.alloc.fixed;
  const targetEquity = acct.alloc.equity;

  // Model-profile aggregate weights per asset class (used only for intra-class ratios)
  const profileCashWeight = positions.filter((pp) => pp.category === 'cash').reduce((s, pp) => s + pp.weight, 0);
  const profileFixedWeight = positions.filter((pp) => pp.category === 'fixed').reduce((s, pp) => s + pp.weight, 0);

  // Generate cash / fixed income trades, scaling by actual allocation
  for (const pos of positions) {
    if (pos.symbol === 'Stock') continue;

    let targetDollars: number;
    let currentDollars: number;
    if (pos.category === 'cash') {
      const ratio = profileCashWeight > 0 ? pos.weight / profileCashWeight : 0;
      targetDollars = targetCash * ratio;
      currentDollars = profileCashWeight > 0 ? startCash * ratio : 0;
    } else {
      const ratio = profileFixedWeight > 0 ? pos.weight / profileFixedWeight : 0;
      targetDollars = targetFixed * ratio;
      currentDollars = profileFixedWeight > 0 ? startFixed * ratio : 0;
    }

    const pctOfAccount = accountValue > 0 ? (targetDollars / accountValue) * 100 : 0;
    const delta = targetDollars - currentDollars;
    if (Math.abs(delta) > 1) {
      trades.push({
        asset: resolveAssetLabel(pos.symbol),
        type: delta > 0 ? 'Buy' : 'Sell',
        amount: Math.abs(delta),
        rationale:
          pos.category === 'cash' && acct.isDepositAccount && deposit > 0
            ? `Target ${pctOfAccount.toFixed(2)}% of account value. New USD deposit is handled separately from existing cash/MMF.`
            : `Target ${pctOfAccount.toFixed(2)}% of account value.`,
      });
    }
  }

  // Generate equity trades split by advisor-selected benchmarks
  const equityDelta = targetEquity - startEquity;
  const equityPct = accountValue > 0 ? (targetEquity / accountValue) * 100 : 0;

  if (Math.abs(equityDelta) > 1) {
    if (equityStrategies.length === 0) {
      trades.push({
        asset: 'Direct Index',
        type: equityDelta > 0 ? 'Buy' : 'Sell',
        amount: Math.abs(equityDelta),
        rationale:
          acct.isDepositAccount && deposit > 0
            ? `Target ${equityPct.toFixed(2)}% equity allocation, funded by the new USD deposit where applicable.`
            : `Target ${equityPct.toFixed(2)}% equity allocation.`,
      });
    } else {
      for (const strat of equityStrategies) {
        const stratDelta = equityDelta * (strat.allocation / 100);
        if (Math.abs(stratDelta) > 1) {
          trades.push({
            asset: `${strat.benchmark} Strategy`,
            type: stratDelta > 0 ? 'Buy' : 'Sell',
            amount: Math.abs(stratDelta),
            rationale:
              acct.isDepositAccount && deposit > 0
                ? `${strat.allocation}% of ${equityPct.toFixed(2)}% equity allocation, funded by the new USD deposit where applicable.`
                : `${strat.allocation}% of ${equityPct.toFixed(2)}% equity allocation.`,
          });
        }
      }
    }
  }

  // Sells first, then buys
  trades.sort((a, b) => (a.type === 'Sell' ? -1 : 1) - (b.type === 'Sell' ? -1 : 1));
  return trades;
}

// ─── Post-allocation validation ──────────────────────────────────────────────

const VALIDATION_TOLERANCES = { aggregate: 1, account: 1, negative: 0.01 };

function formatDollar(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function formatPct(p: number): string {
  return `${(p * 100).toFixed(4)}%`;
}

export function verifyExecutionPlans(
  plans: AccountExecutionPlan[],
  context: {
    grandTotal: number;
    baseAllocation: { cash: number; fixed: number; equity: number };
    isDepositOnly: boolean;
  },
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const sleeves = ['cash', 'fixed', 'equity'] as const;

  if (!context.isDepositOnly) {
    for (const sleeve of sleeves) {
      const expected = context.grandTotal * (context.baseAllocation[sleeve] / 100);
      const actual = plans.reduce((sum, p) => sum + p.postTradeHoldings[sleeve], 0);
      const drift = actual - expected;
      if (Math.abs(drift) > VALIDATION_TOLERANCES.aggregate) {
        const driftPct = context.grandTotal > 0 ? drift / context.grandTotal : 0;
        issues.push({
          kind: 'aggregate_drift',
          sleeve,
          expected,
          actual,
          drift,
          driftPct,
          message: `${sleeve} sleeve allocated ${formatDollar(actual)} vs target ${formatDollar(expected)} (drift ${formatDollar(drift)}, ${formatPct(driftPct)} of portfolio).`,
        });
      }
    }
  }

  for (const plan of plans) {
    const expected = plan.accountValue;
    const actual = plan.postTradeHoldings.cash + plan.postTradeHoldings.fixed + plan.postTradeHoldings.equity;
    const drift = actual - expected;
    if (Math.abs(drift) > VALIDATION_TOLERANCES.account) {
      const driftPct = expected > 0 ? drift / expected : 0;
      issues.push({
        kind: 'account_capacity',
        accountNumber: plan.accountNumber,
        expected,
        actual,
        drift,
        driftPct,
        message: `Account ${plan.accountNumber} sleeves total ${formatDollar(actual)} vs capacity ${formatDollar(expected)} (drift ${formatDollar(drift)}, ${formatPct(driftPct)}).`,
      });
    }

    for (const sleeve of sleeves) {
      const value = plan.postTradeHoldings[sleeve];
      if (value < -VALIDATION_TOLERANCES.negative) {
        const driftPct = plan.accountValue > 0 ? value / plan.accountValue : 0;
        issues.push({
          kind: 'negative_allocation',
          sleeve,
          accountNumber: plan.accountNumber,
          expected: 0,
          actual: value,
          drift: value,
          driftPct,
          message: `Account ${plan.accountNumber} has negative ${sleeve} allocation of ${formatDollar(value)}.`,
        });
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
    tolerances: { ...VALIDATION_TOLERANCES },
  };
}

// ─── Main engine ─────────────────────────────────────────────────────────────

export function runAssetLocationEngine(input: EngineInput): EngineResult {
  const {
    tradeType,
    tradeAmount,
    depositAccountNumber,
    rebalanceAll,
    baseAllocation,
    riskProfile,
    clientName,
    clientNameMap,
    accounts,
    fixedContextAccounts,
    equityStrategies,
    residence,
    assetLocationMode,
  } = input;
  const mode: 'priority' | 'mirror' = assetLocationMode ?? 'priority';

  if (accounts.length === 0) {
    throw new Error('No accounts provided to the asset location engine.');
  }

  // Already-invested same-mandate siblings held as fixed context. They're
  // included in the household total + ideal location so the selected accounts
  // are located to fill the household's real gap; their trades are advisory.
  const contextAccounts = fixedContextAccounts ?? [];

  const allocSum = baseAllocation.cash + baseAllocation.fixed + baseAllocation.equity;
  if (!Number.isFinite(allocSum) || Math.abs(allocSum - 100) > 0.5) {
    throw new Error(`Base allocation must sum to 100, got ${allocSum}`);
  }

  if (equityStrategies.length > 0) {
    const stratSum = equityStrategies.reduce((s, st) => s + st.allocation, 0);
    if (Math.abs(stratSum - 100) > 0.5) {
      throw new Error(`Equity strategy allocations must sum to 100, got ${stratSum}`);
    }
  }

  const deposit = parseDeposit(tradeType, tradeAmount);

  const isInitialFunding = tradeType === 'Initial Funding';

  const toWorking = (acct: Account, fixed: boolean): WorkingAccount => {
    const isDepositAccount = acct.accountNumber === depositAccountNumber && tradeType === 'Cash Deposit';
    return {
      accountNumber: acct.accountNumber,
      clientId: acct.clientId,
      accountType: acct.accountType,
      balance: acct.balance,
      // Fixed-context siblings are already invested — never treat them as
      // initial-funding (which would zero their current holdings).
      holdings: isInitialFunding && !fixed ? { cash: 0, fixed: 0, equity: 0 } : { ...acct.holdings },
      newCapacity: acct.balance + (isDepositAccount ? deposit : 0),
      isDepositAccount,
      alloc: { cash: 0, fixed: 0, equity: 0 },
      fixed,
    };
  };

  const working: WorkingAccount[] = [
    ...accounts.map((a) => toWorking(a, false)),
    ...contextAccounts.map((a) => toWorking(a, true)),
  ];

  // Household total now spans the trade-now accounts AND the fixed context, so
  // targets reflect the whole household. With no context this equals
  // `totalValue + deposit` (callers pass totalValue = Σ selected balances) — so
  // single-set runs are unchanged.
  const grandTotal = working.reduce((sum, a) => sum + a.balance, 0) + deposit;

  const isDepositOnly = tradeType === 'Cash Deposit' && !rebalanceAll;

  if (isDepositOnly) {
    for (const acct of working) {
      if (acct.isDepositAccount) {
        const depositAlloc = allocateDepositOnly(deposit, acct.accountType, baseAllocation);
        acct.alloc = {
          cash: acct.holdings.cash + depositAlloc.cash,
          fixed: acct.holdings.fixed + depositAlloc.fixed,
          equity: acct.holdings.equity + depositAlloc.equity,
        };
      } else {
        acct.alloc = { ...acct.holdings };
      }
    }
  } else if (mode === 'mirror') {
    // Mirror mode: apply the household base allocation proportionally to each
    // account. No cross-account asset location — every account ends up with
    // the same cash/fixed/equity percentages as the household risk profile.
    // This branch deliberately does NOT call allocateToAccounts (the priority
    // matrix path), keeping the two strategies fully decoupled.
    for (const acct of working) {
      acct.alloc = {
        cash: acct.newCapacity * (baseAllocation.cash / 100),
        fixed: acct.newCapacity * (baseAllocation.fixed / 100),
        equity: acct.newCapacity * (baseAllocation.equity / 100),
      };
    }
  } else {
    const targets: Holdings = {
      cash: grandTotal * (baseAllocation.cash / 100),
      fixed: grandTotal * (baseAllocation.fixed / 100),
      equity: grandTotal * (baseAllocation.equity / 100),
    };
    allocateToAccounts('cash', targets.cash, working);
    allocateToAccounts('fixed', targets.fixed, working);
    allocateToAccounts('equity', targets.equity, working);
  }

  const plans: AccountExecutionPlan[] = working.map((acct) => {
    const modelKey = selectModel(acct.accountType, residence);
    const profile = getProfile(modelKey, riskProfile);

    // In deposit-only mode, non-deposit accounts are unchanged — no trades needed
    const skipTrades = isDepositOnly && !acct.isDepositAccount;
    const trades = skipTrades ? [] : generateFundTrades(acct, deposit, profile.positions, equityStrategies);
    const cashDepositContext = buildCashDepositContext(acct, deposit);
    const sleeveInstructions = buildSleeveInstructions(acct, deposit);

    return {
      accountNumber: acct.accountNumber,
      accountType: acct.accountType,
      accountValue: acct.newCapacity,
      templateName: buildTemplateName(
        clientName,
        clientNameMap,
        acct.clientId,
        acct.accountType,
        modelKey,
        riskProfile,
        equityStrategies,
      ),
      modelName: getModelDisplayName(modelKey),
      postTradeHoldings: acct.alloc,
      trades,
      action: acct.fixed ? ('recommend' as const) : ('execute' as const),
      ...(cashDepositContext ? { cashDepositContext } : {}),
      ...(sleeveInstructions.length > 0 ? { sleeveInstructions } : {}),
      varianceAnalysis: buildVariance(acct, deposit),
    };
  });

  const validation = verifyExecutionPlans(plans, {
    grandTotal,
    baseAllocation: { cash: baseAllocation.cash, fixed: baseAllocation.fixed, equity: baseAllocation.equity },
    isDepositOnly,
  });

  // Reachability check: if the advisor executes ONLY the trade-now accounts and
  // leaves the fixed-context siblings as they are, does the household still hit
  // its target? Compare (execute accounts at ideal) + (context at CURRENT) to
  // the household target; surface any gap as a non-fatal warning so the trader
  // knows the recommended sibling trades are required to fully reach target.
  if (!isDepositOnly && contextAccounts.length > 0) {
    const tol = validation.tolerances.aggregate;
    for (const sleeve of ['cash', 'fixed', 'equity'] as const) {
      const expected = grandTotal * (baseAllocation[sleeve] / 100);
      const executeOnly = working.reduce((sum, a) => sum + (a.fixed ? a.holdings[sleeve] : a.alloc[sleeve]), 0);
      const drift = executeOnly - expected;
      if (Math.abs(drift) > tol) {
        validation.issues.push({
          kind: 'household_off_target_without_recommend',
          sleeve,
          expected,
          actual: executeOnly,
          drift,
          driftPct: grandTotal > 0 ? drift / grandTotal : 0,
          message: `Trading only the selected account(s) leaves household ${sleeve} at ${formatDollar(executeOnly)} vs target ${formatDollar(expected)} (${formatDollar(drift)} off). The recommended sibling trades are needed to reach target.`,
        });
      }
    }
    validation.passed = validation.issues.length === 0;
  }

  if (!validation.passed) {
    logger.warn(
      { issues: validation.issues, tradeType, grandTotal },
      'Asset location engine produced a plan that failed post-allocation validation',
    );
  }

  return { plans, validation };
}
