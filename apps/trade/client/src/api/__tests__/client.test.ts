import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CreateTradeRequestPayload, UpdateStatusPayload } from '@trade-request/shared';

const mockInstance = {
  get: vi.fn(),
  head: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  },
};

const mockAuthInstance = {
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  interceptors: {
    request: { use: vi.fn() },
    response: { use: vi.fn() },
  },
};

let createCallCount = 0;
vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => {
      createCallCount++;
      return createCallCount <= 1 ? mockInstance : mockAuthInstance;
    }),
    get: vi.fn(),
    post: vi.fn(),
    isAxiosError: vi.fn((err: unknown) => err instanceof Error && 'response' in err),
  },
}));

const MOCK_TRADE_REQUEST = {
  id: 'REQ-123',
  clientId: 'c1',
  clientName: 'Test',
  clientIds: ['c1'],
  clientNames: ['Test'],
  advisor: 'Rachel',
  submittedBy: 'Rachel',
  tradeType: 'Initial Funding' as const,
  tradeAmount: '',
  depositAccount: '',
  rebalanceAll: true,
  status: 'Pending Review' as const,
  date: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  selectedAccounts: ['A1'],
  totalValue: 100000,
  priority: 'Standard' as const,
  advisorNotes: '',
  residence: 'Other' as const,
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
  riskProfile: null,
  baseAllocation: { equity: 0, fixed: 0, cash: 0 },
  equityStrategies: [],
  raiseCashReason: '',
  liquidityDeadline: null,
  liquidateOption: '',
  liquidatePositions: '',
  executionPlan: [],
  accountMetadata: null,
  auditLog: [],
};

const MOCK_AUTH_USER = {
  id: '1',
  name: 'Test',
  email: 'test@test.com',
  googleId: null,
  picture: null,
  role: 'advisor' as const,
  slackUserId: null,
  themePreference: 'system' as const,
  isActive: true,
  lastLogin: null,
  createdAt: '2025-01-01T00:00:00.000Z',
};

beforeEach(async () => {
  vi.clearAllMocks();
  createCallCount = 0;
  const { invalidateUsersCache } = await import('../client');
  invalidateUsersCache();
});

describe('API client', () => {
  it('fetchClients calls GET /clients', async () => {
    const mockClients = [{ id: 'c1', name: 'Test', accounts: [] }];
    mockInstance.get.mockResolvedValue({ data: { data: mockClients } });

    const { fetchClients } = await import('../client');
    const result = await fetchClients();

    expect(mockInstance.get).toHaveBeenCalledWith('/clients', { signal: undefined });
    expect(result).toEqual(mockClients);
  });

  it('fetchBulkAccountExclusions calls POST /clients/account-exclusions/bulk', async () => {
    mockInstance.post.mockResolvedValue({
      data: {
        data: {
          'acc-1': [
            {
              id: 'ax-1',
              accountId: 'acc-1',
              ticker: 'TSLA',
              kind: 'client',
              reason: 'Employer stock',
              noBuy: true,
              noSell: false,
              createdByName: 'Ops',
              createdAt: '2026-05-26T00:00:00.000Z',
            },
          ],
          'acc-2': [],
        },
      },
    });

    const { fetchBulkAccountExclusions } = await import('../client');
    const result = await fetchBulkAccountExclusions(['acc-1', 'acc-2']);

    expect(mockInstance.post).toHaveBeenCalledWith('/clients/account-exclusions/bulk', {
      accountIds: ['acc-1', 'acc-2'],
    });
    expect(result['acc-1'][0]).toMatchObject({ accountId: 'acc-1', ticker: 'TSLA', noBuy: true, noSell: false });
    expect(result['acc-2']).toEqual([]);
  });

  it('fetchAccountExclusions fetches a single account list via bulk endpoint', async () => {
    mockInstance.post.mockResolvedValue({
      data: {
        data: {
          'acc-1': [
            {
              id: 'ax-1',
              accountId: 'acc-1',
              ticker: 'XOM',
              kind: 'advisor',
              reason: 'Imported',
              noBuy: true,
              noSell: true,
              createdByName: 'Ops',
              createdAt: '2026-05-26T00:00:00.000Z',
            },
          ],
        },
      },
    });

    const { fetchAccountExclusions } = await import('../client');
    const result = await fetchAccountExclusions('acc-1');

    expect(mockInstance.post).toHaveBeenCalledWith(
      '/clients/account-exclusions/bulk',
      { accountIds: ['acc-1'] },
      { signal: undefined },
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ accountId: 'acc-1', ticker: 'XOM' });
  });

  it('applyAccountExclusionsBatch calls POST /clients/account-exclusions/:accountId/batch', async () => {
    mockInstance.post.mockResolvedValue({
      data: {
        data: {
          exclusions: [
            {
              id: 'ax-1',
              accountId: 'acc-1',
              ticker: 'TSLA',
              kind: 'client',
              reason: 'Employer stock',
              noBuy: true,
              noSell: false,
              createdByName: 'Ops',
              createdAt: '2026-05-26T00:00:00.000Z',
            },
          ],
          added: 1,
          removed: 0,
          edited: 0,
        },
      },
    });

    const { applyAccountExclusionsBatch } = await import('../client');
    const payload = {
      add: [{ ticker: 'TSLA', kind: 'client' as const, reason: 'Employer stock', noBuy: true, noSell: false }],
      remove: [],
      edit: [],
    };
    const result = await applyAccountExclusionsBatch('acc-1', payload);

    expect(mockInstance.post).toHaveBeenCalledWith('/clients/account-exclusions/acc-1/batch', payload);
    expect(result).toMatchObject({ added: 1, removed: 0, edited: 0 });
    expect(result.exclusions[0]).toMatchObject({ accountId: 'acc-1', ticker: 'TSLA' });
  });

  it('fetchCurrentUser calls GET /me on auth instance', async () => {
    mockAuthInstance.get.mockResolvedValue({ data: MOCK_AUTH_USER });

    const { fetchCurrentUser } = await import('../client');
    const result = await fetchCurrentUser();

    expect(mockAuthInstance.get).toHaveBeenCalledWith('/me');
    expect(result).toEqual(MOCK_AUTH_USER);
  });

  it('createRequest calls POST /requests', async () => {
    mockInstance.post.mockResolvedValue({ data: { data: MOCK_TRADE_REQUEST } });

    const { createRequest } = await import('../client');
    const payload = { clientId: 'c1' } as CreateTradeRequestPayload;
    const result = await createRequest(payload);

    // The per-call timeout override matters: at the 30s default the browser
    // abandoned creates the server went on to commit, and the advisor's retry
    // produced a duplicate trade request.
    expect(mockInstance.post).toHaveBeenCalledWith('/requests', payload, { timeout: 120_000 });
    expect(result).toEqual(MOCK_TRADE_REQUEST);
  });

  it('fetchRequests calls GET /requests with cursor param', async () => {
    mockInstance.get.mockResolvedValue({
      data: { data: [MOCK_TRADE_REQUEST], nextCursor: 'next-page' },
    });

    const { fetchRequests } = await import('../client');
    const result = await fetchRequests('cursor-token');

    expect(mockInstance.get).toHaveBeenCalledWith('/requests?before=cursor-token', {
      signal: undefined,
    });
    expect(result).toEqual({
      data: [MOCK_TRADE_REQUEST],
      nextCursor: 'next-page',
    });
  });

  it('fetchRequest calls GET /requests/:id', async () => {
    mockInstance.get.mockResolvedValue({ data: { data: MOCK_TRADE_REQUEST } });

    const { fetchRequest } = await import('../client');
    const result = await fetchRequest('REQ-123');

    expect(mockInstance.get).toHaveBeenCalledWith('/requests/REQ-123');
    expect(result).toEqual(MOCK_TRADE_REQUEST);
  });

  it('updateRequestStatus calls PUT /requests/:id/status', async () => {
    mockInstance.put.mockResolvedValue({ data: { data: MOCK_TRADE_REQUEST } });

    const { updateRequestStatus } = await import('../client');
    const payload: UpdateStatusPayload = {
      status: 'Approved',
      note: 'ok',
    };
    const result = await updateRequestStatus('REQ-123', payload);

    expect(mockInstance.put).toHaveBeenCalledWith('/requests/REQ-123/status', payload);
    expect(result).toEqual(MOCK_TRADE_REQUEST);
  });

  it('fetchUsers returns cached data on second call within TTL', async () => {
    mockInstance.get.mockResolvedValue({ data: { data: [MOCK_AUTH_USER] } });

    const { fetchUsers } = await import('../client');
    const first = await fetchUsers();
    const second = await fetchUsers();

    expect(first).toEqual([MOCK_AUTH_USER]);
    expect(second).toEqual([MOCK_AUTH_USER]);
    expect(mockInstance.get).toHaveBeenCalledTimes(1);
    expect(mockInstance.get).toHaveBeenCalledWith('/users');
  });

  it('invalidateUsersCache clears cache so next call fetches fresh', async () => {
    mockInstance.get.mockResolvedValue({ data: { data: [MOCK_AUTH_USER] } });

    const { fetchUsers, invalidateUsersCache } = await import('../client');
    await fetchUsers();
    invalidateUsersCache();
    await fetchUsers();

    expect(mockInstance.get).toHaveBeenCalledTimes(2);
    expect(mockInstance.get).toHaveBeenCalledWith('/users');
  });

  it('inviteUser calls POST /users/invite', async () => {
    mockInstance.post.mockResolvedValue({ data: MOCK_AUTH_USER });

    const { inviteUser } = await import('../client');
    const payload = { email: 'new@test.com', name: 'New', role: 'trader' as const };
    const result = await inviteUser(payload);

    expect(mockInstance.post).toHaveBeenCalledWith('/users/invite', payload);
    expect(result).toEqual(MOCK_AUTH_USER);
  });

  it('extractApiError returns server message from axios error', async () => {
    const { extractApiError } = await import('../client');
    const err = new Error('request failed');
    (err as Error & { response: { data: { error: string } } }).response = {
      data: { error: 'Server rejected' },
    };

    expect(extractApiError(err)).toBe('Server rejected');
  });

  it('extractApiError returns fallback for non-axios errors', async () => {
    const { extractApiError } = await import('../client');

    expect(extractApiError(null)).toBe('An unexpected error occurred');
  });

  it('extractApiError appends validation details so users see which field failed', async () => {
    const { extractApiError } = await import('../client');
    const err = new Error('request failed') as Error & {
      response: { data: { error: string; details: Array<{ path: unknown[]; message: string }> } };
    };
    err.response = {
      data: {
        error: 'Validation failed',
        details: [
          { path: ['equityStrategies', 0, 'rationale'], message: 'Each equity strategy must have a rationale' },
          { path: ['selectedAccounts'], message: 'Array must contain at most 50 element(s)' },
        ],
      },
    };

    expect(extractApiError(err)).toBe(
      'Validation failed: equityStrategies.0.rationale: Each equity strategy must have a rationale; selectedAccounts: Array must contain at most 50 element(s)',
    );
  });

  it('extractApiError caps surfaced validation details at 3 entries to avoid noise', async () => {
    const { extractApiError } = await import('../client');
    const err = new Error('request failed') as Error & {
      response: { data: { error: string; details: Array<{ path: unknown[]; message: string }> } };
    };
    err.response = {
      data: {
        error: 'Validation failed',
        details: [
          { path: ['a'], message: 'm1' },
          { path: ['b'], message: 'm2' },
          { path: ['c'], message: 'm3' },
          { path: ['d'], message: 'm4' },
          { path: ['e'], message: 'm5' },
        ],
      },
    };

    const result = extractApiError(err);
    expect(result).toContain('a: m1');
    expect(result).toContain('b: m2');
    expect(result).toContain('c: m3');
    expect(result).not.toContain('m4');
    expect(result).not.toContain('m5');
  });

  it('extractApiError falls back to server message when details are missing or malformed', async () => {
    const { extractApiError } = await import('../client');
    const err = new Error('request failed') as Error & {
      response: { data: { error: string; details: unknown } };
    };
    err.response = { data: { error: 'Validation failed', details: 'oops' } };

    expect(extractApiError(err)).toBe('Validation failed');
  });

  it('fetchDriftHistory calls GET /drift/history with the days param and validates the response', async () => {
    mockInstance.get.mockResolvedValue({
      data: {
        days: 7,
        runs: [
          {
            runDateLocal: '2026-05-12',
            householdName: 'Doe Family',
            maxDeltaPct: 0.045,
            breach: false,
            coverageStatus: 'full',
            schemaVersion: 1,
            snapshotSource: 'gcs',
            snapshotAsOf: '2026-05-12T03:00:00.000Z',
          },
        ],
      },
    });

    const { fetchDriftHistory } = await import('../client');
    const result = await fetchDriftHistory(7);

    expect(mockInstance.get).toHaveBeenCalledWith('/drift/history?days=7');
    expect(result.days).toBe(7);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].coverageStatus).toBe('full');
  });

  it('fetchDriftHistory throws on a malformed response (zod parse failure)', async () => {
    mockInstance.get.mockResolvedValue({ data: { days: 30, runs: [{ householdName: 'Doe' }] } });

    const { fetchDriftHistory } = await import('../client');
    await expect(fetchDriftHistory()).rejects.toThrow();
  });

  it('fetchDriftAllowList calls GET /drift/allow-list and validates the response', async () => {
    mockInstance.get.mockResolvedValue({
      data: {
        entries: [
          {
            householdName: 'Whitaker Family',
            reason: 'awaiting_within_type_spread',
            unblocksWhenPlanShips: 'docs/plans/foo.md',
            notes: 'known divergence',
          },
        ],
      },
    });

    const { fetchDriftAllowList } = await import('../client');
    const result = await fetchDriftAllowList();

    expect(mockInstance.get).toHaveBeenCalledWith('/drift/allow-list');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].householdName).toBe('Whitaker Family');
  });

  it('fetchDriftRunDetail URL-encodes both path params and validates the response', async () => {
    mockInstance.get.mockResolvedValue({
      data: {
        run: {
          runDateLocal: '2026-05-12',
          runStartedAt: '2026-05-12T07:00:00.000Z',
          householdName: 'Whitaker Family',
          accountCount: 4,
          maxDeltaPct: 0.0741,
          breach: true,
          coverageStatus: 'full',
          schemaVersion: 1,
          snapshotSource: 'gcs',
          snapshotAsOf: '2026-05-12T03:00:00.000Z',
          details: { worstSymbol: 'VTI', accounts: [], accountCount: 4 },
        },
      },
    });

    const { fetchDriftRunDetail } = await import('../client');
    const result = await fetchDriftRunDetail('2026-05-12', 'Whitaker Family');

    expect(mockInstance.get).toHaveBeenCalledWith('/drift/runs/2026-05-12/Whitaker%20Family');
    expect(result.run.householdName).toBe('Whitaker Family');
    expect(result.run.accountCount).toBe(4);
  });

  it('fetchDriftRunDetail accepts logically empty details ({}) without throwing (passthrough validator)', async () => {
    mockInstance.get.mockResolvedValue({
      data: {
        run: {
          runDateLocal: '2026-05-12',
          runStartedAt: '2026-05-12T07:00:00.000Z',
          householdName: 'Doe Family',
          accountCount: 0,
          maxDeltaPct: 0,
          breach: false,
          coverageStatus: 'full',
          schemaVersion: 1,
          snapshotSource: 'gcs',
          snapshotAsOf: null,
          details: {},
        },
      },
    });

    const { fetchDriftRunDetail } = await import('../client');
    const result = await fetchDriftRunDetail('2026-05-12', 'Doe Family');
    expect(result.run.details).toEqual({});
  });

  it('fetchAccountDriftHistory parses the data-quality lane statuses (negligible / template_invalid)', async () => {
    // Regression: the response schema must accept the R1/R2 statuses or
    // .parse() throws and the whole Drift tab errors out. Component tests mock
    // the client and bypass this parse, so guard it here at the schema layer.
    mockInstance.get.mockResolvedValue({
      data: {
        days: 30,
        runs: [
          {
            runDateLocal: '2026-06-09',
            accountId: '01NEG0000000000000000000BB',
            accountTitle: 'Dust Acct',
            householdName: 'HH',
            status: 'negligible',
            worstBucket: null,
            maxBucketDeltaPct: null,
            symbolBreachCount: 0,
            totalValueUsd: 0.29,
            coverage: 'both',
            snapshotSource: 's3',
            snapshotAsOf: '2026-06-01T00:00:00.000Z',
            schemaVersion: 1,
          },
          {
            runDateLocal: '2026-06-09',
            accountId: '01TPL0000000000000000000CC',
            accountTitle: 'Bad Template Acct',
            householdName: 'HH',
            status: 'template_invalid',
            worstBucket: 'equity',
            maxBucketDeltaPct: 60.49,
            symbolBreachCount: 2,
            totalValueUsd: 117000,
            coverage: 'both',
            snapshotSource: 's3',
            snapshotAsOf: '2026-06-01T00:00:00.000Z',
            schemaVersion: 1,
            templateTotalPct: 72,
          },
        ],
      },
    });

    const { fetchAccountDriftHistory } = await import('../client');
    const result = await fetchAccountDriftHistory();

    expect(mockInstance.get).toHaveBeenCalledWith('/drift/v2/history?days=30');
    expect(result.runs.map((r) => r.status)).toEqual(['negligible', 'template_invalid']);
    expect(result.runs[1].templateTotalPct).toBe(72);
  });

  it('fetchAccountDriftHistory parses the optional override field on a row', async () => {
    mockInstance.get.mockResolvedValue({
      data: {
        days: 30,
        runs: [
          {
            runDateLocal: '2026-06-09',
            accountId: '01OVR0000000000000000000AA',
            accountTitle: 'Overridden Acct',
            householdName: 'HH',
            status: 'out',
            worstBucket: 'equity',
            maxBucketDeltaPct: 12,
            symbolBreachCount: 1,
            totalValueUsd: 500000,
            coverage: 'both',
            snapshotSource: 's3',
            snapshotAsOf: '2026-06-01T00:00:00.000Z',
            schemaVersion: 1,
            override: {
              reason: 'tax_constraint',
              note: 'big gains',
              expiresOn: null,
              setByName: 'Jeremy Hamann',
              setAt: '2026-06-22T00:00:00.000Z',
            },
          },
        ],
      },
    });
    const { fetchAccountDriftHistory } = await import('../client');
    const result = await fetchAccountDriftHistory();
    expect(result.runs[0].override?.reason).toBe('tax_constraint');
    expect(result.runs[0].override?.setByName).toBe('Jeremy Hamann');
  });

  it('setDriftOverride PUTs to the per-account endpoint and parses the response', async () => {
    mockInstance.put.mockResolvedValue({
      data: {
        accountId: '01OVR0000000000000000000AA',
        override: {
          reason: 'active_transition',
          note: 'mid transfer-in',
          expiresOn: '2026-07-15',
          setByName: 'Jeremy Hamann',
          setAt: '2026-06-22T00:00:00.000Z',
        },
      },
    });
    const { setDriftOverride } = await import('../client');
    const result = await setDriftOverride('01OVR0000000000000000000AA', {
      reason: 'active_transition',
      note: 'mid transfer-in',
      expiresOn: '2026-07-15',
    });
    expect(mockInstance.put).toHaveBeenCalledWith('/drift/v2/overrides/01OVR0000000000000000000AA', {
      reason: 'active_transition',
      note: 'mid transfer-in',
      expiresOn: '2026-07-15',
    });
    expect(result.override.reason).toBe('active_transition');
    expect(result.override.expiresOn).toBe('2026-07-15');
  });

  it('clearDriftOverride DELETEs the per-account endpoint', async () => {
    mockInstance.delete.mockResolvedValue({ data: { accountId: '01OVR0000000000000000000AA', cleared: true } });
    const { clearDriftOverride } = await import('../client');
    await clearDriftOverride('01OVR0000000000000000000AA');
    expect(mockInstance.delete).toHaveBeenCalledWith('/drift/v2/overrides/01OVR0000000000000000000AA');
  });

  it('fetchRequestChecklist GETs the checklist endpoint and parses the state', async () => {
    mockInstance.get.mockResolvedValue({
      data: {
        checklist: { transition: { checked: true, value: 'Risk 20', by: 'Jeremy', at: '2026-06-23T00:00:00Z' } },
      },
    });
    const { fetchRequestChecklist } = await import('../client');
    const result = await fetchRequestChecklist('REQ-1');
    expect(mockInstance.get).toHaveBeenCalledWith('/requests/REQ-1/checklist');
    expect(result.transition?.checked).toBe(true);
    expect(result.transition?.value).toBe('Risk 20');
  });

  it('updateRequestChecklistItem PUTs a single item and returns the updated checklist', async () => {
    mockInstance.put.mockResolvedValue({ data: { checklist: { templates: { checked: true } } } });
    const { updateRequestChecklistItem } = await import('../client');
    const result = await updateRequestChecklistItem('REQ-1', { key: 'templates', checked: true });
    expect(mockInstance.put).toHaveBeenCalledWith('/requests/REQ-1/checklist', { key: 'templates', checked: true });
    expect(result.templates?.checked).toBe(true);
  });

  it('fetchAccountDriftExclusionOverlapAvailability returns true when HEAD probe succeeds', async () => {
    mockInstance.head.mockResolvedValue({ status: 204 });

    const { fetchAccountDriftExclusionOverlapAvailability } = await import('../client');
    const result = await fetchAccountDriftExclusionOverlapAvailability();

    expect(result).toBe(true);
    expect(mockInstance.head).toHaveBeenCalledWith('/drift/v2/exclusion-overlap');
  });

  it('fetchAccountDriftExclusionOverlapAvailability returns false on 404', async () => {
    const err = new Error('not found') as Error & { response: { status: number } };
    err.response = { status: 404 };
    mockInstance.head.mockRejectedValue(err);

    const { fetchAccountDriftExclusionOverlapAvailability } = await import('../client');
    const result = await fetchAccountDriftExclusionOverlapAvailability();

    expect(result).toBe(false);
  });

  it('fetchAccountDriftExclusionOverlap calls the v2 endpoint with optional runDateLocal query', async () => {
    mockInstance.get.mockResolvedValue({
      data: {
        runDateLocal: '2026-05-22',
        totalAccounts: 2,
        outAccounts: 1,
        totalExclusions: 4,
        totalBreaches: 3,
        lockedTotal: 1,
        lockedSharePct: 33.3,
        counts: {
          actionable: 2,
          locked_blanket: 0,
          locked_dnb_under: 1,
          locked_dns_over: 0,
          sign_mismatch_unlocked: 0,
        },
        worstAccounts: [
          {
            accountId: 'ACCT001',
            accountTitle: 'Test Account',
            household: 'Whitaker Family',
            status: 'out',
            maxDelta: 27.39,
            breachCount: 2,
            lockedCount: 1,
          },
        ],
      },
    });

    const { fetchAccountDriftExclusionOverlap } = await import('../client');
    const result = await fetchAccountDriftExclusionOverlap('2026-05-22');

    expect(mockInstance.get).toHaveBeenCalledWith('/drift/v2/exclusion-overlap?runDateLocal=2026-05-22');
    expect(result.runDateLocal).toBe('2026-05-22');
    expect(result.lockedTotal).toBe(1);
  });

  it('logout calls POST /logout and clears caches', async () => {
    mockAuthInstance.post.mockResolvedValue(undefined);
    mockInstance.get.mockResolvedValue({ data: { data: [MOCK_AUTH_USER] } });

    const { fetchUsers, logout } = await import('../client');
    await fetchUsers();
    await fetchUsers();
    await logout();
    await fetchUsers();

    expect(mockAuthInstance.post).toHaveBeenCalledWith('/logout');
    expect(mockInstance.get).toHaveBeenCalledTimes(2);
    expect(mockInstance.get).toHaveBeenCalledWith('/users');
  });
});
