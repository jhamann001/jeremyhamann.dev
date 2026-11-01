import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockContacts = [
  { cedar_ridge_user_id__c: 'user-1', name: 'John Doe', crm__primary_entity_stage__c: 'Client' },
  { cedar_ridge_user_id__c: 'user-2', name: 'Jane Lead', crm__primary_entity_stage__c: 'Prospect' },
];

const mockInvestments = [
  {
    user_id: 'user-1',
    custodian_account_number: 'ACCT-001',
    custodian_account_id: 'apex-1',
    account_type: 'BROKERAGE',
  },
  { user_id: 'user-1', custodian_account_number: 'ACCT-002', custodian_account_id: 'apex-2', account_type: 'ROTH_IRA' },
];

const mockBalances = [
  { account_id: 'apex-1', total_equity: 100000, snapshot_timestamp: '2026-03-22T00:00:00Z' },
  { account_id: 'apex-1', total_equity: 105000, snapshot_timestamp: '2026-03-23T00:00:00Z' },
  { account_id: 'apex-2', total_equity: 50000, snapshot_timestamp: '2026-03-23T00:00:00Z' },
];

const mockStockRecord = [
  // apex-1: equity (AAPL) + fixed (VGSH) + cash (SWVXX) — latest date
  { account_id: 'apex-1', symbol: 'AAPL', trade_position_value: 60000, business_date: '2026-03-27' },
  { account_id: 'apex-1', symbol: 'VGSH', trade_position_value: 30000, business_date: '2026-03-27' },
  { account_id: 'apex-1', symbol: 'SWVXX', trade_position_value: 14000, business_date: '2026-03-27' },
  // apex-1: stale row from earlier date — should be ignored
  { account_id: 'apex-1', symbol: 'AAPL', trade_position_value: 55000, business_date: '2026-03-26' },
  // apex-2: equity (MSFT) + muni bond (VTEB)
  { account_id: 'apex-2', symbol: 'MSFT', trade_position_value: 35000, business_date: '2026-03-27' },
  { account_id: 'apex-2', symbol: 'VTEB', trade_position_value: 14000, business_date: '2026-03-27' },
];

const { warehouseEnv } = vi.hoisted(() => ({
  warehouseEnv: {
    url: 'https://warehouse.test',
    key: 'api-key',
    qContacts: 'q-contacts',
    qInvestments: 'q-investments',
    qBalances: 'q-balances',
    qStockRecord: 'q-stock-record',
  },
}));

function setWarehouseEnv(includeStockRecord = false): void {
  process.env.WAREHOUSE_URL = warehouseEnv.url;
  process.env.WAREHOUSE_API_KEY = warehouseEnv.key;
  process.env.WAREHOUSE_CONTACTS_QUESTION_ID = warehouseEnv.qContacts;
  process.env.WAREHOUSE_INVESTMENTS_QUESTION_ID = warehouseEnv.qInvestments;
  process.env.WAREHOUSE_BALANCES_QUESTION_ID = warehouseEnv.qBalances;
  if (includeStockRecord) {
    process.env.WAREHOUSE_STOCK_RECORD_QUESTION_ID = warehouseEnv.qStockRecord;
  } else {
    delete process.env.WAREHOUSE_STOCK_RECORD_QUESTION_ID;
  }
}

function clearWarehouseEnv(): void {
  delete process.env.WAREHOUSE_URL;
  delete process.env.WAREHOUSE_API_KEY;
  delete process.env.WAREHOUSE_CONTACTS_QUESTION_ID;
  delete process.env.WAREHOUSE_INVESTMENTS_QUESTION_ID;
  delete process.env.WAREHOUSE_BALANCES_QUESTION_ID;
  delete process.env.WAREHOUSE_STOCK_RECORD_QUESTION_ID;
}

function okJson<T>(data: T) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

describe('warehouse service', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('isConfigured', () => {
    it('returns false when env vars are missing', async () => {
      vi.resetModules();
      clearWarehouseEnv();
      const { isConfigured } = await import('../warehouse.js');
      expect(isConfigured()).toBe(false);
    });

    it('returns true when all env vars are set', async () => {
      vi.resetModules();
      setWarehouseEnv();
      const { isConfigured } = await import('../warehouse.js');
      expect(isConfigured()).toBe(true);
    });
  });

  describe('fetchClients', () => {
    beforeEach(() => {
      vi.resetModules();
      setWarehouseEnv();
      global.fetch = vi.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes(`/card/${warehouseEnv.qContacts}/`)) return Promise.resolve(okJson(mockContacts));
        if (u.includes(`/card/${warehouseEnv.qInvestments}/`)) return Promise.resolve(okJson(mockInvestments));
        if (u.includes(`/card/${warehouseEnv.qBalances}/`)) return Promise.resolve(okJson(mockBalances));
        if (u.includes(`/card/${warehouseEnv.qStockRecord}/`)) return Promise.resolve(okJson(mockStockRecord));
        return Promise.reject(new Error(`unexpected fetch url: ${u}`));
      }) as unknown as typeof fetch;
    });

    it('fetches 3 tables, filters contacts by Client stage, joins balances via custodian_account_id, maps account types', async () => {
      const { fetchClients } = await import('../warehouse.js');
      const clients = await fetchClients();

      expect(global.fetch).toHaveBeenCalledTimes(3);
      expect(clients).toHaveLength(1);
      expect(clients[0]).toEqual({
        id: 'user-1',
        name: 'John Doe',
        accounts: [
          {
            id: 'apex-1',
            clientId: 'user-1',
            accountNumber: 'ACCT-001',
            accountType: 'Taxable',
            balance: 105000,
            holdings: { cash: 105000, fixed: 0, equity: 0 },
          },
          {
            id: 'apex-2',
            clientId: 'user-1',
            accountNumber: 'ACCT-002',
            accountType: 'Roth IRA',
            balance: 50000,
            holdings: { cash: 50000, fixed: 0, equity: 0 },
          },
        ],
      });
    });

    it('throws when Warehouse returns non-200', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 502,
        text: () => Promise.resolve('bad gateway'),
      });

      const { fetchClients } = await import('../warehouse.js');
      await expect(fetchClients()).rejects.toThrow(/Warehouse question .+ returned 502/);
    });
  });

  describe('fetchClients with stock record', () => {
    beforeEach(() => {
      vi.resetModules();
      setWarehouseEnv(true);
      global.fetch = vi.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes(`/card/${warehouseEnv.qContacts}/`)) return Promise.resolve(okJson(mockContacts));
        if (u.includes(`/card/${warehouseEnv.qInvestments}/`)) return Promise.resolve(okJson(mockInvestments));
        if (u.includes(`/card/${warehouseEnv.qBalances}/`)) return Promise.resolve(okJson(mockBalances));
        if (u.includes(`/card/${warehouseEnv.qStockRecord}/`)) return Promise.resolve(okJson(mockStockRecord));
        return Promise.reject(new Error(`unexpected fetch url: ${u}`));
      }) as unknown as typeof fetch;
    });

    it('fetches 4 tables and classifies holdings from stock record', async () => {
      const { fetchClients } = await import('../warehouse.js');
      const clients = await fetchClients();

      expect(global.fetch).toHaveBeenCalledTimes(4);
      expect(clients).toHaveLength(1);

      const acct1 = clients[0].accounts.find((a) => a.accountNumber === 'ACCT-001')!;
      // Stock record: AAPL=60k (equity), VGSH=30k (fixed), SWVXX=14k (cash) = 104k
      // Balance from balances question: 105k → residual 1k absorbed into cash
      expect(acct1.balance).toBe(105000);
      expect(acct1.holdings.equity).toBe(60000);
      expect(acct1.holdings.fixed).toBe(30000);
      expect(acct1.holdings.cash).toBe(15000); // 14000 + 1000 residual

      const acct2 = clients[0].accounts.find((a) => a.accountNumber === 'ACCT-002')!;
      // Stock record: MSFT=35k (equity), VTEB=14k (fixed) = 49k
      // Balance: 50k → residual 1k absorbed into cash
      expect(acct2.balance).toBe(50000);
      expect(acct2.holdings.equity).toBe(35000);
      expect(acct2.holdings.fixed).toBe(14000);
      expect(acct2.holdings.cash).toBe(1000); // 0 + 1000 residual
    });

    it('uses only the most recent business_date per account', async () => {
      const { fetchClients } = await import('../warehouse.js');
      const clients = await fetchClients();

      const acct1 = clients[0].accounts.find((a) => a.accountNumber === 'ACCT-001')!;
      // Stale 2026-03-26 row (AAPL=55k) should be ignored; only 2026-03-27 used
      expect(acct1.holdings.equity).toBe(60000);
    });

    it('falls back to all-cash holdings when stock record question fails', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string | URL) => {
        const u = String(url);
        if (u.includes(`/card/${warehouseEnv.qContacts}/`)) return Promise.resolve(okJson(mockContacts));
        if (u.includes(`/card/${warehouseEnv.qInvestments}/`)) return Promise.resolve(okJson(mockInvestments));
        if (u.includes(`/card/${warehouseEnv.qBalances}/`)) return Promise.resolve(okJson(mockBalances));
        if (u.includes(`/card/${warehouseEnv.qStockRecord}/`))
          return Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve('bad gateway') });
        return Promise.reject(new Error(`unexpected fetch url: ${u}`));
      });

      const { fetchClients } = await import('../warehouse.js');
      const clients = await fetchClients();

      expect(clients).toHaveLength(1);
      const acct1 = clients[0].accounts.find((a) => a.accountNumber === 'ACCT-001')!;
      expect(acct1.holdings).toEqual({ cash: 105000, fixed: 0, equity: 0 });
    });
  });

  describe('isStockRecordConfigured', () => {
    it('returns false when stock record question ID is not set', async () => {
      vi.resetModules();
      setWarehouseEnv(false);
      const { isStockRecordConfigured } = await import('../warehouse.js');
      expect(isStockRecordConfigured()).toBe(false);
    });

    it('returns true when stock record question ID is set', async () => {
      vi.resetModules();
      setWarehouseEnv(true);
      const { isStockRecordConfigured } = await import('../warehouse.js');
      expect(isStockRecordConfigured()).toBe(true);
    });
  });

  describe('getClientAccounts', () => {
    beforeEach(() => {
      vi.resetModules();
      setWarehouseEnv();
      global.fetch = vi.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes(`/card/${warehouseEnv.qContacts}/`)) return Promise.resolve(okJson(mockContacts));
        if (u.includes(`/card/${warehouseEnv.qInvestments}/`)) return Promise.resolve(okJson(mockInvestments));
        if (u.includes(`/card/${warehouseEnv.qBalances}/`)) return Promise.resolve(okJson(mockBalances));
        if (u.includes(`/card/${warehouseEnv.qStockRecord}/`)) return Promise.resolve(okJson(mockStockRecord));
        return Promise.reject(new Error(`unexpected fetch url: ${u}`));
      }) as unknown as typeof fetch;
    });

    it('returns accounts for a given client', async () => {
      const { getClientAccounts } = await import('../warehouse.js');
      const accounts = await getClientAccounts('user-1');
      expect(accounts).toHaveLength(2);
      expect(accounts.map((a) => a.accountNumber)).toEqual(['ACCT-001', 'ACCT-002']);
    });
  });

  describe('fetchAccountPositions', () => {
    // Custom balances payload: includes BOTH total_equity and the new
    // cash_equity column added in the 2026-Q3 cutover. apex-1 has multiple
    // snapshots (latest wins); apex-3 has a balance row but zero
    // stock_record rows.
    const balancesWithCash = [
      { account_id: 'apex-1', total_equity: 100000, cash_equity: 5000, snapshot_timestamp: '2026-03-22T00:00:00Z' },
      { account_id: 'apex-1', total_equity: 105000, cash_equity: 6000, snapshot_timestamp: '2026-03-23T00:00:00Z' },
      { account_id: 'apex-2', total_equity: 50000, cash_equity: 2500, snapshot_timestamp: '2026-03-23T00:00:00Z' },
      { account_id: 'apex-3', total_equity: 25000, cash_equity: 25000, snapshot_timestamp: '2026-03-23T00:00:00Z' },
    ];

    beforeEach(() => {
      vi.resetModules();
      setWarehouseEnv(true);
      global.fetch = vi.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes(`/card/${warehouseEnv.qBalances}/`)) return Promise.resolve(okJson(balancesWithCash));
        if (u.includes(`/card/${warehouseEnv.qStockRecord}/`)) return Promise.resolve(okJson(mockStockRecord));
        return Promise.reject(new Error(`unexpected fetch url: ${u}`));
      }) as unknown as typeof fetch;
    });

    it('selects the latest business_date per account when stock_record returns multiple dates', async () => {
      const { fetchAccountPositions } = await import('../warehouse.js');
      const result = await fetchAccountPositions();

      const apex1 = result.get('apex-1');
      expect(apex1).toBeDefined();
      expect(apex1!.businessDate).toBe('2026-03-27');
      // Stale 2026-03-26 row (AAPL=55k) is excluded; only 2026-03-27 rows.
      expect(apex1!.positionsBySymbol).toEqual({ AAPL: 60000, VGSH: 30000, SWVXX: 14000 });
    });

    it('computes positionsTotal = sum(trade_position_value) for the latest date', async () => {
      const { fetchAccountPositions } = await import('../warehouse.js');
      const result = await fetchAccountPositions();

      const apex1 = result.get('apex-1');
      // 60k + 30k + 14k = 104k (excludes the stale 55k row).
      expect(apex1!.positionsTotal).toBe(104000);

      const apex2 = result.get('apex-2');
      // 35k MSFT + 14k VTEB = 49k.
      expect(apex2!.positionsTotal).toBe(49000);
    });

    it('carries totalEquity through from the latest snapshot_timestamp per account', async () => {
      const { fetchAccountPositions } = await import('../warehouse.js');
      const result = await fetchAccountPositions();

      // apex-1: latest is 2026-03-23 → total_equity 105k.
      expect(result.get('apex-1')!.totalEquity).toBe(105000);
      expect(result.get('apex-2')!.totalEquity).toBe(50000);
      expect(result.get('apex-3')!.totalEquity).toBe(25000);
    });

    it('carries cashEquity through from the latest snapshot_timestamp per account', async () => {
      const { fetchAccountPositions } = await import('../warehouse.js');
      const result = await fetchAccountPositions();

      // apex-1 latest snapshot (2026-03-23) carries cash_equity = 6000
      // (the earlier 5000 row is shadowed).
      expect(result.get('apex-1')!.cashEquity).toBe(6000);
      expect(result.get('apex-2')!.cashEquity).toBe(2500);
      expect(result.get('apex-3')!.cashEquity).toBe(25000);
    });

    it('returns an entry for an account that has a balance row but zero stock_record rows', async () => {
      const { fetchAccountPositions } = await import('../warehouse.js');
      const result = await fetchAccountPositions();

      // apex-3 has no stock_record rows at all but a balance row → entry
      // must still be returned with empty positions and zero positionsTotal.
      const apex3 = result.get('apex-3');
      expect(apex3).toBeDefined();
      expect(apex3!.positionsBySymbol).toEqual({});
      expect(apex3!.positionsTotal).toBe(0);
      expect(apex3!.cashEquity).toBe(25000);
      expect(apex3!.totalEquity).toBe(25000);
      // No stock_record rows → empty businessDate string.
      expect(apex3!.businessDate).toBe('');
    });

    it('logs drift_balance_mismatch when |cashEquity + Σ stockRecord - totalEquity| > 0.01 USD', async () => {
      // apex-1: cashEquity 6000 + positionsTotal 104000 = 110000, but
      // totalEquity = 105000 → reconcile delta = 5000 → must warn.
      // apex-3: cashEquity 25000 + 0 = 25000 = totalEquity → reconciles
      // exactly → must NOT warn.
      const warnSpy = vi.fn();
      vi.doMock('../../lib/logger.js', () => ({
        default: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
      }));

      const { fetchAccountPositions } = await import('../warehouse.js');
      await fetchAccountPositions();

      const mismatchCalls = warnSpy.mock.calls.filter(
        (call) =>
          typeof call[0] === 'object' &&
          call[0] !== null &&
          (call[0] as { event?: string }).event === 'drift_balance_mismatch',
      );
      // apex-1 mismatches (delta 5000); apex-2 mismatches (cash 2500 +
      // positions 49000 = 51500 vs totalEquity 50000 → delta 1500);
      // apex-3 reconciles cleanly (delta 0).
      expect(mismatchCalls.length).toBeGreaterThanOrEqual(1);

      const accountIds = mismatchCalls.map((call) => (call[0] as { accountId: string }).accountId);
      expect(accountIds).toContain('apex-1');
      // apex-3 is the clean account; it must not appear.
      expect(accountIds).not.toContain('apex-3');

      vi.doUnmock('../../lib/logger.js');
    });

    it('tags a curated cash symbol as a cash equivalent even without feed metadata', async () => {
      const { fetchAccountPositions } = await import('../warehouse.js');
      const result = await fetchAccountPositions();

      // mockStockRecord carries no asset_type/closing_price columns, so this
      // relies purely on the curated CASH_SYMBOLS path.
      expect([...result.get('apex-1')!.cashEquivalentSymbols!]).toEqual(['SWVXX']);
    });

    it('leaves cashEquivalentSymbols undefined for an account holding none', async () => {
      const { fetchAccountPositions } = await import('../warehouse.js');
      const result = await fetchAccountPositions();

      // apex-2 holds MSFT + VTEB; apex-3 holds nothing.
      expect(result.get('apex-2')!.cashEquivalentSymbols).toBeUndefined();
      expect(result.get('apex-3')!.cashEquivalentSymbols).toBeUndefined();
    });

    it('derives a cash equivalent from asset_type + closing_price for an uncurated ticker', async () => {
      // XYZXX is not in CASH_SYMBOLS — only the feed columns identify it.
      const derivedRows = [
        {
          account_id: 'apex-9',
          symbol: 'XYZXX',
          trade_position_value: 20000,
          business_date: '2026-03-27',
          asset_type: 'MUTUAL_FUND',
          closing_price: 1,
          symbol_description: 'SOME NEW GOVT MONEY MKT FD',
        },
        {
          account_id: 'apex-9',
          symbol: 'VCAIX',
          trade_position_value: 10000,
          business_date: '2026-03-27',
          asset_type: 'MUTUAL_FUND',
          closing_price: 11.42,
          symbol_description: 'VANGUARD CA INTER TERM TAXEXEMPT FD INV SHS',
        },
      ];
      global.fetch = vi.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes(`/card/${warehouseEnv.qBalances}/`)) return Promise.resolve(okJson([]));
        if (u.includes(`/card/${warehouseEnv.qStockRecord}/`)) return Promise.resolve(okJson(derivedRows));
        return Promise.reject(new Error(`unexpected fetch url: ${u}`));
      }) as unknown as typeof fetch;

      const { fetchAccountPositions } = await import('../warehouse.js');
      const result = await fetchAccountPositions();

      // The $1.00-NAV fund is tagged; the $11.42 long muni fund is not.
      expect([...result.get('apex-9')!.cashEquivalentSymbols!]).toEqual(['XYZXX']);
    });
  });

  describe('getAccountTypeMap', () => {
    beforeEach(() => {
      vi.resetModules();
      setWarehouseEnv();
      global.fetch = vi.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes(`/card/${warehouseEnv.qContacts}/`)) return Promise.resolve(okJson(mockContacts));
        if (u.includes(`/card/${warehouseEnv.qInvestments}/`)) return Promise.resolve(okJson(mockInvestments));
        if (u.includes(`/card/${warehouseEnv.qBalances}/`)) return Promise.resolve(okJson(mockBalances));
        if (u.includes(`/card/${warehouseEnv.qStockRecord}/`)) return Promise.resolve(okJson(mockStockRecord));
        return Promise.reject(new Error(`unexpected fetch url: ${u}`));
      }) as unknown as typeof fetch;
    });

    it('returns account types for given account numbers', async () => {
      const { getAccountTypeMap } = await import('../warehouse.js');
      const map = await getAccountTypeMap(['ACCT-002', 'ACCT-001']);
      expect(map).toEqual({
        'ACCT-001': 'Taxable',
        'ACCT-002': 'Roth IRA',
      });
    });

    it('returns stable Apex account ids for legacy request account numbers', async () => {
      const { getAccountIdMap } = await import('../warehouse.js');
      const map = await getAccountIdMap(['ACCT-002', 'ACCT-001', 'UNKNOWN']);
      expect(map).toEqual({
        'ACCT-001': 'apex-1',
        'ACCT-002': 'apex-2',
      });
    });
  });

  describe('getClientIdsByAccountUlid', () => {
    // Each test scopes its own `localContacts` / `localInvestments` because
    // cases #2 (joint) and #6 (prospect filter) need conflicting stage values
    // for `user-2`. The top-of-file `mockContacts` / `mockInvestments` stay
    // unmodified so the existing `fetchClients` tests remain stable.
    function stubFetch(localContacts: unknown, localInvestments: unknown): void {
      global.fetch = vi.fn((url: string | URL) => {
        const u = String(url);
        if (u.includes(`/card/${warehouseEnv.qContacts}/`)) return Promise.resolve(okJson(localContacts));
        if (u.includes(`/card/${warehouseEnv.qInvestments}/`)) return Promise.resolve(okJson(localInvestments));
        if (u.includes(`/card/${warehouseEnv.qBalances}/`)) return Promise.resolve(okJson(mockBalances));
        return Promise.reject(new Error(`unexpected fetch url: ${u}`));
      }) as unknown as typeof fetch;
    }

    beforeEach(() => {
      vi.resetModules();
      setWarehouseEnv();
    });

    it('returns a single client id for a single-client account', async () => {
      stubFetch(
        [{ cedar_ridge_user_id__c: 'user-1', name: 'John Doe', crm__primary_entity_stage__c: 'Client' }],
        [
          {
            user_id: 'user-1',
            custodian_account_id: 'apex-1',
            custodian_account_number: 'ACCT-001',
            account_type: 'BROKERAGE',
          },
        ],
      );
      const { getClientIdsByAccountUlid } = await import('../warehouse.js');
      const map = await getClientIdsByAccountUlid(['apex-1']);
      expect(map).toEqual({ 'apex-1': ['user-1'] });
    });

    it('returns all owning client ids (sorted) for a joint account', async () => {
      // Both users are 'Client' here — this is the deliberate divergence from
      // the top-of-file mockContacts where user-2 is 'Prospect'.
      stubFetch(
        [
          { cedar_ridge_user_id__c: 'user-1', name: 'John Doe', crm__primary_entity_stage__c: 'Client' },
          { cedar_ridge_user_id__c: 'user-2', name: 'Jane Doe', crm__primary_entity_stage__c: 'Client' },
        ],
        [
          {
            user_id: 'user-1',
            custodian_account_id: 'apex-1',
            custodian_account_number: 'ACCT-001',
            account_type: 'JOINT_BROKERAGE_TENANTS_IN_COMMON',
          },
          {
            user_id: 'user-2',
            custodian_account_id: 'apex-1',
            custodian_account_number: 'ACCT-001',
            account_type: 'JOINT_BROKERAGE_TENANTS_IN_COMMON',
          },
          {
            user_id: 'user-2',
            custodian_account_id: 'apex-2',
            custodian_account_number: 'ACCT-002',
            account_type: 'BROKERAGE',
          },
        ],
      );
      const { getClientIdsByAccountUlid } = await import('../warehouse.js');
      const map = await getClientIdsByAccountUlid(['apex-1', 'apex-2']);
      expect(map).toEqual({
        'apex-1': ['user-1', 'user-2'],
        'apex-2': ['user-2'],
      });
    });

    it('returns empty array (not undefined) for unknown ULIDs', async () => {
      stubFetch(
        [{ cedar_ridge_user_id__c: 'user-1', name: 'John Doe', crm__primary_entity_stage__c: 'Client' }],
        [
          {
            user_id: 'user-1',
            custodian_account_id: 'apex-1',
            custodian_account_number: 'ACCT-001',
            account_type: 'BROKERAGE',
          },
        ],
      );
      const { getClientIdsByAccountUlid } = await import('../warehouse.js');
      const map = await getClientIdsByAccountUlid(['apex-1', 'unknown-ulid']);
      expect(map).toEqual({
        'apex-1': ['user-1'],
        'unknown-ulid': [],
      });
      expect(map['unknown-ulid']).toBeDefined();
    });

    it('dedupes when investments has duplicate (user_id, custodian_account_id) rows', async () => {
      stubFetch(
        [{ cedar_ridge_user_id__c: 'user-1', name: 'John Doe', crm__primary_entity_stage__c: 'Client' }],
        [
          {
            user_id: 'user-1',
            custodian_account_id: 'apex-1',
            custodian_account_number: 'ACCT-001',
            account_type: 'BROKERAGE',
          },
          {
            user_id: 'user-1',
            custodian_account_id: 'apex-1',
            custodian_account_number: 'ACCT-001',
            account_type: 'BROKERAGE',
          },
        ],
      );
      const { getClientIdsByAccountUlid } = await import('../warehouse.js');
      const map = await getClientIdsByAccountUlid(['apex-1']);
      expect(map).toEqual({ 'apex-1': ['user-1'] });
    });

    it('returns an empty object for empty input', async () => {
      stubFetch(
        [{ cedar_ridge_user_id__c: 'user-1', name: 'John Doe', crm__primary_entity_stage__c: 'Client' }],
        [
          {
            user_id: 'user-1',
            custodian_account_id: 'apex-1',
            custodian_account_number: 'ACCT-001',
            account_type: 'BROKERAGE',
          },
        ],
      );
      const { getClientIdsByAccountUlid } = await import('../warehouse.js');
      const map = await getClientIdsByAccountUlid([]);
      expect(map).toEqual({});
    });

    it('excludes Prospects (regression guard against widening lookup to leads)', async () => {
      stubFetch(
        [
          { cedar_ridge_user_id__c: 'user-1', name: 'John Doe', crm__primary_entity_stage__c: 'Client' },
          { cedar_ridge_user_id__c: 'user-2', name: 'Lead Larry', crm__primary_entity_stage__c: 'Prospect' },
        ],
        [
          {
            user_id: 'user-1',
            custodian_account_id: 'apex-1',
            custodian_account_number: 'ACCT-001',
            account_type: 'JOINT_BROKERAGE_TENANTS_IN_COMMON',
          },
          {
            user_id: 'user-2',
            custodian_account_id: 'apex-1',
            custodian_account_number: 'ACCT-001',
            account_type: 'JOINT_BROKERAGE_TENANTS_IN_COMMON',
          },
        ],
      );
      const { getClientIdsByAccountUlid } = await import('../warehouse.js');
      const map = await getClientIdsByAccountUlid(['apex-1']);
      expect(map).toEqual({ 'apex-1': ['user-1'] });
    });
  });
});

// ─── fetchCostBasisData: multi-source merge ──────────────────────────────────
//
// Reproduces the 2026-08-27 production state that motivated multi-source reads:
//   db 4   — weekly open-lot loader dead since 08-15, baseline stuck at 08-14;
//            daily deltas current through 08-26.
//   db 101 — carries the 08-21 weekly snapshot db 4 never loaded; daily deltas
//            stop at 08-25.
// Neither database alone is current. The merge must take db 101's newer baseline
// and db 4's newer deltas.
describe('fetchCostBasisData (multi-source)', () => {
  interface Captured {
    databaseId: number;
    sql: string;
  }

  function lotRow(openLotId: string, processDate: string, extra: Record<string, unknown> = {}) {
    return {
      open_lot_id: openLotId,
      process_date: processDate,
      account_id: 'ACCT1',
      symbol: 'NVDA',
      quantity: 10,
      term: 'LONG_TERM',
      acquisition_event_type: 'BUY',
      acquisition_adjusted_net: 700,
      acquisition_true_zero_cost_indicator: 'N',
      wash_sale_adjustment: 0,
      open_closed_indicator: 'OPEN',
      ...extra,
    };
  }

  function install(captured: Captured[]): void {
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (!u.includes('/api/dataset/json')) throw new Error(`unexpected url ${u}`);
      const parsed = JSON.parse(new URLSearchParams(String(init?.body)).get('query')!);
      const databaseId = parsed.database as number;
      const sql = parsed.native.query as string;
      captured.push({ databaseId, sql });

      let rows: unknown[] = [];
      if (sql.includes('AS full_refresh_latest')) {
        // Probe.
        rows =
          databaseId === 4
            ? [
                {
                  full_refresh_latest: '2026-08-14T00:00:00-04:00',
                  full_gluerun_latest: '2026-08-15T15:02:35',
                  daily_refresh_latest: '2026-08-26T00:00:00-04:00',
                  daily_gluerun_latest: '2026-08-27T11:02:44',
                },
              ]
            : [
                {
                  full_refresh_latest: '2026-08-21T00:00:00-04:00',
                  full_gluerun_latest: '2026-08-27T09:02:35',
                  daily_refresh_latest: '2026-08-25T00:00:00-04:00',
                  daily_gluerun_latest: '2026-08-27T09:02:35',
                },
              ];
      } else if (sql.includes('apex_cost_basis_open_lot_full_refresh')) {
        // Baseline — only db 101 should ever be asked.
        rows = [lotRow('BASE1', '2026-08-21'), lotRow('SHARED', '2026-08-21', { quantity: 1 })];
      } else if (sql.includes('apex_cost_basis_open_lot_refresh')) {
        rows =
          databaseId === 4
            ? [lotRow('SHARED', '2026-08-26', { quantity: 99 }), lotRow('ZZ10005', '2026-08-26')]
            : [lotRow('SHARED', '2026-08-25', { quantity: 50 })];
      }
      return { ok: true, status: 200, json: async () => rows, text: async () => '' };
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    vi.resetModules();
    setWarehouseEnv(true);
    process.env.WAREHOUSE_COST_BASIS_DB_IDS = '4,101';
  });

  afterEach(() => {
    delete process.env.WAREHOUSE_COST_BASIS_DB_IDS;
  });

  it('pulls the baseline only from the source with the newest weekly snapshot', async () => {
    const captured: Captured[] = [];
    install(captured);
    const { fetchCostBasisData } = await import('../warehouse.js');
    await fetchCostBasisData();

    const baselineCalls = captured.filter(
      (c) => c.sql.includes('apex_cost_basis_open_lot_full_refresh') && !c.sql.includes('AS full_refresh_latest'),
    );
    expect(baselineCalls).toHaveLength(1);
    expect(baselineCalls[0].databaseId).toBe(101);
    // And it anchors on that source's date, not db 4's stale one.
    expect(baselineCalls[0].sql).toContain("'2026-08-21'");
  });

  it('pulls deltas from every source', async () => {
    const captured: Captured[] = [];
    install(captured);
    const { fetchCostBasisData } = await import('../warehouse.js');
    await fetchCostBasisData();

    const deltaDbs = captured
      .filter((c) => c.sql.includes('apex_cost_basis_open_lot_refresh') && !c.sql.includes('full_refresh_latest'))
      .map((c) => c.databaseId)
      .sort((a, b) => a - b);
    expect(deltaDbs).toEqual([4, 101]);
  });

  it('merges to one row per lot, newest process_date winning across sources', async () => {
    install([]);
    const { fetchCostBasisData } = await import('../warehouse.js');
    const result = await fetchCostBasisData();

    expect(result.lots).toHaveLength(3); // BASE1, SHARED, ZZ10005
    const shared = result.lots.filter((l) => l.quantity === 99);
    // db 4's 08-26 copy of SHARED beats db 101's 08-25 copy and the 08-21 baseline.
    expect(shared).toHaveLength(1);
  });

  it('reports the freshest date per table across sources, and per-source detail', async () => {
    install([]);
    const { fetchCostBasisData } = await import('../warehouse.js');
    const result = await fetchCostBasisData();

    // Best-of: db 101's weekly, db 4's daily.
    expect(result.fullRefreshLatest).toContain('2026-08-21');
    expect(result.dailyRefreshLatest).toContain('2026-08-26');

    expect(result.sources).toHaveLength(2);
    const four = result.sources.find((s) => s.databaseId === 4)!;
    const oneOhOne = result.sources.find((s) => s.databaseId === 101)!;
    expect(oneOhOne.baselineSource).toBe(true);
    expect(four.baselineSource).toBe(false);
    // db 4's own stale weekly date is preserved for the per-source alert.
    expect(four.fullRefreshLatest).toContain('2026-08-14');
  });

  it('still works when one source is unreachable', async () => {
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = JSON.parse(new URLSearchParams(String(init?.body)).get('query')!);
      if (parsed.database === 4) throw new Error('connection refused');
      const sql = parsed.native.query as string;
      let rows: unknown[] = [];
      if (sql.includes('AS full_refresh_latest')) {
        rows = [
          {
            full_refresh_latest: '2026-08-21T00:00:00-04:00',
            full_gluerun_latest: '2026-08-27T09:02:35',
            daily_refresh_latest: '2026-08-25T00:00:00-04:00',
            daily_gluerun_latest: '2026-08-27T09:02:35',
          },
        ];
      } else if (sql.includes('full_refresh')) {
        rows = [lotRow('BASE1', '2026-08-21')];
      }
      return { ok: true, status: 200, json: async () => rows, text: async () => '' };
    }) as unknown as typeof fetch;

    const { fetchCostBasisData } = await import('../warehouse.js');
    const result = await fetchCostBasisData();
    expect(result.sources.map((s) => s.databaseId)).toEqual([101]);
    expect(result.lots).toHaveLength(1);
  });

  it('defaults to the single legacy database when the list is unset', async () => {
    delete process.env.WAREHOUSE_COST_BASIS_DB_IDS;
    const captured: Captured[] = [];
    install(captured);
    const { fetchCostBasisData } = await import('../warehouse.js');
    await fetchCostBasisData();
    expect(new Set(captured.map((c) => c.databaseId))).toEqual(new Set([4]));
  });
});
