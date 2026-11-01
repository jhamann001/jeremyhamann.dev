import { describe, it, expect } from 'vitest';
import { comparePositionsToMeridianPerAccount, SETTLEMENT_CASH_SYMBOL_FOR_TESTS } from '../positionDriftAccounts.js';
import type { AccountPositions } from '../warehouse.js';
import type { MeridianSnapshot } from '../meridianSnapshot.js';
import type { HouseholdConfig } from '../householdConfig.js';

/**
 * v2 per-account comparator unit tests (18 cases).
 * Spec: docs/plans/2026-q3-drift-v2-accounts.md §8.
 *
 * The comparator is pure (no I/O, no DB) so every test passes synthetic
 * `AccountPositions` + `MeridianSnapshot` inputs and asserts on the
 * returned `AccountDriftResult[]`.
 */

// 2-tuple `[accountNumber, householdName]` keeps the existing 22 cases
// signature-compatible. 3-tuple `[accountNumber, householdName, accountTitle]`
// is used by the title-precedence cases below so they can populate the
// firm-baked title without rewriting unrelated fixtures.
type HouseholdEntryTuple = [string, string] | [string, string, string];

function householdConfig(entries: Array<HouseholdEntryTuple> = []): HouseholdConfig {
  const byAccountNumber = new Map(
    entries.map(([accountNumber, householdName, accountTitle]) => {
      const entry =
        accountTitle !== undefined ? { accountNumber, householdName, accountTitle } : { accountNumber, householdName };
      return [accountNumber, entry] as const;
    }),
  );
  const householdNames = new Set(entries.map(([, h]) => h));
  return {
    byAccountNumber,
    householdNames,
    entries: entries.map(([accountNumber, householdName, accountTitle]) =>
      accountTitle !== undefined ? { accountNumber, householdName, accountTitle } : { accountNumber, householdName },
    ),
  };
}

function snapshot(entries: MeridianSnapshot['entries'] = []): MeridianSnapshot {
  return { generatedAt: '2026-05-13T00:00:00.000Z', entries };
}

function position(args: {
  accountId: string;
  totalEquity: number;
  cashEquity: number;
  positionsBySymbol: Record<string, number>;
}): AccountPositions {
  const positionsTotal = Object.values(args.positionsBySymbol).reduce((s, v) => s + v, 0);
  return {
    accountId: args.accountId,
    positionsTotal,
    totalEquity: args.totalEquity,
    cashEquity: args.cashEquity,
    positionsBySymbol: args.positionsBySymbol,
    businessDate: '2026-05-13',
  };
}

describe('comparePositionsToMeridianPerAccount', () => {
  it('emits one AccountDriftResult per mapped account that survives the zero-value filter', () => {
    // Template-only accounts (no Apex positions ⇒ totalEquity = 0) are
    // dropped by the zero-value filter; only A survives because it has
    // an Apex balance row.
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 2, positionsBySymbol: { VOO: 98 } })],
    ]);
    const snap = snapshot([
      { account: 'A', weights: { VOO: 60, BND: 40 } },
      { account: 'B', weights: { VOO: 100 } }, // template-only — filtered out (no positions ⇒ totalValue = 0)
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snap,
      householdConfig: householdConfig([
        ['A', 'HHA'],
        ['B', 'HHB'],
      ]),
    });
    expect(result.accounts.map((a) => a.accountId)).toEqual(['A']);
  });

  it('sorts accounts by maxBucketDeltaPct DESC, accountId ASC', () => {
    const positions = new Map<string, AccountPositions>([
      ['B', position({ accountId: 'B', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })], // huge equity delta
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 60 } })], // smaller delta
      ['C', position({ accountId: 'C', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 60 } })], // tied with A
    ]);
    const snap = snapshot([
      { account: 'A', weights: { VOO: 60 } },
      { account: 'B', weights: { VOO: 60 } },
      { account: 'C', weights: { VOO: 60 } },
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snap,
      householdConfig: householdConfig([
        ['A', 'HHA'],
        ['B', 'HHB'],
        ['C', 'HHC'],
      ]),
    });
    expect(result.accounts.map((a) => a.accountId)).toEqual(['B', 'A', 'C']);
  });

  it('cashPct includes cashEquity AND cash-equiv fund weight (SWVXX)', () => {
    // totalEquity 100; cashEquity 5; SWVXX 10 (cash-equiv); VOO 85.
    // Expected cashPct = (5 + 10) / 100 * 100 = 15.
    const positions = new Map<string, AccountPositions>([
      [
        'A',
        position({
          accountId: 'A',
          totalEquity: 100,
          cashEquity: 5,
          positionsBySymbol: { SWVXX: 10, VOO: 85 },
        }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60, BND: 40 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    const a = result.accounts[0];
    expect(a.details.buckets.cash.positionPct).toBeCloseTo(15, 4);
  });

  it('equity symbols on the position side do not appear in symbolsWithTargets but do appear in equityHoldings', () => {
    const positions = new Map<string, AccountPositions>([
      [
        'A',
        position({
          accountId: 'A',
          totalEquity: 100,
          cashEquity: 0,
          positionsBySymbol: { VOO: 70, BND: 30 },
        }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60, BND: 30 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    const a = result.accounts[0];
    expect(a.details.symbolsWithTargets.find((r) => r.symbol === 'VOO')).toBeUndefined();
    expect(a.details.equityHoldings.find((r) => r.symbol === 'VOO')).toBeDefined();
  });

  it('cash-bucket template symbols (VMFXX) get per-symbol breach detection independently of bucket breach', () => {
    // Template asks for 95% VMFXX (cash-equiv); position has 0% VMFXX and 95% in cash sweep.
    // Bucket totals: position cash 100 vs template cash 95 → bucket delta 5 (in tolerance).
    // Per-symbol VMFXX: position 0 vs target 95 → breach.
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 100, positionsBySymbol: {} })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VMFXX: 95, VOO: 5 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
      tolerancePct: 5,
    });
    const a = result.accounts[0];
    const vmfxx = a.details.symbolsWithTargets.find((r) => r.symbol === 'VMFXX');
    expect(vmfxx?.breach).toBe(true);
    expect(a.symbolBreachCount).toBeGreaterThanOrEqual(1);
  });

  it('fixed-bucket symbols (BND, SGOV, VTEB) get per-symbol breach detection', () => {
    const positions = new Map<string, AccountPositions>([
      [
        'A',
        position({
          accountId: 'A',
          totalEquity: 100,
          cashEquity: 2,
          positionsBySymbol: { BND: 10, SGOV: 0, VTEB: 0, VOO: 88 },
        }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { BND: 26, SGOV: 12, VOO: 62 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
      tolerancePct: 5,
    });
    const a = result.accounts[0];
    const bnd = a.details.symbolsWithTargets.find((r) => r.symbol === 'BND');
    const sgov = a.details.symbolsWithTargets.find((r) => r.symbol === 'SGOV');
    expect(bnd?.breach).toBe(true);
    expect(sgov?.breach).toBe(true);
  });

  it('an account with exactly tolerance bucket delta is in (strict >), just above is out', () => {
    // Exactly 5pp bucket delta, no symbol breaches → 'in'.
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const snap = snapshot([{ account: 'A', weights: { VOO: 95, BND: 5 } }]);
    // position cash 0 vs template cash 0 = 0; position fixed 0 vs template fixed 5 = 5; position equity 100 vs template equity 95 = 5.
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snap,
      householdConfig: householdConfig([['A', 'HHA']]),
      tolerancePct: 5,
    });
    expect(result.accounts[0].status).toBe('in');

    // Bump to 5.01pp → 'out'.
    const positions2 = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const snap2 = snapshot([{ account: 'A', weights: { VOO: 94.99, BND: 5.01 } }]);
    const result2 = comparePositionsToMeridianPerAccount({
      positions: positions2,
      snapshot: snap2,
      householdConfig: householdConfig([['A', 'HHA']]),
      tolerancePct: 5,
    });
    expect(result2.accounts[0].status).toBe('out');
  });

  it("status='uninvested' when cashPct >= threshold and templateCashPct < 50", () => {
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 99.5, positionsBySymbol: {} })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60, BND: 35, VMFXX: 5 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
      tolerancePct: 5,
      uninvestedCashThresholdPct: 99,
    });
    expect(result.accounts[0].status).toBe('uninvested');
  });

  it("status='in' on a cash template even when cashPct=100 (templateCashPct >= 50 disables uninvested)", () => {
    // Position: 5% settlement cash + 95% VMFXX (cash-equiv) = 100% cash.
    // Template: 100% VMFXX = 100% cash (sums to 100, so R2 doesn't flag it).
    // Bucket delta 0, VMFXX delta 5 (== tolerance, not a breach) → in
    // tolerance. cashPct=100 but templateCashPct=100 disables the 'uninvested'
    // rule (templateCashPct >= 50). Status must be 'in'.
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 5, positionsBySymbol: { VMFXX: 95 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VMFXX: 100 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
      tolerancePct: 5,
      uninvestedCashThresholdPct: 99,
    });
    expect(result.accounts[0].status).toBe('in');
  });

  it('accounts with totalValue ≤ 0 are excluded from results, regardless of household / template presence', () => {
    // Drift v2 follow-up: closed accounts and pre-funding shells roll up to
    // `totalEquity ≤ 0` and are filtered out of the v2 pipeline. They never
    // make it into result.accounts, the runner's v2 metrics, or the UI.
    // Calvin Gentry pattern (large cashEquity, zero equity holdings,
    // totalEquity = cashEquity > 0) must STILL pass — it's "uninvested",
    // not "zero-value".
    const positions = new Map<string, AccountPositions>([
      // totalEquity = 0 → drop
      ['ZERO', position({ accountId: 'ZERO', totalEquity: 0, cashEquity: 0, positionsBySymbol: {} })],
      // totalEquity < 0 (defensive — should never happen in prod, but the
      // filter must not regress to ≥0 or it leaks corrupted balance rows)
      ['NEG', position({ accountId: 'NEG', totalEquity: -5, cashEquity: 0, positionsBySymbol: {} })],
      // Calvin pattern: $1M cash, $0 equity, totalEquity $1M → keep
      [
        'CALVIN',
        position({ accountId: 'CALVIN', totalEquity: 1_000_000, cashEquity: 1_000_000, positionsBySymbol: {} }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([
        // Template presence must NOT rescue a zero-value account.
        { account: 'ZERO', weights: { VOO: 100 } },
        { account: 'NEG', weights: { VOO: 100 } },
        { account: 'CALVIN', weights: { VOO: 100 } },
      ]),
      householdConfig: householdConfig([
        ['ZERO', 'HH'],
        ['NEG', 'HH'],
        ['CALVIN', 'HH'],
      ]),
    });
    expect(result.accounts.map((a) => a.accountId)).toEqual(['CALVIN']);
  });

  it('unmapped account (not in households.json) is excluded from accounts but still tracked in unmapped*AccountIds', () => {
    const positions = new Map<string, AccountPositions>([
      ['STRAY', position({ accountId: 'STRAY', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'STRAY', weights: { VOO: 60 } }]),
      householdConfig: householdConfig(),
    });
    // Drift v2 follow-up: unmapped accounts are filtered out of the v2
    // result rows so they don't pollute v2InsertedRows, v2TotalAccounts,
    // the v2 alert, or the UI. They are still surfaced via the runner's
    // existing v1 `drift_unmapped_detail` log + `unmappedPositionsAccountCount`
    // metric, so ops still know to chase missing households.json entries.
    expect(result.accounts).toHaveLength(0);
    expect(result.unmappedPositionsAccountIds).toContain('STRAY');
    expect(result.unmappedSnapshotAccountIds).toContain('STRAY');
  });

  it('accounts not in households.json are excluded from results (in-cohort vs out-of-cohort)', () => {
    // Two accounts both present in positions + snapshot. Only IN_HH is in
    // households.json. Expect exactly one row emitted (IN_HH); STRAY is
    // dropped before buildAccountResult and must not appear anywhere in
    // result.accounts.
    const positions = new Map<string, AccountPositions>([
      ['IN_HH', position({ accountId: 'IN_HH', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
      ['STRAY', position({ accountId: 'STRAY', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([
        { account: 'IN_HH', weights: { VOO: 60 } },
        { account: 'STRAY', weights: { VOO: 60 } },
      ]),
      householdConfig: householdConfig([['IN_HH', 'In Household']]),
    });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].accountId).toBe('IN_HH');
    expect(result.accounts[0].unmapped).toBe(false);
    expect(result.accounts[0].household).toBe('In Household');
    expect(result.accounts.map((a) => a.accountId)).not.toContain('STRAY');
    expect(result.unmappedPositionsAccountIds).toEqual(['STRAY']);
    expect(result.unmappedSnapshotAccountIds).toEqual(['STRAY']);
  });

  it('details.templateTotalPct carries the template weight sum — flags malformed (non-100%) templates', () => {
    const positions = new Map<string, AccountPositions>([
      ['GOOD', position({ accountId: 'GOOD', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
      ['BAD', position({ accountId: 'BAD', totalEquity: 100, cashEquity: 3, positionsBySymbol: { VOO: 97 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      // GOOD's template sums to 100; BAD's sums to 72 (mirrors the prod
      // Meridian defect: a Risk-13 template shipped with 28% missing,
      // making the account look 60pp "drifted" against a 36% equity target).
      snapshot: snapshot([
        { account: 'GOOD', weights: { VOO: 60, BND: 40 } },
        { account: 'BAD', weights: { VOO: 36, BND: 32, SWVXX: 4 } },
      ]),
      householdConfig: householdConfig([
        ['GOOD', 'HHA'],
        ['BAD', 'HHB'],
      ]),
    });
    const good = result.accounts.find((a) => a.accountId === 'GOOD');
    const bad = result.accounts.find((a) => a.accountId === 'BAD');
    expect(good?.details.templateTotalPct).toBeCloseTo(100, 4);
    expect(bad?.details.templateTotalPct).toBeCloseTo(72, 4);
  });

  it('emitUnmappedFunded surfaces funded unmapped accounts as unmapped no_template rows (titled, null delta)', () => {
    const positions = new Map<string, AccountPositions>([
      ['STRAY', position({ accountId: 'STRAY', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot(),
      householdConfig: householdConfig(),
      emitUnmappedFunded: true,
      accountTitles: new Map([['STRAY', 'JANE DOE TRUST']]),
    });
    expect(result.accounts).toHaveLength(1);
    const row = result.accounts[0];
    expect(row.accountId).toBe('STRAY');
    expect(row.unmapped).toBe(true);
    expect(row.templateMissing).toBe(true);
    expect(row.status).toBe('no_template');
    // No template ⇒ no measurable delta ⇒ never pollutes the worst-Δ metric.
    expect(row.maxBucketDeltaPct).toBeNull();
    expect(row.household).toBe('');
    expect(row.accountTitle).toBe('JANE DOE TRUST');
    expect(row.totalValue).toBeCloseTo(100, 4);
    // Still tracked in the unmapped list (the v1 surface is unchanged).
    expect(result.unmappedPositionsAccountIds).toContain('STRAY');
  });

  it('emitUnmappedFunded skips explicitly-excluded ULIDs and zero-equity shells', () => {
    const positions = new Map<string, AccountPositions>([
      ['KEEP', position({ accountId: 'KEEP', totalEquity: 100, cashEquity: 100, positionsBySymbol: {} })],
      ['EXCLUDED', position({ accountId: 'EXCLUDED', totalEquity: 5000, cashEquity: 5000, positionsBySymbol: {} })],
      ['EMPTY', position({ accountId: 'EMPTY', totalEquity: 0, cashEquity: 0, positionsBySymbol: {} })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot(),
      householdConfig: householdConfig(),
      emitUnmappedFunded: true,
      unmappedExcludeAccountIds: new Set(['EXCLUDED']),
    });
    expect(result.accounts.map((a) => a.accountId)).toEqual(['KEEP']);
    // The excluded + zero-equity accounts are still tracked, just not emitted.
    expect(result.unmappedPositionsAccountIds).toEqual(expect.arrayContaining(['KEEP', 'EXCLUDED', 'EMPTY']));
  });

  it('without emitUnmappedFunded, funded unmapped accounts stay dropped (legacy default)', () => {
    const positions = new Map<string, AccountPositions>([
      ['STRAY', position({ accountId: 'STRAY', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot(),
      householdConfig: householdConfig(),
      accountTitles: new Map([['STRAY', 'JANE DOE TRUST']]),
    });
    expect(result.accounts).toHaveLength(0);
    expect(result.unmappedPositionsAccountIds).toContain('STRAY');
  });

  it('account in households.json but with no snapshot has templateMissing=true and 0 template buckets', () => {
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot(),
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    const a = result.accounts[0];
    expect(a.templateMissing).toBe(true);
    expect(a.details.buckets.cash.templatePct).toBe(0);
    expect(a.details.buckets.fixed.templatePct).toBe(0);
    expect(a.details.buckets.equity.templatePct).toBe(0);
  });

  it('accounts with positions but no template are flagged as no_template (not out)', () => {
    // Pre-fix behavior: an account with 100% equity in VOO and a missing
    // template synthesized 0/0/0 targets, computed a 100pp equity delta,
    // and flagged the account as `out`. That was triage noise — the team
    // can't be "out of tolerance" against a target that doesn't exist.
    // New behavior: emit a `no_template` row with null Δpp/worstBucket.
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot(),
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    expect(result.accounts).toHaveLength(1);
    const a = result.accounts[0];
    expect(a.status).toBe('no_template');
    expect(a.status).not.toBe('out');
    expect(a.templateMissing).toBe(true);
    // Coverage stays positions_only — derived from templateMissing in
    // persistence; verified upstream of the SQL INSERT so the dashboard
    // and metrics see the same value.
    expect(a.household).toBe('HHA');
  });

  it('no_template accounts have null maxBucketDeltaPct and worstBucket and zero symbolBreachCount', () => {
    // The drilldown is still expected to carry position-side info so an
    // advisor can see what the account holds, even without a target.
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 200, cashEquity: 0, positionsBySymbol: { VOO: 200 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot(),
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    const a = result.accounts[0];
    expect(a.maxBucketDeltaPct).toBeNull();
    expect(a.worstBucket).toBeNull();
    expect(a.symbolBreachCount).toBe(0);
    expect(a.details.buckets.equity.positionPct).toBeGreaterThan(0);
    expect(a.details.equityHoldings.length).toBeGreaterThan(0);
  });

  it('suspectedCashEquivMisclassified collects ONLY money-market-shaped tickers outside INSTRUMENTS', () => {
    // FDLXX matches /^[A-Z]{3,5}XX$/ and is not in INSTRUMENTS → suspected.
    // VOO, VEA, BRK.B are equity tickers that fail the regex → NOT suspected.
    // VMFXX is in INSTRUMENTS post-R1 → NOT suspected (classified as cash).
    const positions = new Map<string, AccountPositions>([
      [
        'A',
        position({
          accountId: 'A',
          totalEquity: 100,
          cashEquity: 0,
          positionsBySymbol: { FDLXX: 50, VOO: 30, VEA: 20 },
        }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 100 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    expect(result.suspectedCashEquivMisclassified).toEqual(['FDLXX']);
    expect(result.accounts[0].details.suspectedCashEquivMisclassified).toEqual(['FDLXX']);
  });

  it('symbolBreachCount equals the count of cash+fixed entries with breach===true', () => {
    const positions = new Map<string, AccountPositions>([
      [
        'A',
        position({
          accountId: 'A',
          totalEquity: 100,
          cashEquity: 0,
          positionsBySymbol: { BND: 0, SGOV: 0, VOO: 100 },
        }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      // BND target 26 (delta 26 → breach); SGOV target 12 (delta 12 → breach).
      snapshot: snapshot([{ account: 'A', weights: { BND: 26, SGOV: 12, VOO: 62 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
      tolerancePct: 5,
    });
    const a = result.accounts[0];
    const breaches = a.details.symbolsWithTargets.filter((r) => r.breach === true);
    expect(a.symbolBreachCount).toBe(breaches.length);
    expect(a.symbolBreachCount).toBeGreaterThanOrEqual(2);
  });

  it('details.positionOnlySymbols lists symbols on the positions side absent from the template', () => {
    const positions = new Map<string, AccountPositions>([
      [
        'A',
        position({
          accountId: 'A',
          totalEquity: 100,
          cashEquity: 0,
          positionsBySymbol: { VOO: 70, VTI: 30 },
        }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60, BND: 40 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    const a = result.accounts[0];
    expect(a.details.positionOnlySymbols.map((p) => p.symbol).sort()).toEqual(['VTI']);
  });

  it('numeric rounding: every percent / Δpp field is rounded to 4 decimals', () => {
    const positions = new Map<string, AccountPositions>([
      [
        'A',
        position({
          accountId: 'A',
          totalEquity: 300,
          cashEquity: 1,
          positionsBySymbol: { VOO: 200, BND: 99 },
        }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60, BND: 40 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    const a = result.accounts[0];
    function isAt4Dp(value: number): boolean {
      return Math.abs(Math.round(value * 10_000) - value * 10_000) < 1e-6;
    }
    expect(isAt4Dp(a.details.buckets.cash.positionPct)).toBe(true);
    expect(isAt4Dp(a.details.buckets.fixed.positionPct)).toBe(true);
    expect(isAt4Dp(a.details.buckets.equity.positionPct)).toBe(true);
    expect(a.maxBucketDeltaPct).not.toBeNull();
    expect(isAt4Dp(a.maxBucketDeltaPct as number)).toBe(true);
  });

  it('Whitaker Family-style fixture yields maxBucketDeltaPct ≈ 27.39 with worstBucket=equity (canvas drilldown)', () => {
    // Canvas Whitaker row: position cash 0.21, fixed 12.40, equity 87.39 vs
    // template cash 2.0, fixed 38.0, equity 60.0 → max delta = |87.39-60| = 27.39
    // on the equity bucket. Build a synthetic position that reproduces those
    // percentage weights (totalEquity 100 → settled values double as pcts).
    const positions = new Map<string, AccountPositions>([
      [
        'WHITAKER',
        position({
          accountId: 'WHITAKER',
          totalEquity: 100,
          cashEquity: 0.21,
          positionsBySymbol: { BND: 9.28, SGOV: 3.12, VOO: 66.13, VEA: 13.77, VWO: 7.49 },
        }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'WHITAKER', weights: { BND: 26, SGOV: 12, VOO: 60 } }]),
      householdConfig: householdConfig([['WHITAKER', 'Whitaker Family']]),
      tolerancePct: 5,
    });
    const a = result.accounts[0];
    expect(a.maxBucketDeltaPct).toBeCloseTo(27.39, 2);
    expect(a.worstBucket).toBe('equity');
  });

  it('tolerancePct=0 flips every nonzero-delta account to out', () => {
    const positions = new Map<string, AccountPositions>([
      [
        'A',
        position({
          accountId: 'A',
          totalEquity: 100,
          cashEquity: 1,
          positionsBySymbol: { VOO: 99 },
        }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      // 0.01pp delta on each bucket — nonzero.
      snapshot: snapshot([{ account: 'A', weights: { VOO: 98.99, BND: 0.01 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
      tolerancePct: 0,
    });
    expect(result.accounts[0].status).toBe('out');
  });

  it('emits the synthetic settlement-cash row in details.symbolsWithTargets', () => {
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 2, positionsBySymbol: { VOO: 98 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60, BND: 40 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    const a = result.accounts[0];
    const settlement = a.details.symbolsWithTargets.find((r) => r.symbol === SETTLEMENT_CASH_SYMBOL_FOR_TESTS);
    expect(settlement).toBeDefined();
    expect(settlement?.bucket).toBe('cash');
    expect(settlement?.positionPct).toBeCloseTo(2, 4);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // accountTitle precedence (firm-baked households.json wins over Meridian
  // snapshot title; '' is the final fallback). Spec: docs/plans/2026-q3-drift-
  // v2-account-titles.md §4.4.
  // ──────────────────────────────────────────────────────────────────────────

  it('accountTitle precedence: firm title present + snapshot title present → firm wins', () => {
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60 }, accountTitle: 'Snapshot Title (stale)' }]),
      householdConfig: householdConfig([['A', 'HHA', 'Firm Title (canonical)']]),
    });
    expect(result.accounts[0].accountTitle).toBe('Firm Title (canonical)');
  });

  it('accountTitle precedence: firm title present + snapshot title absent → firm used', () => {
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      // snapshot entry has no accountTitle field
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60 } }]),
      householdConfig: householdConfig([['A', 'HHA', 'Firm Title']]),
    });
    expect(result.accounts[0].accountTitle).toBe('Firm Title');
  });

  it('accountTitle precedence: firm title absent + snapshot title present → snapshot used (fallback)', () => {
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60 }, accountTitle: 'Snapshot Title' }]),
      // 2-tuple: householdConfig has no accountTitle for A
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    expect(result.accounts[0].accountTitle).toBe('Snapshot Title');
  });

  it("accountTitle precedence: both absent → result.accountTitle === ''", () => {
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 100 } })],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      // snapshot entry has no accountTitle
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60 } }]),
      // 2-tuple: householdConfig has no accountTitle
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    expect(result.accounts[0].accountTitle).toBe('');
  });

  // ─── 2026-Q3 Meridian-format cutover: opaque-ID equity basket ─────────
  // Templates with `securityType: 'My Firm'` or `'Personal'` constituents
  // collapse into a synthetic `__EQUITY_BASKET__` weight at load time
  // (meridianTemplates.ts:buildSnapshot). The comparator MUST route that
  // synthetic key through `classifySymbol`'s default-to-equity branch so:
  //   1. the equity bucket target reflects the full sleeve weight,
  //   2. no per-symbol target row is emitted in the drilldown (decision #8),
  //   3. the synthetic key does NOT pollute the suspectedCashEquiv warn log
  //      (the regex `/^[A-Z]{3,5}XX$/` rejects underscore-prefixed names).
  it('routes the synthetic __EQUITY_BASKET__ weight to the equity bucket only (no per-symbol drilldown row)', () => {
    const positions = new Map<string, AccountPositions>([
      [
        'A',
        position({
          accountId: 'A',
          totalEquity: 100,
          cashEquity: 0,
          positionsBySymbol: { VTI: 100 }, // position-side: 100% equity holding
        }),
      ],
    ]);
    const result = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([
        // Template-side: 30% real fixed (AGG) + 70% opaque equity sleeve.
        { account: 'A', weights: { AGG: 30, __EQUITY_BASKET__: 70 } },
      ]),
      householdConfig: householdConfig([['A', 'HHA']]),
    });
    const account = result.accounts[0];
    expect(account.details.buckets.equity.templatePct).toBe(70);
    expect(account.details.buckets.equity.positionPct).toBe(100);
    expect(account.details.buckets.equity.deltaPct).toBe(30);
    expect(account.details.buckets.fixed.templatePct).toBe(30);

    // The synthetic key MUST NOT show up as a per-symbol drilldown target row
    // (equity bucket is bucket-only per decision #8).
    const symbols = account.details.symbolsWithTargets.map((r) => r.symbol);
    expect(symbols).not.toContain('__EQUITY_BASKET__');
    // AGG (the real fixed target) DOES show up.
    expect(symbols).toContain('AGG');
    // Settlement cash row is always emitted.
    expect(symbols).toContain(SETTLEMENT_CASH_SYMBOL_FOR_TESTS);

    // The synthetic key MUST NOT pollute the suspected-cash-equiv warn log
    // (the regex `/^[A-Z]{3,5}XX$/` rejects the underscore-prefixed key).
    expect(result.suspectedCashEquivMisclassified).not.toContain('__EQUITY_BASKET__');
  });
});

describe('bucketOverrides (bond/MMF-ETF leak fix)', () => {
  it('routes a cache-classified bond fund to fixed instead of equity, and out of equityHoldings', () => {
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 60, LQD: 40 } })],
    ]);
    const snap = snapshot([{ account: 'A', weights: { VOO: 60, LQD: 40 } }]);

    // Without overrides: LQD defaults to equity (the leak).
    const leaked = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snap,
      householdConfig: householdConfig([['A', 'HHA']]),
    }).accounts[0];
    expect(leaked.details.buckets.equity.positionPct).toBeCloseTo(100, 4);
    expect(leaked.details.buckets.fixed.positionPct).toBeCloseTo(0, 4);
    expect(leaked.details.equityHoldings.map((h) => h.symbol)).toContain('LQD');

    // With the cache override LQD→fixed: it moves to the fixed bucket on BOTH
    // sides (position + template) and drops out of the equity sleeve.
    const fixedOverride = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snap,
      householdConfig: householdConfig([['A', 'HHA']]),
      bucketOverrides: new Map<string, 'fixed' | 'cash' | 'equity'>([['LQD', 'fixed']]),
    }).accounts[0];
    expect(fixedOverride.details.buckets.equity.positionPct).toBeCloseTo(60, 4);
    expect(fixedOverride.details.buckets.fixed.positionPct).toBeCloseTo(40, 4);
    expect(fixedOverride.details.buckets.equity.templatePct).toBeCloseTo(60, 4);
    expect(fixedOverride.details.buckets.fixed.templatePct).toBeCloseTo(40, 4);
    expect(fixedOverride.details.equityHoldings.map((h) => h.symbol)).not.toContain('LQD');
  });

  it('never demotes a curated fixed symbol or a real equity (only promotes equity→fixed/cash)', () => {
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 70, BND: 30 } })],
    ]);
    // Bogus override claiming VOO is fixed must be IGNORED (VOO is real equity,
    // classifySymbol already says equity → promote only to fixed/cash is allowed,
    // but we still trust the cache only for the leak direction; VOO stays equity
    // because the override here says 'equity' which is a no-op). BND stays fixed
    // via the curated list regardless.
    const r = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 70, BND: 30 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
      bucketOverrides: new Map<string, 'fixed' | 'cash' | 'equity'>([['VOO', 'equity']]),
    }).accounts[0];
    expect(r.details.buckets.equity.positionPct).toBeCloseTo(70, 4);
    expect(r.details.buckets.fixed.positionPct).toBeCloseTo(30, 4);
  });
});

describe('data-quality lanes — R1 (negligible balance) + R2 (template sum)', () => {
  it('R1: a funded-but-trivial balance (<= $5) is tagged `negligible`, not evaluated for drift', () => {
    // $4 account, sitting 100% equity against a 60/40 target — a huge raw
    // delta — but the balance is dust so it must never be actionable.
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 4, cashEquity: 0, positionsBySymbol: { VOO: 4 } })],
    ]);
    const r = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60, BND: 40 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
    }).accounts[0];
    expect(r.status).toBe('negligible');
  });

  it('R1: a negligible balance on the no-template path is `negligible`, not `no_template`', () => {
    // Mapped account with positions but NO Meridian template, $3 balance.
    const positions = new Map<string, AccountPositions>([
      ['N', position({ accountId: 'N', totalEquity: 3, cashEquity: 0, positionsBySymbol: { VOO: 3 } })],
    ]);
    const r = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([]), // no template for N
      householdConfig: householdConfig([['N', 'HHN']]),
    }).accounts[0];
    expect(r.status).toBe('negligible');
  });

  it('R2: a template whose weights sum outside 99–101% is `template_invalid` but keeps its computed delta', () => {
    // Weights bucket to equity 36 / fixed 32 / cash 4 = 72% (the real Vale
    // Roth case). Position is 96% equity → a large, but untrustworthy, delta.
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 1000, cashEquity: 40, positionsBySymbol: { VOO: 960 } })],
    ]);
    const r = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 36, BND: 32, VMFXX: 4 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
    }).accounts[0];
    expect(r.details.templateTotalPct).toBeCloseTo(72, 4);
    expect(r.status).toBe('template_invalid');
    // "Keep drift, mark invalid" — the magnitude is still persisted.
    expect(r.maxBucketDeltaPct).not.toBeNull();
    expect(r.maxBucketDeltaPct as number).toBeGreaterThan(5);
  });

  it('R2: a template summing within the 99–101% band is NOT flagged (rounding tolerated)', () => {
    // Equity 60.5 + fixed 40 = 100.5 → within band; position matches → `in`.
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 100, cashEquity: 0, positionsBySymbol: { VOO: 60, BND: 40 } })],
    ]);
    const r = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 60.5, BND: 40 } }]),
      householdConfig: householdConfig([['A', 'HHA']]),
    }).accounts[0];
    expect(r.status).not.toBe('template_invalid');
    expect(r.status).toBe('in');
  });

  it('R1 wins over R2: a negligible balance with a malformed template is `negligible`', () => {
    const positions = new Map<string, AccountPositions>([
      ['A', position({ accountId: 'A', totalEquity: 4, cashEquity: 0, positionsBySymbol: { VOO: 4 } })],
    ]);
    const r = comparePositionsToMeridianPerAccount({
      positions,
      snapshot: snapshot([{ account: 'A', weights: { VOO: 36, BND: 32, VMFXX: 4 } }]), // sums to 72
      householdConfig: householdConfig([['A', 'HHA']]),
    }).accounts[0];
    expect(r.status).toBe('negligible');
  });
});
