import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Holdings, HouseholdSiblingHolding, TradeRequest } from '@trade-request/shared';
import { ExecutionPlanView, TraderHoldingsInput } from '../ExecutionPlan';

function makeSibling(overrides: Partial<HouseholdSiblingHolding> = {}): HouseholdSiblingHolding {
  return {
    accountId: '01SYNTH3ZDVSZCA9ZAK4Q2RS5B',
    accountNumber: 'ACCT-SIB',
    accountTitle: 'Roth IRA',
    accountType: 'Roth IRA',
    balance: 250_000,
    status: 'in',
    positionCashPct: 5,
    positionFixedPct: 27,
    positionEquityPct: 68,
    templateCashPct: 2,
    templateFixedPct: 30,
    templateEquityPct: 60,
    maxBucketDeltaPct: 8,
    worstBucket: 'equity',
    hasDrift: true,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<TradeRequest> = {}): TradeRequest {
  return {
    id: 'REQ-CASH',
    clientId: 'client-1',
    clientName: 'Test Household',
    clientIds: ['client-1'],
    clientNames: ['Test Household'],
    advisor: 'Advisor',
    submittedBy: 'Advisor',
    tradeType: 'Cash Deposit',
    tradeAmount: '$150,000',
    depositAccount: 'ZZ10001',
    rebalanceAll: true,
    status: 'Pending Review',
    date: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    selectedAccounts: ['ZZ10001'],
    totalValue: 447_552.93,
    priority: 'Standard',
    advisorNotes: '',
    residence: 'NY',
    liquidationApproval: '',
    advisorExclusions: '',
    clientExclusions: '',
    esgFilters: {
      fossilFuels: false,
      tobacco: false,
      weapons: false,
      alcohol: false,
      gambling: false,
      other: false,
      otherDescription: '',
      none: true,
    },
    riskProfile: 20,
    baseAllocation: { cash: 0.5, fixed: 14.5, equity: 85 },
    equityStrategies: [{ id: 1, benchmark: 'URTH', allocation: 100, rationale: 'URTH model' }],
    raiseCashReason: '',
    liquidityDeadline: null,
    liquidateOption: '',
    liquidatePositions: '',
    accountMetadata: [],
    auditLog: [],
    executionPlan: [],
    ...overrides,
  };
}

describe('TraderHoldingsInput', () => {
  it('separates new USD deposit from editable cash/MMF holdings', () => {
    const holdings: Record<string, Holdings & { type: string }> = {
      ZZ10001: { cash: 2_260, fixed: 58_883, equity: 386_410, type: 'Joint' },
    };

    render(<TraderHoldingsInput request={makeRequest()} traderHoldings={holdings} onHoldingsChange={vi.fn()} />);

    expect(screen.getByText('Current Holdings Before Deposit')).toBeInTheDocument();
    expect(screen.getByText('Existing Cash/MMF ($)')).toBeInTheDocument();
    expect(screen.getAllByText('New USD Deposit').length).toBeGreaterThan(0);
    expect(screen.getByText('$150,000')).toBeInTheDocument();
    expect(screen.getByText('After Deposit')).toBeInTheDocument();
    expect(screen.getByText('$597,553')).toBeInTheDocument();
  });

  it('hides the household disclosure when there are no sibling accounts', () => {
    const holdings: Record<string, Holdings & { type: string }> = {
      ZZ10001: { cash: 0, fixed: 0, equity: 100_000, type: 'Joint' },
    };
    render(
      <TraderHoldingsInput
        request={makeRequest({ tradeType: 'Rebalance' })}
        traderHoldings={holdings}
        onHoldingsChange={vi.fn()}
        householdSiblings={[]}
      />,
    );
    expect(screen.queryByText(/Other accounts in this household/)).not.toBeInTheDocument();
  });

  it('shows sibling current/target/drift when the household disclosure is expanded', () => {
    const holdings: Record<string, Holdings & { type: string }> = {
      ZZ10001: { cash: 0, fixed: 0, equity: 100_000, type: 'Joint' },
    };
    render(
      <TraderHoldingsInput
        request={makeRequest({ tradeType: 'Rebalance' })}
        traderHoldings={holdings}
        onHoldingsChange={vi.fn()}
        householdSiblings={[makeSibling()]}
        driftRunDate="2026-05-13"
      />,
    );

    const toggle = screen.getByRole('button', { name: /Other accounts in this household \(1\)/ });
    // Collapsed by default — the detail columns are not rendered yet.
    expect(screen.queryByText('Current (C/F/E)')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByText('Current (C/F/E)')).toBeInTheDocument();
    expect(screen.getByText('ACCT-SIB')).toBeInTheDocument();
    expect(screen.getByText('5% / 27% / 68%')).toBeInTheDocument();
    expect(screen.getByText('2% / 30% / 60%')).toBeInTheDocument();
    expect(screen.getByText('8.0% Equity')).toBeInTheDocument();
    expect(screen.getByText(/Current allocation as of 2026-05-13/)).toBeInTheDocument();
  });

  it('rolls siblings into a household total while keeping the selected subtotal separate', () => {
    const holdings: Record<string, Holdings & { type: string }> = {
      ZZ10001: { cash: 0, fixed: 0, equity: 100_000, type: 'Joint' },
    };
    render(
      <TraderHoldingsInput
        request={makeRequest({ tradeType: 'Rebalance' })}
        traderHoldings={holdings}
        onHoldingsChange={vi.fn()}
        householdSiblings={[makeSibling({ balance: 250_000 })]}
        driftRunDate="2026-05-13"
      />,
    );

    // Selected subtotal is relabeled (no longer the misleading "Household Total").
    expect(screen.getByText('Selected Accounts Total:')).toBeInTheDocument();
    // The real household total includes the sibling: 100,000 + 250,000 (2 accounts).
    expect(screen.getByText('Household Total (2 accounts):')).toBeInTheDocument();
    expect(screen.getByText('$350,000')).toBeInTheDocument();

    // Expanding reconciles: other-accounts subtotal equals the siblings' sum.
    // $250,000 appears twice — the single sibling's row total and the subtotal.
    fireEvent.click(screen.getByRole('button', { name: /Other accounts in this household/ }));
    expect(screen.getByText('Other accounts total:')).toBeInTheDocument();
    expect(screen.getAllByText('$250,000')).toHaveLength(2);
  });

  it('keeps the plain "Household Total" label when there are no siblings', () => {
    const holdings: Record<string, Holdings & { type: string }> = {
      ZZ10001: { cash: 0, fixed: 0, equity: 100_000, type: 'Joint' },
    };
    render(
      <TraderHoldingsInput
        request={makeRequest({ tradeType: 'Rebalance' })}
        traderHoldings={holdings}
        onHoldingsChange={vi.fn()}
        householdSiblings={[]}
      />,
    );
    expect(screen.getByText('Household Total:')).toBeInTheDocument();
    expect(screen.queryByText('Selected Accounts Total:')).not.toBeInTheDocument();
    expect(screen.queryByText(/Household Total \(/)).not.toBeInTheDocument();
  });

  it('renders an em-dash and "no model data" for a sibling with no drift row', () => {
    const holdings: Record<string, Holdings & { type: string }> = {
      ZZ10001: { cash: 0, fixed: 0, equity: 100_000, type: 'Joint' },
    };
    render(
      <TraderHoldingsInput
        request={makeRequest({ tradeType: 'Rebalance' })}
        traderHoldings={holdings}
        onHoldingsChange={vi.fn()}
        householdSiblings={[
          makeSibling({
            accountNumber: 'ACCT-NODRIFT',
            hasDrift: false,
            status: null,
            positionCashPct: null,
            positionFixedPct: null,
            positionEquityPct: null,
            templateCashPct: null,
            templateFixedPct: null,
            templateEquityPct: null,
            maxBucketDeltaPct: null,
            worstBucket: null,
          }),
        ]}
        driftRunDate={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Other accounts in this household/ }));
    expect(screen.getByText('no model data')).toBeInTheDocument();
    expect(screen.getByText('ACCT-NODRIFT')).toBeInTheDocument();
    expect(screen.getByText(/Drift snapshot unavailable/)).toBeInTheDocument();
  });
});

describe('ExecutionPlanView', () => {
  it('renders cash deposit context, sleeve instructions, and corrected trade rows', () => {
    const request = makeRequest({
      executionPlan: [
        {
          accountNumber: 'ZZ10001',
          accountType: 'Joint',
          accountValue: 597_552.93,
          templateName: 'Cash Deposit Test',
          modelName: 'New York',
          postTradeHoldings: { cash: 2_988, fixed: 86_645, equity: 507_920 },
          cashDepositContext: {
            depositAmount: 150_000,
            depositAccountNumber: 'ZZ10001',
            existingCash: 2_260,
            availableCash: 152_260,
            targetCash: 2_988,
            cashToDeploy: 149_272,
          },
          sleeveInstructions: [
            {
              sleeve: 'cash',
              current: 2_260,
              target: 2_988,
              delta: 728,
              source: 'mixed',
              rationale: 'Cash target after deposit.',
            },
            {
              sleeve: 'fixed',
              current: 58_883,
              target: 86_645,
              delta: 27_762,
              source: 'mixed',
              rationale: 'Fixed income target after deposit.',
            },
          ],
          trades: [
            {
              type: 'Buy',
              asset: 'URTH Strategy',
              amount: 121_510,
              rationale: 'Funded by the new USD deposit.',
            },
          ],
          varianceAnalysis: {
            preTrade: { cash: 2_260, fixed: 58_883, equity: 386_410 },
            postTrade: { cash: 2_988, fixed: 86_645, equity: 507_920 },
          },
        },
      ],
    });

    render(<ExecutionPlanView request={request} role="trader" computingId={null} onRunEngine={vi.fn()} />);

    expect(screen.getByText('Cash Deposit Context')).toBeInTheDocument();
    expect(screen.getByText('Existing Cash/MMF')).toBeInTheDocument();
    expect(screen.getByText('Cash To Deploy')).toBeInTheDocument();
    expect(screen.getByText('Sleeve Instructions')).toBeInTheDocument();
    expect(screen.getByText('URTH Strategy')).toBeInTheDocument();
    expect(screen.getByText('Before Deposit $')).toBeInTheDocument();
  });
});
