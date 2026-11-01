import { describe, it, expect } from 'vitest';
import type { Account, EngineInput, AccountExecutionPlan } from '@trade-request/shared';
import { getRiskAllocation } from '@trade-request/shared/allocations';
import { runAssetLocationEngine, verifyExecutionPlans } from '../assetLocationEngine.js';

// baseAllocation derived from getRiskAllocation(18) so RISK_TABLE drift would surface as a test failure.
const RISK_18 = getRiskAllocation(18);
// Cash-deposit scenario: a risk-20 household; post-trade buckets are the allocation applied to balance + deposit.
const DEPOSIT_BASE = getRiskAllocation(20);
const DEPOSIT_TOTAL = 447_552.93 + 150_000;

function makeAccount(
  overrides: Partial<Account> & { accountNumber: string; accountType: Account['accountType'] },
): Account {
  return {
    id: overrides.accountNumber,
    clientId: 'HH-001',
    balance: 100_000,
    holdings: { cash: 10_000, fixed: 30_000, equity: 60_000 },
    ...overrides,
  };
}

function makeInput(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    tradeType: 'Rebalance',
    tradeAmount: '',
    depositAccountNumber: '',
    rebalanceAll: true,
    totalValue: 1_450_000,
    baseAllocation: RISK_18,
    riskProfile: 18,
    clientName: 'John Smith',
    accounts: [
      makeAccount({
        accountNumber: 'ACCT-1',
        accountType: 'Taxable',
        balance: 850_000,
        holdings: { cash: 42_500, fixed: 127_500, equity: 680_000 },
      }),
      makeAccount({
        accountNumber: 'ACCT-2',
        accountType: 'Traditional IRA',
        balance: 420_000,
        holdings: { cash: 2_100, fixed: 147_000, equity: 270_900 },
      }),
      makeAccount({
        accountNumber: 'ACCT-3',
        accountType: 'Roth IRA',
        balance: 180_000,
        holdings: { cash: 900, fixed: 0, equity: 179_100 },
      }),
    ],
    equityStrategies: [],
    residence: 'Other',
    ...overrides,
  };
}

function sumHoldings(plans: AccountExecutionPlan[]): { cash: number; fixed: number; equity: number } {
  return plans.reduce(
    (acc, p) => ({
      cash: acc.cash + p.postTradeHoldings.cash,
      fixed: acc.fixed + p.postTradeHoldings.fixed,
      equity: acc.equity + p.postTradeHoldings.equity,
    }),
    { cash: 0, fixed: 0, equity: 0 },
  );
}

describe('runAssetLocationEngine', () => {
  describe('full rebalance', () => {
    it('allocates across 3 accounts respecting priority matrix', () => {
      const { plans } = runAssetLocationEngine(makeInput());
      expect(plans).toHaveLength(3);

      const totals = sumHoldings(plans);
      const grandTotal = 1_450_000;
      expect(totals.cash).toBeCloseTo(grandTotal * (RISK_18.cash / 100), 0);
      expect(totals.fixed).toBeCloseTo(grandTotal * (RISK_18.fixed / 100), 0);
      expect(totals.equity).toBeCloseTo(grandTotal * (RISK_18.equity / 100), 0);
    });

    it('prioritizes equity in Roth IRA', () => {
      const { plans } = runAssetLocationEngine(makeInput());
      const roth = plans.find((p) => p.accountType === 'Roth IRA')!;
      expect(roth.postTradeHoldings.equity).toBeGreaterThan(0);
      expect(roth.postTradeHoldings.equity).toBe(roth.accountValue);
    });

    it('prioritizes fixed income in Traditional IRA', () => {
      const { plans } = runAssetLocationEngine(makeInput());
      const trad = plans.find((p) => p.accountType === 'Traditional IRA')!;
      expect(trad.postTradeHoldings.fixed).toBeGreaterThan(0);
    });

    it('generates trades with correct buy/sell directions', () => {
      const { plans } = runAssetLocationEngine(makeInput());
      for (const plan of plans) {
        for (const trade of plan.trades) {
          expect(['Buy', 'Sell']).toContain(trade.type);
          expect(trade.amount).toBeGreaterThan(1);
          expect(trade.asset).toBeTruthy();
        }
      }
    });

    it('sorts sells before buys', () => {
      const { plans } = runAssetLocationEngine(makeInput());
      for (const plan of plans) {
        if (plan.trades.length < 2) continue;
        const sellIdx = plan.trades.findIndex((t) => t.type === 'Sell');
        const buyIdx = plan.trades.findIndex((t) => t.type === 'Buy');
        if (sellIdx !== -1 && buyIdx !== -1) {
          expect(sellIdx).toBeLessThan(buyIdx);
        }
      }
    });
  });

  describe('cash deposit (deposit-only)', () => {
    it('only modifies the deposit account when rebalanceAll is false', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Cash Deposit',
          tradeAmount: '$50,000',
          depositAccountNumber: 'ACCT-1',
          rebalanceAll: false,
        }),
      );

      const nonDeposit = plans.filter((p) => p.accountNumber !== 'ACCT-1');
      for (const p of nonDeposit) {
        expect(p.trades).toHaveLength(0);
      }
    });

    it('increases deposit account value by deposit amount', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Cash Deposit',
          tradeAmount: '50000',
          depositAccountNumber: 'ACCT-1',
          rebalanceAll: false,
        }),
      );

      const deposit = plans.find((p) => p.accountNumber === 'ACCT-1')!;
      expect(deposit.accountValue).toBe(850_000 + 50_000);
    });

    it('adds deposit context only to the deposit account', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Cash Deposit',
          tradeAmount: '50000',
          depositAccountNumber: 'ACCT-1',
          rebalanceAll: false,
        }),
      );

      const deposit = plans.find((p) => p.accountNumber === 'ACCT-1')!;
      const nonDeposit = plans.filter((p) => p.accountNumber !== 'ACCT-1');
      expect(deposit.cashDepositContext).toMatchObject({
        depositAmount: 50_000,
        depositAccountNumber: 'ACCT-1',
        existingCash: 42_500,
      });
      for (const p of nonDeposit) {
        expect(p.cashDepositContext).toBeUndefined();
      }
    });
  });

  describe('cash deposit with rebalanceAll', () => {
    it('rebalances all accounts including the deposit', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Cash Deposit',
          tradeAmount: '50000',
          depositAccountNumber: 'ACCT-1',
          rebalanceAll: true,
        }),
      );

      const totals = sumHoldings(plans);
      const grandTotal = 1_450_000 + 50_000;
      expect(totals.cash + totals.fixed + totals.equity).toBeCloseTo(grandTotal, 0);
    });

    it('does not treat new USD deposit as existing cash/MMF when generating cash trades', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Cash Deposit',
          tradeAmount: '150000',
          depositAccountNumber: 'ZZ10001',
          totalValue: 447_552.93,
          baseAllocation: DEPOSIT_BASE,
          riskProfile: 20,
          residence: 'NY',
          accounts: [
            makeAccount({
              accountNumber: 'ZZ10001',
              accountType: 'Joint',
              balance: 447_552.93,
              holdings: { cash: 2_260, fixed: 58_883.28, equity: 386_409.65 },
            }),
          ],
          equityStrategies: [{ id: 1, benchmark: 'URTH', allocation: 100, rationale: 'URTH custom model' }],
        }),
      );

      const [plan] = plans;
      expect(plan.postTradeHoldings.cash).toBeCloseTo(DEPOSIT_TOTAL * (DEPOSIT_BASE.cash / 100), 2);
      expect(plan.postTradeHoldings.fixed).toBeCloseTo(DEPOSIT_TOTAL * (DEPOSIT_BASE.fixed / 100), 2);
      expect(plan.postTradeHoldings.equity).toBeCloseTo(DEPOSIT_TOTAL * (DEPOSIT_BASE.equity / 100), 2);
      expect(plan.varianceAnalysis!.preTrade).toEqual({ cash: 2_260, fixed: 58_883.28, equity: 386_409.65 });
      expect(plan.cashDepositContext).toMatchObject({
        depositAmount: 150_000,
        depositAccountNumber: 'ZZ10001',
        existingCash: 2_260,
        availableCash: 152_260,
      });
      expect(plan.cashDepositContext!.targetCash).toBeCloseTo(DEPOSIT_TOTAL * (DEPOSIT_BASE.cash / 100), 2);
      expect(plan.cashDepositContext!.cashToDeploy).toBeCloseTo(152_260 - DEPOSIT_TOTAL * (DEPOSIT_BASE.cash / 100), 2);

      const vyfxxTrades = plan.trades.filter((t) => t.asset.includes('VYFXX'));
      expect(vyfxxTrades).toHaveLength(1);
      expect(vyfxxTrades[0].type).toBe('Buy');
      expect(vyfxxTrades[0].amount).toBeCloseTo(DEPOSIT_TOTAL * (DEPOSIT_BASE.cash / 100) - 2_260, 2);
      expect(plan.trades.some((t) => t.type === 'Sell' && t.asset.includes('VYFXX') && t.amount > 100_000)).toBe(false);

      const fixedBuys = plan.trades.filter(
        (t) => t.type === 'Buy' && ['SUB', 'VNYTX', 'MUB'].some((f) => t.asset.includes(f)), // the NY model's fixed-income funds
      );
      const equityBuy = plan.trades.find((t) => t.type === 'Buy' && t.asset.includes('URTH Strategy'));
      expect(fixedBuys.reduce((sum, t) => sum + t.amount, 0)).toBeCloseTo(
        DEPOSIT_TOTAL * (DEPOSIT_BASE.fixed / 100) - 58_883.28,
        2,
      );
      expect(equityBuy?.amount).toBeCloseTo(DEPOSIT_TOTAL * (DEPOSIT_BASE.equity / 100) - 386_409.65, 2);

      const totalPositiveDeltas =
        plan.sleeveInstructions?.filter((s) => s.delta > 0).reduce((sum, s) => sum + s.delta, 0) ?? 0;
      expect(totalPositiveDeltas).toBeCloseTo(150_000, 2);
    });
  });

  describe('edge cases', () => {
    it('throws when no accounts provided', () => {
      expect(() => runAssetLocationEngine(makeInput({ accounts: [] }))).toThrow('No accounts provided');
    });

    it('handles a single account', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          totalValue: 100_000,
          accounts: [makeAccount({ accountNumber: 'ACCT-1', accountType: 'Taxable', balance: 100_000 })],
        }),
      );
      expect(plans).toHaveLength(1);
      const totals = sumHoldings(plans);
      expect(totals.cash + totals.fixed + totals.equity).toBeCloseTo(100_000, 0);
    });

    it('handles zero balance accounts', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          totalValue: 0,
          accounts: [
            makeAccount({
              accountNumber: 'ACCT-1',
              accountType: 'Taxable',
              balance: 0,
              holdings: { cash: 0, fixed: 0, equity: 0 },
            }),
          ],
        }),
      );
      expect(plans).toHaveLength(1);
      expect(plans[0].trades).toHaveLength(0);
    });

    it('handles 100% equity allocation', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          baseAllocation: { equity: 100, fixed: 0, cash: 0 },
        }),
      );
      const totals = sumHoldings(plans);
      expect(totals.equity).toBeCloseTo(1_450_000, 0);
      expect(totals.cash).toBeCloseTo(0, 0);
      expect(totals.fixed).toBeCloseTo(0, 0);
    });

    it('handles 100% cash allocation', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          baseAllocation: { equity: 0, fixed: 0, cash: 100 },
        }),
      );
      const totals = sumHoldings(plans);
      expect(totals.cash).toBeCloseTo(1_450_000, 0);
    });
  });

  describe('initial funding', () => {
    it('generates only Buy trades (no Sells) since holdings start as uninvested USD', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Initial Funding',
          totalValue: 500_000,
          accounts: [
            makeAccount({
              accountNumber: 'ACCT-1',
              accountType: 'Taxable',
              balance: 300_000,
              holdings: { cash: 300_000, fixed: 0, equity: 0 },
            }),
            makeAccount({
              accountNumber: 'ACCT-2',
              accountType: 'Traditional IRA',
              balance: 200_000,
              holdings: { cash: 200_000, fixed: 0, equity: 0 },
            }),
          ],
        }),
      );

      const allTrades = plans.flatMap((p) => p.trades);
      expect(allTrades.length).toBeGreaterThan(0);
      for (const trade of allTrades) {
        expect(trade.type).toBe('Buy');
      }
    });

    it('zeroes out pre-trade holdings in variance analysis', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Initial Funding',
          totalValue: 500_000,
          accounts: [
            makeAccount({
              accountNumber: 'ACCT-1',
              accountType: 'Taxable',
              balance: 500_000,
              holdings: { cash: 500_000, fixed: 0, equity: 0 },
            }),
          ],
        }),
      );

      const plan = plans[0];
      expect(plan.varianceAnalysis!.preTrade).toEqual({ cash: 0, fixed: 0, equity: 0 });
      expect(plan.cashDepositContext).toBeUndefined();
    });

    it('allocates full household value across target sleeves', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Initial Funding',
          totalValue: 1_000_000,
          baseAllocation: { equity: 80, fixed: 15, cash: 5 },
          accounts: [
            makeAccount({
              accountNumber: 'ACCT-1',
              accountType: 'Taxable',
              balance: 600_000,
              holdings: { cash: 600_000, fixed: 0, equity: 0 },
            }),
            makeAccount({
              accountNumber: 'ACCT-2',
              accountType: 'Roth IRA',
              balance: 400_000,
              holdings: { cash: 400_000, fixed: 0, equity: 0 },
            }),
          ],
        }),
      );

      const totals = sumHoldings(plans);
      expect(totals.equity).toBeCloseTo(800_000, 0);
      expect(totals.fixed).toBeCloseTo(150_000, 0);
      expect(totals.cash).toBeCloseTo(50_000, 0);
    });
  });

  describe('equity strategies', () => {
    it('splits equity trades across multiple strategies', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          equityStrategies: [
            { id: 1, benchmark: 'S&P 500', allocation: 60, rationale: '' },
            { id: 2, benchmark: 'International', allocation: 40, rationale: '' },
          ],
        }),
      );

      const allTrades = plans.flatMap((p) => p.trades);
      const sp500 = allTrades.filter((t) => t.asset.includes('S&P 500'));
      const intl = allTrades.filter((t) => t.asset.includes('International'));
      expect(sp500.length).toBeGreaterThan(0);
      expect(intl.length).toBeGreaterThan(0);
    });

    it('uses generic Direct Index when no strategies defined', () => {
      const { plans } = runAssetLocationEngine(makeInput({ equityStrategies: [] }));
      const allTrades = plans.flatMap((p) => p.trades);
      const generic = allTrades.filter((t) => t.asset === 'Direct Index');
      expect(generic.length).toBeGreaterThan(0);
    });
  });

  describe('trade-to-allocation consistency', () => {
    it('individual position trades sum to the account-level asset class allocation', () => {
      const { plans } = runAssetLocationEngine(makeInput());

      for (const plan of plans) {
        const preCash = plan.varianceAnalysis!.preTrade.cash;
        const preFixed = plan.varianceAnalysis!.preTrade.fixed;
        const preEquity = plan.varianceAnalysis!.preTrade.equity;

        let postCash = preCash;
        let postFixed = preFixed;
        let postEquity = preEquity;

        for (const trade of plan.trades) {
          const signed = trade.type === 'Buy' ? trade.amount : -trade.amount;
          if (trade.asset.includes('Strategy') || trade.asset === 'Direct Index') {
            postEquity += signed;
          } else if (trade.rationale.includes('equity')) {
            postEquity += signed;
          } else {
            // Determine asset class from the resolved label
            const isCash = ['SWVXX', 'VYFXX', 'VCTXX', 'VMSXX', 'VUSXX'].some((s) => trade.asset.includes(s));
            if (isCash) {
              postCash += signed;
            } else {
              postFixed += signed;
            }
          }
        }

        expect(postCash).toBeCloseTo(plan.postTradeHoldings.cash, 0);
        expect(postFixed).toBeCloseTo(plan.postTradeHoldings.fixed, 0);
        expect(postEquity).toBeCloseTo(plan.postTradeHoldings.equity, 0);
      }
    });

    it('position percentages within an asset class sum to the class-level percentage', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          baseAllocation: { equity: 73, fixed: 26.5, cash: 0.5 },
          riskProfile: 15,
        }),
      );

      for (const plan of plans) {
        if (plan.accountValue === 0) continue;

        const fixedTarget = plan.postTradeHoldings.fixed;
        const cashTarget = plan.postTradeHoldings.cash;
        const equityTarget = plan.postTradeHoldings.equity;

        const preCash = plan.varianceAnalysis!.preTrade.cash;
        const preFixed = plan.varianceAnalysis!.preTrade.fixed;
        const preEquity = plan.varianceAnalysis!.preTrade.equity;

        let impliedCash = preCash;
        let impliedFixed = preFixed;
        let impliedEquity = preEquity;

        for (const trade of plan.trades) {
          const signed = trade.type === 'Buy' ? trade.amount : -trade.amount;
          if (trade.asset.includes('Strategy') || trade.asset === 'Direct Index') {
            impliedEquity += signed;
          } else {
            const isCash = ['SWVXX', 'VYFXX', 'VCTXX', 'VMSXX', 'VUSXX'].some((s) => trade.asset.includes(s));
            if (isCash) impliedCash += signed;
            else impliedFixed += signed;
          }
        }

        expect(impliedCash).toBeCloseTo(cashTarget, 0);
        expect(impliedFixed).toBeCloseTo(fixedTarget, 0);
        expect(impliedEquity).toBeCloseTo(equityTarget, 0);
      }
    });
  });

  describe('variance analysis', () => {
    it('includes preTrade and postTrade for each account', () => {
      const { plans } = runAssetLocationEngine(makeInput());
      for (const plan of plans) {
        expect(plan.varianceAnalysis).toBeDefined();
        expect(plan.varianceAnalysis!.preTrade).toBeDefined();
        expect(plan.varianceAnalysis!.postTrade).toBeDefined();
      }
    });

    it('keeps deposit USD separate from preTrade cash', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Cash Deposit',
          tradeAmount: '50000',
          depositAccountNumber: 'ACCT-1',
          rebalanceAll: true,
        }),
      );

      const depositPlan = plans.find((p) => p.accountNumber === 'ACCT-1')!;
      expect(depositPlan.varianceAnalysis!.preTrade.cash).toBe(42_500);
      expect(depositPlan.cashDepositContext!.depositAmount).toBe(50_000);

      const otherPlan = plans.find((p) => p.accountNumber === 'ACCT-2')!;
      expect(otherPlan.varianceAnalysis!.preTrade.cash).toBe(2_100);
    });
  });

  describe('template naming', () => {
    it('generates correct template name for single client', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          clientName: 'John Smith',
          riskProfile: 15,
          equityStrategies: [
            { id: 1, benchmark: 'IWV', allocation: 65, rationale: '' },
            { id: 2, benchmark: 'EFA', allocation: 35, rationale: '' },
          ],
        }),
      );
      const taxable = plans.find((p) => p.accountType === 'Taxable')!;
      expect(taxable.templateName).toBe('Smith Taxable National Tax Efficient Risk 15 IWV/EFA');
      const trad = plans.find((p) => p.accountType === 'Traditional IRA')!;
      expect(trad.templateName).toBe('Smith Traditional IRA Taxable National Risk 15 IWV/EFA');
    });

    it('generates correct template name for joint clients', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          clientName: 'John Smith & Jane Johnson',
          clientNameMap: { 'HH-001': 'John Smith', 'HH-002': 'Jane Johnson' },
          riskProfile: 10,
          accounts: [makeAccount({ accountNumber: 'ACCT-1', accountType: 'Joint', balance: 100_000 })],
          totalValue: 100_000,
          baseAllocation: { equity: 38, fixed: 48, cash: 14 },
          equityStrategies: [{ id: 1, benchmark: 'IWV', allocation: 100, rationale: '' }],
        }),
      );
      expect(plans[0].templateName).toBe('Smith/Johnson Joint National Tax Efficient Risk 10 IWV');
    });

    it('uses individual last name for non-joint accounts in multi-client household', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          clientName: 'John Smith & Jane Johnson',
          clientNameMap: { 'HH-001': 'John Smith', 'HH-002': 'Jane Johnson' },
          riskProfile: 10,
          accounts: [
            makeAccount({ accountNumber: 'ACCT-1', accountType: 'Joint', balance: 500_000, clientId: 'HH-001' }),
            makeAccount({
              accountNumber: 'ACCT-2',
              accountType: 'Traditional IRA',
              balance: 300_000,
              clientId: 'HH-001',
            }),
            makeAccount({ accountNumber: 'ACCT-3', accountType: 'Roth IRA', balance: 200_000, clientId: 'HH-002' }),
          ],
          totalValue: 1_000_000,
          baseAllocation: { equity: 38, fixed: 48, cash: 14 },
          equityStrategies: [{ id: 1, benchmark: 'IWV', allocation: 100, rationale: '' }],
        }),
      );

      const joint = plans.find((p) => p.accountType === 'Joint')!;
      expect(joint.templateName).toContain('Smith/Johnson');

      const trad = plans.find((p) => p.accountType === 'Traditional IRA')!;
      expect(trad.templateName).toMatch(/^Smith /);
      expect(trad.templateName).not.toContain('Johnson');

      const roth = plans.find((p) => p.accountType === 'Roth IRA')!;
      expect(roth.templateName).toMatch(/^Johnson /);
      expect(roth.templateName).not.toContain('Smith');
    });

    it('falls back to combined name when clientNameMap is not provided', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          clientName: 'John Smith & Jane Johnson',
          riskProfile: 10,
          accounts: [makeAccount({ accountNumber: 'ACCT-1', accountType: 'Taxable', balance: 100_000 })],
          totalValue: 100_000,
          baseAllocation: { equity: 38, fixed: 48, cash: 14 },
          equityStrategies: [{ id: 1, benchmark: 'IWV', allocation: 100, rationale: '' }],
        }),
      );
      expect(plans[0].templateName).toContain('Smith/Johnson');
    });
  });

  describe('residence-based model selection', () => {
    it('uses NY model for NY Taxable accounts', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          residence: 'NY',
          riskProfile: 10,
          baseAllocation: { equity: 38, fixed: 48, cash: 14 },
          totalValue: 100_000,
          accounts: [makeAccount({ accountNumber: 'ACCT-1', accountType: 'Taxable', balance: 100_000 })],
        }),
      );
      expect(plans[0].modelName).toBe('New York');
      const nyFunds = plans[0].trades.filter((t) => t.asset.includes('VYFXX') || t.asset.includes('VNYTX'));
      expect(nyFunds.length).toBeGreaterThan(0);
    });

    it('uses CA model for CA Taxable accounts', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          residence: 'CA',
          riskProfile: 10,
          baseAllocation: { equity: 38, fixed: 48, cash: 14 },
          totalValue: 100_000,
          accounts: [makeAccount({ accountNumber: 'ACCT-1', accountType: 'Taxable', balance: 100_000 })],
        }),
      );
      expect(plans[0].modelName).toBe('California');
      const caFunds = plans[0].trades.filter((t) => t.asset.includes('VCTXX') || t.asset.includes('VCAIX'));
      expect(caFunds.length).toBeGreaterThan(0);
    });

    it('uses Taxable National for IRA accounts regardless of residence', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          residence: 'NY',
          riskProfile: 10,
          baseAllocation: { equity: 38, fixed: 48, cash: 14 },
          totalValue: 100_000,
          accounts: [makeAccount({ accountNumber: 'ACCT-1', accountType: 'Traditional IRA', balance: 100_000 })],
        }),
      );
      expect(plans[0].modelName).toBe('Taxable National');
      const swvxx = plans[0].trades.filter((t) => t.asset.includes('SWVXX'));
      expect(swvxx.length).toBeGreaterThan(0);
    });
  });

  describe('input validation', () => {
    it('throws when baseAllocation does not sum to 100', () => {
      expect(() =>
        runAssetLocationEngine(
          makeInput({
            baseAllocation: { equity: 50, fixed: 20, cash: 5 },
          }),
        ),
      ).toThrow('Base allocation must sum to 100');
    });

    it('throws when no accounts provided', () => {
      expect(() => runAssetLocationEngine(makeInput({ accounts: [] }))).toThrow('No accounts');
    });

    it('throws when equity strategies do not sum to 100', () => {
      expect(() =>
        runAssetLocationEngine(
          makeInput({
            equityStrategies: [
              { id: 1, allocation: 60, benchmark: 'SPY', rationale: '' },
              { id: 2, allocation: 30, benchmark: 'IWD', rationale: '' },
            ],
          }),
        ),
      ).toThrow('Equity strategy allocations must sum to 100');
    });

    it('accepts equity strategies that sum to 100', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          equityStrategies: [
            { id: 1, allocation: 60, benchmark: 'SPY', rationale: '' },
            { id: 2, allocation: 40, benchmark: 'IWD', rationale: '' },
          ],
        }),
      );
      expect(plans.length).toBeGreaterThan(0);
    });
  });

  describe('validation', () => {
    it('passes on a clean full rebalance', () => {
      const { validation } = runAssetLocationEngine(makeInput());
      expect(validation.passed).toBe(true);
      expect(validation.issues).toEqual([]);
      expect(validation.tolerances).toEqual({ aggregate: 1, account: 1, negative: 0.01 });
    });

    it('passes on initial funding', () => {
      const { validation } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Initial Funding',
          totalValue: 1_000_000,
          baseAllocation: { equity: 80, fixed: 15, cash: 5 },
          accounts: [
            makeAccount({
              accountNumber: 'ACCT-1',
              accountType: 'Taxable',
              balance: 600_000,
              holdings: { cash: 600_000, fixed: 0, equity: 0 },
            }),
            makeAccount({
              accountNumber: 'ACCT-2',
              accountType: 'Roth IRA',
              balance: 400_000,
              holdings: { cash: 400_000, fixed: 0, equity: 0 },
            }),
          ],
        }),
      );
      expect(validation.passed).toBe(true);
    });

    it('passes on deposit-only mode and skips the aggregate check', () => {
      const { validation } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Cash Deposit',
          tradeAmount: '50000',
          depositAccountNumber: 'ACCT-1',
          rebalanceAll: false,
        }),
      );
      expect(validation.passed).toBe(true);
      expect(validation.issues.filter((i) => i.kind === 'aggregate_drift')).toEqual([]);
    });

    it('reconciles when filling two accounts of the same type', () => {
      const { plans, validation } = runAssetLocationEngine(
        makeInput({
          totalValue: 200_000,
          baseAllocation: { equity: 60, fixed: 35, cash: 5 },
          accounts: [
            makeAccount({
              accountNumber: 'TAX-1',
              accountType: 'Taxable',
              balance: 100_000,
              holdings: { cash: 5_000, fixed: 35_000, equity: 60_000 },
            }),
            makeAccount({
              accountNumber: 'TAX-2',
              accountType: 'Taxable',
              balance: 100_000,
              holdings: { cash: 5_000, fixed: 35_000, equity: 60_000 },
            }),
          ],
        }),
      );
      expect(validation.passed).toBe(true);

      // Within-type-spread regression guard. With sequential first-fit fill,
      // TAX-1 would absorb 100% of cash + fixed and TAX-2 would absorb all the
      // equity — i.e. fixed/equity ratios diverge by ~70pp. With proportional
      // spread (the current contract), both Taxables converge to identical
      // ratios because they have equal capacity.
      const tax1 = plans.find((p) => p.accountNumber === 'TAX-1')!;
      const tax2 = plans.find((p) => p.accountNumber === 'TAX-2')!;
      const fixedDelta = Math.abs(
        tax1.postTradeHoldings.fixed / tax1.accountValue - tax2.postTradeHoldings.fixed / tax2.accountValue,
      );
      const equityDelta = Math.abs(
        tax1.postTradeHoldings.equity / tax1.accountValue - tax2.postTradeHoldings.equity / tax2.accountValue,
      );
      expect(fixedDelta).toBeLessThan(0.01);
      expect(equityDelta).toBeLessThan(0.01);
    });

    it('flags aggregate under-allocation when capacity is insufficient', () => {
      // Tiny portfolio targeting 100% equity but Traditional IRA is bottom priority for equity;
      // synthesize an issue by manually checking the validator on a known-bad plan shape.
      const fakePlans: AccountExecutionPlan[] = [
        {
          accountNumber: 'ACCT-1',
          accountType: 'Taxable',
          accountValue: 100_000,
          templateName: 'X Taxable',
          modelName: 'Taxable National',
          postTradeHoldings: { cash: 0, fixed: 0, equity: 80_000 },
          trades: [],
        },
      ];
      const result = verifyExecutionPlans(fakePlans, {
        grandTotal: 100_000,
        baseAllocation: { cash: 0, fixed: 0, equity: 100 },
        isDepositOnly: false,
      });
      expect(result.passed).toBe(false);
      const aggregate = result.issues.find((i) => i.kind === 'aggregate_drift');
      expect(aggregate).toBeDefined();
      expect(aggregate!.sleeve).toBe('equity');
      expect(aggregate!.drift).toBeCloseTo(-20_000, 0);
      const accountCap = result.issues.find((i) => i.kind === 'account_capacity');
      expect(accountCap).toBeDefined();
      expect(accountCap!.drift).toBeCloseTo(-20_000, 0);
    });

    it('flags negative allocations', () => {
      const fakePlans: AccountExecutionPlan[] = [
        {
          accountNumber: 'ACCT-1',
          accountType: 'Taxable',
          accountValue: 100_000,
          templateName: 'X Taxable',
          modelName: 'Taxable National',
          postTradeHoldings: { cash: -500, fixed: 40_500, equity: 60_000 },
          trades: [],
        },
      ];
      const result = verifyExecutionPlans(fakePlans, {
        grandTotal: 100_000,
        baseAllocation: { cash: 0, fixed: 40, equity: 60 },
        isDepositOnly: false,
      });
      expect(result.passed).toBe(false);
      const neg = result.issues.find((i) => i.kind === 'negative_allocation');
      expect(neg).toBeDefined();
      expect(neg!.sleeve).toBe('cash');
      expect(neg!.actual).toBe(-500);
    });

    it('ignores floating-point noise within tolerance', () => {
      const fakePlans: AccountExecutionPlan[] = [
        {
          accountNumber: 'ACCT-1',
          accountType: 'Taxable',
          accountValue: 100_000,
          templateName: 'X Taxable',
          modelName: 'Taxable National',
          postTradeHoldings: { cash: -0.005, fixed: 40_000.3, equity: 60_000 },
          trades: [],
        },
      ];
      const result = verifyExecutionPlans(fakePlans, {
        grandTotal: 100_000,
        baseAllocation: { cash: 0, fixed: 40, equity: 60 },
        isDepositOnly: false,
      });
      expect(result.passed).toBe(true);
    });

    it('includes a human-readable message with $ and % on each issue', () => {
      const fakePlans: AccountExecutionPlan[] = [
        {
          accountNumber: 'ACCT-1',
          accountType: 'Taxable',
          accountValue: 100_000,
          templateName: 'X Taxable',
          modelName: 'Taxable National',
          postTradeHoldings: { cash: 0, fixed: 0, equity: 80_000 },
          trades: [],
        },
      ];
      const result = verifyExecutionPlans(fakePlans, {
        grandTotal: 100_000,
        baseAllocation: { cash: 0, fixed: 0, equity: 100 },
        isDepositOnly: false,
      });
      for (const issue of result.issues) {
        expect(issue.message).toMatch(/\$/);
        expect(issue.message).toMatch(/%/);
      }
    });
  });

  describe('mirror mode', () => {
    it('Ellis-shaped household: applies household base allocation proportionally to each account', () => {
      const baseAllocation = getRiskAllocation(18);
      const { plans } = runAssetLocationEngine(makeInput({ assetLocationMode: 'mirror', baseAllocation }));

      expect(plans).toHaveLength(3);
      for (const plan of plans) {
        const av = plan.accountValue;
        expect(plan.postTradeHoldings.cash).toBeCloseTo(av * (baseAllocation.cash / 100), 1);
        expect(plan.postTradeHoldings.fixed).toBeCloseTo(av * (baseAllocation.fixed / 100), 1);
        expect(plan.postTradeHoldings.equity).toBeCloseTo(av * (baseAllocation.equity / 100), 1);
      }
    });

    it('produces different per-account allocations from priority mode for the same household', () => {
      const priorityResult = runAssetLocationEngine(makeInput({ assetLocationMode: 'priority' }));
      const mirrorResult = runAssetLocationEngine(makeInput({ assetLocationMode: 'mirror' }));

      const priorityRoth = priorityResult.plans.find((p) => p.accountType === 'Roth IRA')!;
      const mirrorRoth = mirrorResult.plans.find((p) => p.accountType === 'Roth IRA')!;

      expect(priorityRoth.postTradeHoldings.equity).toBe(priorityRoth.accountValue);
      expect(mirrorRoth.postTradeHoldings.equity).toBeCloseTo(mirrorRoth.accountValue * (RISK_18.equity / 100), 1);
      expect(mirrorRoth.postTradeHoldings.fixed).toBeGreaterThan(0);
    });

    it('preserves grand-total dollar sums (no allocation leakage)', () => {
      const { plans } = runAssetLocationEngine(makeInput({ assetLocationMode: 'mirror' }));
      const totals = sumHoldings(plans);
      const grandTotal = 1_450_000;
      expect(totals.cash + totals.fixed + totals.equity).toBeCloseTo(grandTotal, 0);
      expect(totals.cash).toBeCloseTo(grandTotal * (RISK_18.cash / 100), 0);
      expect(totals.fixed).toBeCloseTo(grandTotal * (RISK_18.fixed / 100), 0);
      expect(totals.equity).toBeCloseTo(grandTotal * (RISK_18.equity / 100), 0);
    });

    it('Example-shaped household: 100% equity base allocation lands every sleeve fully in equity', () => {
      const { plans } = runAssetLocationEngine(
        makeInput({
          assetLocationMode: 'mirror',
          baseAllocation: { equity: 100, fixed: 0, cash: 0 },
        }),
      );
      for (const plan of plans) {
        expect(plan.postTradeHoldings.equity).toBeCloseTo(plan.accountValue, 1);
        expect(plan.postTradeHoldings.fixed).toBeCloseTo(0, 1);
        expect(plan.postTradeHoldings.cash).toBeCloseTo(0, 1);
      }
    });

    it("defaults to 'priority' when assetLocationMode is omitted (back-compat)", () => {
      const withMode = runAssetLocationEngine(makeInput({ assetLocationMode: 'priority' }));
      const withoutMode = runAssetLocationEngine(makeInput());
      for (let i = 0; i < withMode.plans.length; i++) {
        const a = withMode.plans[i].postTradeHoldings;
        const b = withoutMode.plans[i].postTradeHoldings;
        expect(b.cash).toBeCloseTo(a.cash, 2);
        expect(b.fixed).toBeCloseTo(a.fixed, 2);
        expect(b.equity).toBeCloseTo(a.equity, 2);
      }
    });

    it('cash-deposit-only (rebalanceAll: false) ignores mirror mode and stays on the deposit-only branch', () => {
      const baseAllocation = getRiskAllocation(18);
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Cash Deposit',
          tradeAmount: '50000',
          depositAccountNumber: 'ACCT-1',
          rebalanceAll: false,
          assetLocationMode: 'mirror',
          baseAllocation,
        }),
      );
      // Non-deposit accounts should remain at their pre-trade holdings, not the mirror split.
      const trad = plans.find((p) => p.accountNumber === 'ACCT-2')!;
      expect(trad.postTradeHoldings.cash).toBeCloseTo(2_100, 0);
      expect(trad.postTradeHoldings.fixed).toBeCloseTo(147_000, 0);
      expect(trad.postTradeHoldings.equity).toBeCloseTo(270_900, 0);
    });

    it('cash-deposit with rebalanceAll triggers full mirror redistribution including the deposit', () => {
      const baseAllocation = getRiskAllocation(18);
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Cash Deposit',
          tradeAmount: '50000',
          depositAccountNumber: 'ACCT-1',
          rebalanceAll: true,
          assetLocationMode: 'mirror',
          baseAllocation,
        }),
      );
      for (const plan of plans) {
        const av = plan.accountValue;
        expect(plan.postTradeHoldings.cash).toBeCloseTo(av * (baseAllocation.cash / 100), 1);
        expect(plan.postTradeHoldings.fixed).toBeCloseTo(av * (baseAllocation.fixed / 100), 1);
        expect(plan.postTradeHoldings.equity).toBeCloseTo(av * (baseAllocation.equity / 100), 1);
      }
    });

    it('initial funding in mirror mode: every account starts at 0 holdings and ends at the household ratios', () => {
      const baseAllocation = getRiskAllocation(18);
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Initial Funding',
          rebalanceAll: true,
          assetLocationMode: 'mirror',
          baseAllocation,
        }),
      );
      for (const plan of plans) {
        const av = plan.accountValue;
        expect(plan.postTradeHoldings.cash).toBeCloseTo(av * (baseAllocation.cash / 100), 1);
        expect(plan.postTradeHoldings.fixed).toBeCloseTo(av * (baseAllocation.fixed / 100), 1);
        expect(plan.postTradeHoldings.equity).toBeCloseTo(av * (baseAllocation.equity / 100), 1);
        // No Sells expected from a zero starting position.
        for (const trade of plan.trades) {
          expect(trade.type).toBe('Buy');
        }
      }
    });

    it('passes verifyExecutionPlans household + per-account totals checks', () => {
      const baseAllocation = getRiskAllocation(18);
      const { plans, validation } = runAssetLocationEngine(makeInput({ assetLocationMode: 'mirror', baseAllocation }));
      expect(validation).toBeDefined();
      expect(validation!.passed).toBe(true);
      // Re-run the verifier explicitly to be sure.
      const reVerify = verifyExecutionPlans(plans, {
        grandTotal: 1_450_000,
        baseAllocation,
        isDepositOnly: false,
      });
      expect(reVerify.passed).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Within-type proportional spread
  //
  // See docs/plans/2026-q4-engine-within-type-spread.md (P3) and Linear
  // ticket. When a household has multiple accounts of the same `accountType`
  // (e.g. spouse Trad IRAs), `allocateToAccounts` distributes each
  // priority-class fill proportionally to remaining capacity across the peer
  // set instead of greedily filling the first peer. The single-account-per-
  // type case is byte-identical to the prior sequential-fill behavior by
  // construction (see Appendix A of the source plan).
  // ──────────────────────────────────────────────────────────────────────────
  describe('within-type proportional spread', () => {
    /**
     * Frozen golden snapshot of the canonical Taxable + Trad + Roth fixture
     * captured on main before within-type-spread shipped. Single-account-per-
     * type input MUST produce byte-identical output after this change — that
     * is the no-regression contract called out in
     * docs/plans/2026-q4-engine-within-type-spread.md ("Goals").
     *
     * To re-capture if the engine's golden output legitimately changes
     * (e.g. profile or fund list update): temporarily replace the assertion
     * below with `console.log(JSON.stringify(plans.map(projectGolden), null, 2))`,
     * run the test on the new baseline, paste the actual into the expected,
     * and commit both in the same change.
     */
    const GOLDEN_SINGLE_PER_TYPE = [
      {
        accountNumber: 'ACCT-1',
        postTradeHoldings: { cash: 58000, fixed: 0, equity: 792000 },
        trades: [
          { asset: 'SUB – iShares Short-Term National Muni Bond ETF', type: 'Sell', amount: 36720.00000000001 },
          { asset: 'VTEB – Vanguard Tax-Exempt Bond ETF', type: 'Sell', amount: 52020 },
          { asset: 'MUB – iShares National Muni Bond ETF', type: 'Sell', amount: 38760 },
          { asset: 'VMSXX – Vanguard Municipal Money Market Fund', type: 'Buy', amount: 15500 },
          { asset: 'Direct Index', type: 'Buy', amount: 112000 },
        ],
      },
      {
        accountNumber: 'ACCT-2',
        postTradeHoldings: { cash: 0, fixed: 362500, equity: 57500 },
        trades: [
          { asset: 'SWVXX – Schwab Value Advantage Money Fund', type: 'Sell', amount: 2100 },
          { asset: 'Direct Index', type: 'Sell', amount: 213400 },
          { asset: 'VGSH – Vanguard Short-Term Treasury ETF', type: 'Buy', amount: 50858 },
          { asset: 'VCSH – Vanguard Short-Term Corporate Bond ETF', type: 'Buy', amount: 56892 },
          { asset: 'AGG – iShares Core U.S. Aggregate Bond ETF', type: 'Buy', amount: 62926 },
          { asset: 'SCHR – Schwab Intermediate-Term U.S. Treasury ETF', type: 'Buy', amount: 44824 },
        ],
      },
      {
        accountNumber: 'ACCT-3',
        postTradeHoldings: { cash: 0, fixed: 0, equity: 180000 },
        trades: [
          { asset: 'SWVXX – Schwab Value Advantage Money Fund', type: 'Sell', amount: 900 },
          { asset: 'Direct Index', type: 'Buy', amount: 900 },
        ],
      },
    ];

    function projectGolden(plan: AccountExecutionPlan) {
      return {
        accountNumber: plan.accountNumber,
        postTradeHoldings: plan.postTradeHoldings,
        trades: plan.trades.map((t) => ({ asset: t.asset, type: t.type, amount: t.amount })),
      };
    }

    it('produces byte-identical output for single-account-per-type households (no-regression contract)', () => {
      const { plans } = runAssetLocationEngine(makeInput());
      expect(plans.map(projectGolden)).toEqual(GOLDEN_SINGLE_PER_TYPE);
    });

    // Whitaker Family canvas shape: Roth + 2× Trad at Risk 15, ~$922K. Today's
    // engine concentrates fixed income in the smaller Trad (Owen, $67K);
    // Meridian spreads bonds proportionally so both Trads carry ~26% bonds.
    // See docs/plans/2026-q4-engine-within-type-spread.md (Context, Goals).
    const whitakerInput = (): EngineInput =>
      makeInput({
        clientName: 'Whitaker Family',
        totalValue: 922_000,
        baseAllocation: { equity: 73, fixed: 26.5, cash: 0.5 },
        riskProfile: 15,
        accounts: [
          makeAccount({
            accountNumber: 'WH-OWEN-TRAD',
            accountType: 'Traditional IRA',
            balance: 67_000,
            holdings: { cash: 23_000, fixed: 27_000, equity: 17_000 },
          }),
          makeAccount({
            accountNumber: 'WH-NORA-TRAD',
            accountType: 'Traditional IRA',
            balance: 821_000,
            holdings: { cash: 0, fixed: 182_000, equity: 639_000 },
          }),
          makeAccount({
            accountNumber: 'WH-NORA-ROTH',
            accountType: 'Roth IRA',
            balance: 34_000,
            holdings: { cash: 0, fixed: 0, equity: 34_000 },
          }),
        ],
      });

    it('spreads fixed income proportionally across spouse Trads (Whitaker replication)', () => {
      const { plans, validation } = runAssetLocationEngine(whitakerInput());

      const owen = plans.find((p) => p.accountNumber === 'WH-OWEN-TRAD')!;
      const nora = plans.find((p) => p.accountNumber === 'WH-NORA-TRAD')!;

      const owenFixedRatio = owen.postTradeHoldings.fixed / owen.accountValue;
      const noraFixedRatio = nora.postTradeHoldings.fixed / nora.accountValue;
      // Both Trads must converge to ≈26% bonds, within 5pp of each other.
      expect(Math.abs(owenFixedRatio - noraFixedRatio)).toBeLessThan(0.05);

      // Sample Trad's equity ratio must clear 60% — closes the canvas's
      // +72.5pp delta (today Owen sits at 0% equity).
      const owenEquityRatio = owen.postTradeHoldings.equity / owen.accountValue;
      expect(owenEquityRatio).toBeGreaterThanOrEqual(0.6);

      expect(validation.passed).toBe(true);
    });

    it('preserves aggregate household totals on the Whitaker shape (aggregate fidelity)', () => {
      const { plans } = runAssetLocationEngine(whitakerInput());
      const totals = sumHoldings(plans);
      expect(totals.cash).toBeCloseTo(922_000 * 0.005, 0);
      expect(totals.fixed).toBeCloseTo(922_000 * 0.265, 0);
      expect(totals.equity).toBeCloseTo(922_000 * 0.73, 0);
    });

    it('routes 100% to the peer with space when a same-type sibling is full (capacity edge)', () => {
      // TRAD-FULL holds its entire $200K balance; TRAD-EMPTY has balance 0
      // and therefore zero remaining space. The filter `spaceLeft(a) > 0`
      // excludes the empty peer in every priority round, so the single-peer
      // collapse applies and 100% of each class routes to TRAD-FULL.
      const { plans, validation } = runAssetLocationEngine(
        makeInput({
          totalValue: 200_000,
          baseAllocation: { equity: 60, fixed: 35, cash: 5 },
          accounts: [
            makeAccount({
              accountNumber: 'TRAD-FULL',
              accountType: 'Traditional IRA',
              balance: 200_000,
              holdings: { cash: 10_000, fixed: 70_000, equity: 120_000 },
            }),
            makeAccount({
              accountNumber: 'TRAD-EMPTY',
              accountType: 'Traditional IRA',
              balance: 0,
              holdings: { cash: 0, fixed: 0, equity: 0 },
            }),
          ],
        }),
      );

      const full = plans.find((p) => p.accountNumber === 'TRAD-FULL')!;
      const empty = plans.find((p) => p.accountNumber === 'TRAD-EMPTY')!;
      expect(empty.postTradeHoldings).toEqual({ cash: 0, fixed: 0, equity: 0 });
      expect(full.postTradeHoldings.cash).toBeCloseTo(10_000, 0);
      expect(full.postTradeHoldings.fixed).toBeCloseTo(70_000, 0);
      expect(full.postTradeHoldings.equity).toBeCloseTo(120_000, 0);
      expect(validation.passed).toBe(true);
    });

    it('splits proportionally across 2× Roth IRA (universality guard — spousal Roths)', () => {
      const { plans, validation } = runAssetLocationEngine(
        makeInput({
          totalValue: 400_000,
          baseAllocation: { equity: 80, fixed: 15, cash: 5 },
          accounts: [
            makeAccount({
              accountNumber: 'ROTH-A',
              accountType: 'Roth IRA',
              balance: 100_000,
              holdings: { cash: 0, fixed: 0, equity: 100_000 },
            }),
            makeAccount({
              accountNumber: 'ROTH-B',
              accountType: 'Roth IRA',
              balance: 300_000,
              holdings: { cash: 0, fixed: 0, equity: 300_000 },
            }),
          ],
        }),
      );

      const a = plans.find((p) => p.accountNumber === 'ROTH-A')!;
      const b = plans.find((p) => p.accountNumber === 'ROTH-B')!;
      const equityDelta = Math.abs(
        a.postTradeHoldings.equity / a.accountValue - b.postTradeHoldings.equity / b.accountValue,
      );
      expect(equityDelta).toBeLessThan(0.02);
      expect(validation.passed).toBe(true);
    });

    it('splits proportionally across 2× Joint accounts (universality guard)', () => {
      const { plans, validation } = runAssetLocationEngine(
        makeInput({
          totalValue: 400_000,
          baseAllocation: { equity: 60, fixed: 35, cash: 5 },
          accounts: [
            makeAccount({
              accountNumber: 'JNT-A',
              accountType: 'Joint',
              balance: 100_000,
              holdings: { cash: 5_000, fixed: 35_000, equity: 60_000 },
            }),
            makeAccount({
              accountNumber: 'JNT-B',
              accountType: 'Joint',
              balance: 300_000,
              holdings: { cash: 15_000, fixed: 105_000, equity: 180_000 },
            }),
          ],
        }),
      );

      const a = plans.find((p) => p.accountNumber === 'JNT-A')!;
      const b = plans.find((p) => p.accountNumber === 'JNT-B')!;
      const fixedDelta = Math.abs(
        a.postTradeHoldings.fixed / a.accountValue - b.postTradeHoldings.fixed / b.accountValue,
      );
      const equityDelta = Math.abs(
        a.postTradeHoldings.equity / a.accountValue - b.postTradeHoldings.equity / b.accountValue,
      );
      expect(fixedDelta).toBeLessThan(0.02);
      expect(equityDelta).toBeLessThan(0.02);
      expect(validation.passed).toBe(true);
    });

    it('splits proportionally across 3× Traditional IRA (n>2 sanity check)', () => {
      const { plans, validation } = runAssetLocationEngine(
        makeInput({
          totalValue: 1_000_000,
          baseAllocation: { equity: 70, fixed: 25, cash: 5 },
          accounts: [
            makeAccount({
              accountNumber: 'TRAD-100',
              accountType: 'Traditional IRA',
              balance: 100_000,
              holdings: { cash: 0, fixed: 0, equity: 100_000 },
            }),
            makeAccount({
              accountNumber: 'TRAD-300',
              accountType: 'Traditional IRA',
              balance: 300_000,
              holdings: { cash: 0, fixed: 0, equity: 300_000 },
            }),
            makeAccount({
              accountNumber: 'TRAD-600',
              accountType: 'Traditional IRA',
              balance: 600_000,
              holdings: { cash: 0, fixed: 0, equity: 600_000 },
            }),
          ],
        }),
      );

      const ratios = plans.map((p) => p.postTradeHoldings.fixed / p.accountValue);
      const minRatio = Math.min(...ratios);
      const maxRatio = Math.max(...ratios);
      // All three Trads should converge to ~25% fixed (the household base
      // allocation); the spread vs concentrate difference is dramatic for n=3.
      expect(maxRatio - minRatio).toBeLessThan(0.02);
      expect(validation.passed).toBe(true);
    });

    it('leaves the deposit-only short-circuit untouched (allocateToAccounts is never invoked)', () => {
      // Cash Deposit + rebalanceAll: false hits the allocateDepositOnly path
      // at runAssetLocationEngine. Non-deposit accounts must surface
      // postTradeHoldings deep-equal to their input holdings — no fill from
      // the modified allocateToAccounts.
      const inputHoldings = { cash: 2_100, fixed: 147_000, equity: 270_900 };
      const { plans } = runAssetLocationEngine(
        makeInput({
          tradeType: 'Cash Deposit',
          tradeAmount: '$50,000',
          depositAccountNumber: 'ACCT-1',
          rebalanceAll: false,
          accounts: [
            makeAccount({
              accountNumber: 'ACCT-1',
              accountType: 'Taxable',
              balance: 850_000,
              holdings: { cash: 42_500, fixed: 127_500, equity: 680_000 },
            }),
            makeAccount({
              accountNumber: 'ACCT-2',
              accountType: 'Traditional IRA',
              balance: 420_000,
              holdings: inputHoldings,
            }),
          ],
        }),
      );

      const nonDeposit = plans.find((p) => p.accountNumber === 'ACCT-2')!;
      expect(nonDeposit.postTradeHoldings).toEqual(inputHoldings);
      expect(nonDeposit.trades).toHaveLength(0);
    });
  });

  // ── Household-aware location: fund the selected account(s) to the
  // tax-ideal across the whole household, with already-invested siblings held
  // as fixed context and surfaced as recommendations. ──
  describe('household-aware (fixed context)', () => {
    // Household target 54/37/9 (E/F/C), risk 14. Fund a $100k taxable
    // account; siblings ($900k) are already invested but currently ALL equity
    // (off-model — no fixed located in the IRA yet).
    const HH_TARGET = getRiskAllocation(14); // 54/37/9 (E/F/C)
    function householdInput(overrides: Partial<EngineInput> = {}): EngineInput {
      return makeInput({
        baseAllocation: HH_TARGET,
        totalValue: 100_000, // engine recomputes from accounts; this is selected-only
        accounts: [
          makeAccount({
            accountNumber: 'FUND',
            accountType: 'Taxable',
            balance: 100_000,
            holdings: { cash: 100_000, fixed: 0, equity: 0 },
          }),
        ],
        fixedContextAccounts: [
          makeAccount({
            accountNumber: 'IRA',
            accountType: 'Traditional IRA',
            balance: 400_000,
            holdings: { cash: 0, fixed: 0, equity: 400_000 },
          }),
          makeAccount({
            accountNumber: 'ROTH',
            accountType: 'Roth IRA',
            balance: 200_000,
            holdings: { cash: 0, fixed: 0, equity: 200_000 },
          }),
          makeAccount({
            accountNumber: 'TAXBIG',
            accountType: 'Taxable',
            balance: 300_000,
            holdings: { cash: 0, fixed: 0, equity: 300_000 },
          }),
        ],
        ...overrides,
      });
    }

    it('returns a plan per household account, tagged execute (selected) vs recommend (context)', () => {
      const { plans } = runAssetLocationEngine(householdInput());
      expect(plans).toHaveLength(4);
      const byNum = Object.fromEntries(plans.map((p) => [p.accountNumber, p]));
      expect(byNum['FUND'].action).toBe('execute');
      expect(byNum['IRA'].action).toBe('recommend');
      expect(byNum['ROTH'].action).toBe('recommend');
      expect(byNum['TAXBIG'].action).toBe('recommend');
    });

    it('locates fixed income into the Traditional IRA and fills the funded account with equity', () => {
      const { plans } = runAssetLocationEngine(householdInput());
      const byNum = Object.fromEntries(plans.map((p) => [p.accountNumber, p]));
      // Household fixed (1,000,000 × 37% = 370k) lands in the IRA, not the taxable accounts.
      expect(byNum['IRA'].postTradeHoldings.fixed).toBeCloseTo(370_000, 0);
      // The funded taxable account holds no fixed — it fills with equity (the household's residual).
      expect(byNum['FUND'].postTradeHoldings.fixed).toBeCloseTo(0, 0);
      expect(byNum['FUND'].postTradeHoldings.equity).toBeGreaterThan(byNum['FUND'].postTradeHoldings.cash);
    });

    it('computes the ideal across the whole household total (selected + context)', () => {
      const { plans } = runAssetLocationEngine(householdInput());
      const totals = sumHoldings(plans);
      const grandTotal = 1_000_000; // 100k funded + 900k context
      expect(totals.cash).toBeCloseTo(grandTotal * (HH_TARGET.cash / 100), 0);
      expect(totals.fixed).toBeCloseTo(grandTotal * (HH_TARGET.fixed / 100), 0);
      expect(totals.equity).toBeCloseTo(grandTotal * (HH_TARGET.equity / 100), 0);
    });

    it('warns that executing only the funded account leaves the household off target', () => {
      const { validation } = runAssetLocationEngine(householdInput());
      const offTarget = validation.issues.filter((i) => i.kind === 'household_off_target_without_recommend');
      // Siblings are all-equity today; funding one $100k account cannot supply the
      // household's $370k fixed — so the fixed sleeve is flagged.
      expect(offTarget.some((i) => i.sleeve === 'fixed')).toBe(true);
      expect(validation.passed).toBe(false);
    });

    it('with no fixed context, behaves exactly as a selected-only run (regression guard)', () => {
      const { plans, validation } = runAssetLocationEngine(makeInput());
      expect(plans.every((p) => p.action === 'execute')).toBe(true);
      expect(validation.issues.some((i) => i.kind === 'household_off_target_without_recommend')).toBe(false);
    });
  });
});
