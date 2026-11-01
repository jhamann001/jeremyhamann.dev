import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientExclusion, TradeRequest } from '@trade-request/shared';
import { exportComplianceReport } from '../TradingQueue';

function makeRequest(): TradeRequest {
  return {
    id: 'REQ-CASH',
    clientId: 'client-1',
    clientName: 'Test Household',
    clientIds: ['client-1'],
    clientNames: ['Test Household'],
    advisor: 'Advisor',
    submittedBy: 'Sam Submitter',
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
    equityStrategies: [],
    raiseCashReason: '',
    liquidityDeadline: null,
    liquidateOption: '',
    liquidatePositions: '',
    accountMetadata: [],
    auditLog: [],
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
            sleeve: 'fixed',
            current: 58_883,
            target: 86_645,
            delta: 27_762,
            source: 'mixed',
            rationale: 'Fixed income target after deposit.',
          },
        ],
        trades: [{ type: 'Buy', asset: 'URTH Strategy', amount: 121_510, rationale: 'Funded by deposit.' }],
        varianceAnalysis: {
          preTrade: { cash: 2_260, fixed: 58_883, equity: 386_410 },
          postTrade: { cash: 2_988, fixed: 86_645, equity: 507_920 },
        },
      },
    ],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('exportComplianceReport', () => {
  it('excludes engine execution-plan output from the CSV export but keeps core compliance fields', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    // Fixture has a full executionPlan, but the engine output must no longer be
    // surfaced in the compliance export (UI-side removal; data still persisted server-side).
    await exportComplianceReport([makeRequest()], { name: 'Trader', email: 'trader@example.com' });

    const blob = createObjectUrl.mock.calls[0][0] as Blob;
    const csv = await blob.text();
    // Engine-output columns and values are gone.
    expect(csv).not.toContain('Execution Summary');
    expect(csv).not.toContain('Cash Deposit Context');
    expect(csv).not.toContain('Sleeve Summary');
    expect(csv).not.toContain('Execution Rationale');
    expect(csv).not.toContain('Existing Cash/MMF');
    expect(csv).not.toContain('fixed: $58,883 -> $86,645');
    // Core compliance fields remain.
    expect(csv).toContain('Submitted By');
    expect(csv).toContain('Sam Submitter');
    expect(csv).toContain('Audit Hash');
  });

  it('renders standing exclusions with the v3.4 DNB/DNS side prefix in CSV', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const standing: Record<string, ClientExclusion[]> = {
      'client-1': [
        {
          id: 'ex-1',
          clientId: 'client-1',
          ticker: 'TSLA',
          kind: 'advisor',
          reason: 'Concentration risk',
          noBuy: true,
          noSell: false,
          createdByName: 'Rachel',
          createdAt: '2026-05-01T00:00:00.000Z',
        },
        {
          id: 'ex-2',
          clientId: 'client-1',
          ticker: 'AAPL',
          kind: 'client',
          reason: 'Employer',
          noBuy: true,
          noSell: true,
          createdByName: 'Rachel',
          createdAt: '2026-05-02T00:00:00.000Z',
        },
        {
          id: 'ex-3',
          clientId: 'client-1',
          ticker: 'F',
          kind: 'client',
          reason: '',
          noBuy: false,
          noSell: true,
          createdByName: 'Rachel',
          createdAt: '2026-05-03T00:00:00.000Z',
        },
      ],
    };

    await exportComplianceReport([makeRequest()], { name: 'Trader', email: 'trader@example.com' }, standing);

    const blob = createObjectUrl.mock.calls[0][0] as Blob;
    const csv = await blob.text();
    expect(csv).toContain('TSLA (DNB - Concentration risk)');
    expect(csv).toContain('AAPL (DNB+DNS - Employer)');
    expect(csv).toContain('F (DNS)');
  });

  it('renders account-level standing exclusions in CSV', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await exportComplianceReport(
      [makeRequest()],
      { name: 'Trader', email: 'trader@example.com' },
      {},
      {
        'REQ-CASH': [
          {
            accountNumber: 'ZZ10001',
            kind: 'advisor',
            ticker: 'VTI',
            reason: 'Tax lot lock',
            noBuy: false,
            noSell: true,
          },
          {
            accountNumber: 'ZZ10001',
            kind: 'client',
            ticker: 'XOM',
            reason: 'Employer stock',
            noBuy: true,
            noSell: false,
          },
        ],
      },
    );

    const blob = createObjectUrl.mock.calls[0][0] as Blob;
    const csv = await blob.text();
    expect(csv).toContain('Standing Account Advisor Exclusions (current)');
    expect(csv).toContain('Standing Account Client Exclusions (current)');
    expect(csv).toContain('ZZ10001: VTI (DNS - Tax lot lock)');
    expect(csv).toContain('ZZ10001: XOM (DNB - Employer stock)');
  });
});
