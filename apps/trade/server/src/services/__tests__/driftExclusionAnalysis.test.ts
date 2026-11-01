import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Pool } from 'pg';
import { analyzeExclusionOverlapForRun, classifyBreach } from '../driftExclusionAnalysis.js';

const { mockGetClientIdsByAccountUlid } = vi.hoisted(() => ({
  mockGetClientIdsByAccountUlid: vi.fn(),
}));

vi.mock('../warehouse.js', () => ({
  getClientIdsByAccountUlid: mockGetClientIdsByAccountUlid,
}));

function makePool(): Pool {
  return {
    query: vi.fn(),
  } as unknown as Pool;
}

describe('classifyBreach', () => {
  it('returns actionable when no exclusions match', () => {
    expect(classifyBreach(30, 20, [])).toBe('actionable');
  });

  it('returns locked_blanket when both no_buy and no_sell are present', () => {
    expect(
      classifyBreach(10, 20, [
        { no_buy: true, no_sell: false },
        { no_buy: false, no_sell: true },
      ]),
    ).toBe('locked_blanket');
  });

  it('returns locked_dnb_under when account is under target with no_buy', () => {
    expect(classifyBreach(10, 20, [{ no_buy: true, no_sell: false }])).toBe('locked_dnb_under');
  });

  it('returns locked_dns_over when account is over target with no_sell', () => {
    expect(classifyBreach(30, 20, [{ no_buy: false, no_sell: true }])).toBe('locked_dns_over');
  });

  it('returns sign_mismatch_unlocked when exclusion side does not match direction', () => {
    expect(classifyBreach(10, 20, [{ no_buy: false, no_sell: true }])).toBe('sign_mismatch_unlocked');
  });
});

describe('analyzeExclusionOverlapForRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no run exists', async () => {
    const pool = makePool();
    const query = pool.query as unknown as Mock;
    query.mockResolvedValueOnce({ rows: [{ latest: null }] });

    await expect(analyzeExclusionOverlapForRun(pool)).resolves.toBeNull();
    expect(mockGetClientIdsByAccountUlid).not.toHaveBeenCalled();
  });

  it('computes counts with joint-account union semantics and unknown-account fallback', async () => {
    const pool = makePool();
    const query = pool.query as unknown as Mock;
    query
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: 'acct-1',
            account_title: 'Primary Account',
            household_name: 'Household A',
            status: 'out',
            max_bucket_delta_pct: 22.1,
            symbol_breach_count: 3,
            details: {
              symbolsWithTargets: [
                { symbol: 'AAPL', positionPct: 10, targetPct: 20, breach: true },
                { symbol: 'MSFT', positionPct: 40, targetPct: 20, breach: true },
                { symbol: 'GOOG', positionPct: 10, targetPct: 20, breach: true },
              ],
            },
          },
          {
            account_id: 'acct-2',
            account_title: 'Unknown Account',
            household_name: 'Household B',
            status: 'out',
            max_bucket_delta_pct: 8.2,
            symbol_breach_count: 1,
            details: {
              symbolsWithTargets: [{ symbol: 'TSLA', positionPct: 30, targetPct: 20, breach: true }],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { client_id: 'client-1', ticker: 'AAPL', no_buy: true, no_sell: false },
          { client_id: 'client-2', ticker: 'AAPL', no_buy: false, no_sell: true },
          { client_id: 'client-1', ticker: 'MSFT', no_buy: false, no_sell: true },
          { client_id: 'client-1', ticker: 'GOOG', no_buy: false, no_sell: true },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    mockGetClientIdsByAccountUlid.mockResolvedValue({
      'acct-1': ['client-1', 'client-2'],
      'acct-2': [],
    });

    const report = await analyzeExclusionOverlapForRun(pool, { runDateLocal: '2026-05-22' });
    expect(report).not.toBeNull();
    expect(report).toMatchObject({
      runDateLocal: '2026-05-22',
      totalAccounts: 2,
      outAccounts: 2,
      totalExclusions: 4,
      totalBreaches: 4,
      lockedTotal: 2,
      lockedSharePct: 50,
      counts: {
        actionable: 1,
        locked_blanket: 1,
        locked_dnb_under: 0,
        locked_dns_over: 1,
        sign_mismatch_unlocked: 1,
      },
    });
    expect(report?.worstAccounts[0]).toMatchObject({
      accountId: 'acct-1',
      lockedCount: 2,
    });
    expect(mockGetClientIdsByAccountUlid).toHaveBeenCalledWith(['acct-1', 'acct-2']);
  });

  it('excludes uninvested accounts — they neither inflate breach counts nor appear in the list', async () => {
    const pool = makePool();
    const query = pool.query as unknown as Mock;
    query
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: 'acct-out',
            account_title: 'Real Drift',
            household_name: 'HH',
            status: 'out',
            max_bucket_delta_pct: 12,
            symbol_breach_count: 1,
            details: { symbolsWithTargets: [{ symbol: 'BND', positionPct: 5, targetPct: 30, breach: true }] },
          },
          {
            // Cash-heavy, not yet invested. Its huge cash-vs-target "breaches"
            // would dominate the worst list by raw Δ if not excluded.
            account_id: 'acct-uninv',
            account_title: 'Newly Funded Cash',
            household_name: 'HH2',
            status: 'uninvested',
            max_bucket_delta_pct: 96,
            symbol_breach_count: 2,
            details: {
              symbolsWithTargets: [
                { symbol: 'BND', positionPct: 0, targetPct: 30, breach: true },
                { symbol: 'AGG', positionPct: 0, targetPct: 20, breach: true },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // client_exclusions
      .mockResolvedValueOnce({ rows: [] }); // account_exclusions
    mockGetClientIdsByAccountUlid.mockResolvedValue({ 'acct-out': [], 'acct-uninv': [] });

    const report = await analyzeExclusionOverlapForRun(pool, { runDateLocal: '2026-06-11' });
    expect(report).not.toBeNull();
    expect(report?.totalAccounts).toBe(2); // both counted for context
    expect(report?.outAccounts).toBe(1); // only acct-out
    expect(report?.totalBreaches).toBe(1); // uninvested's 2 cash breaches are ignored
    expect(report?.worstAccounts.map((a) => a.accountId)).toEqual(['acct-out']); // uninvested NOT listed
  });

  it('treats all breaches as actionable when exclusions table is empty', async () => {
    const pool = makePool();
    const query = pool.query as unknown as Mock;
    query
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: 'acct-1',
            account_title: 'No Exclusions',
            household_name: 'Household A',
            status: 'out',
            max_bucket_delta_pct: 11.5,
            symbol_breach_count: 1,
            details: {
              symbolsWithTargets: [{ symbol: 'BND', positionPct: 5, targetPct: 20, breach: true }],
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockGetClientIdsByAccountUlid.mockResolvedValue({ 'acct-1': ['client-1'] });

    const report = await analyzeExclusionOverlapForRun(pool, { runDateLocal: '2026-05-20' });
    expect(report).not.toBeNull();
    expect(report?.counts).toMatchObject({
      actionable: 1,
      locked_blanket: 0,
      locked_dnb_under: 0,
      locked_dns_over: 0,
      sign_mismatch_unlocked: 0,
    });
    expect(report?.lockedTotal).toBe(0);
    expect(report?.totalExclusions).toBe(0);
  });

  it('applies account-scoped exclusions even when account has no mapped client ids', async () => {
    const pool = makePool();
    const query = pool.query as unknown as Mock;
    query
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: 'acct-2',
            account_title: 'Account Scoped',
            household_name: 'Household B',
            status: 'out',
            max_bucket_delta_pct: 12.2,
            symbol_breach_count: 1,
            details: {
              symbolsWithTargets: [{ symbol: 'TSLA', positionPct: 30, targetPct: 20, breach: true }],
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ account_id: 'acct-2', ticker: 'TSLA', no_buy: false, no_sell: true }],
      });
    mockGetClientIdsByAccountUlid.mockResolvedValue({ 'acct-2': [] });

    const report = await analyzeExclusionOverlapForRun(pool, { runDateLocal: '2026-05-21' });
    expect(report).not.toBeNull();
    expect(report).toMatchObject({
      totalExclusions: 1,
      totalBreaches: 1,
      lockedTotal: 1,
      counts: {
        actionable: 0,
        locked_blanket: 0,
        locked_dnb_under: 0,
        locked_dns_over: 1,
        sign_mismatch_unlocked: 0,
      },
    });
  });

  it('only executes SELECT statements in analysis queries', async () => {
    const pool = makePool();
    const query = pool.query as unknown as Mock;
    query
      .mockResolvedValueOnce({
        rows: [
          {
            account_id: 'acct-1',
            account_title: 'Read Only',
            household_name: 'Household A',
            status: 'in',
            max_bucket_delta_pct: 0.2,
            symbol_breach_count: 0,
            details: { symbolsWithTargets: [] },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    mockGetClientIdsByAccountUlid.mockResolvedValue({ 'acct-1': [] });

    await analyzeExclusionOverlapForRun(pool, { runDateLocal: '2026-05-19' });

    const sqlStatements = query.mock.calls.map((call: unknown[]) => String(call[0]).toUpperCase());
    expect(sqlStatements).toHaveLength(3);
    for (const sql of sqlStatements) {
      expect(sql.includes('SELECT')).toBe(true);
      expect(sql.includes('INSERT')).toBe(false);
      expect(sql.includes('UPDATE')).toBe(false);
      expect(sql.includes('DELETE')).toBe(false);
    }
  });
});
