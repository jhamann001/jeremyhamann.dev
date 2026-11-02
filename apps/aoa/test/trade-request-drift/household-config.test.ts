import { describe, it, expect } from 'vitest';
import { HouseholdConfigError, HouseholdEntrySchema, isTaxableAccount } from '@/lib/trade-requests/sources/household-config';

/**
 * 2026-Q3 Meridian-format cutover: this file used to test
 * `loadHouseholdConfig()` and `_loadHouseholdConfigFrom()` against the
 * committed `server/src/config/households.json`. Both helpers + the JSON file
 * are deleted (see `docs/plans/2026-q3-drift-v2-meridian-format-cutover.md`).
 *
 * Test coverage migrated:
 *   - "parses well-formed file" / "missing field" / "blank householdName" /
 *     "duplicate accountNumber" / "empty array" → moved to
 *     `meridianActiveAccounts.test.ts` against the new wire shape
 *     (ULIDs + household_id + household_name).
 *   - "loads committed config" / "returns cached config" → DELETED. The
 *     active_accounts loader has no module-level cache and is fetched once
 *     per drift run from GCS.
 *
 * What this file still covers:
 *   - `HouseholdConfigError` is still exported and `instanceof`-able.
 *   - `HouseholdEntrySchema` accepts the new `householdId?: number` field
 *     (added in the cutover) without breaking back-compat for fixtures
 *     that omit it (test runner mocks, etc.).
 */

describe('HouseholdConfigError', () => {
  it('is an Error subclass with the canonical `name`', () => {
    const err = new HouseholdConfigError('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HouseholdConfigError');
    expect(err.message).toBe('boom');
  });
});

describe('HouseholdEntrySchema', () => {
  it('parses the canonical legacy shape (no householdId)', () => {
    const parsed = HouseholdEntrySchema.parse({
      accountNumber: '**A1',
      householdName: 'Bogisich Family',
      accountTitle: 'Brandy',
    });
    expect(parsed.householdId).toBeUndefined();
  });

  it('parses the new active_accounts shape (householdId present)', () => {
    const parsed = HouseholdEntrySchema.parse({
      accountNumber: '01SYNTHJ7G094TRY2A6R126CB3',
      householdName: 'Kuhlman + Borer Family',
      accountTitle: 'Abdul Kuhlman - Brokerage',
      householdId: 3027,
    });
    expect(parsed.householdId).toBe(3027);
  });

  it('rejects blank householdName', () => {
    expect(() => HouseholdEntrySchema.parse({ accountNumber: '**A1', householdName: '   ' })).toThrow();
  });

  it('rejects a non-positive householdId', () => {
    expect(() => HouseholdEntrySchema.parse({ accountNumber: '**A1', householdName: 'X', householdId: 0 })).toThrow();
    expect(() => HouseholdEntrySchema.parse({ accountNumber: '**A1', householdName: 'X', householdId: -5 })).toThrow();
  });

  it('rejects a non-integer householdId', () => {
    expect(() =>
      HouseholdEntrySchema.parse({ accountNumber: '**A1', householdName: 'X', householdId: 3.14 }),
    ).toThrow();
  });
});

describe('isTaxableAccount', () => {
  it('keys on ownership_type when present — only RETIREMENT is non-taxable', () => {
    expect(isTaxableAccount('INDIVIDUAL', undefined)).toBe(true);
    expect(isTaxableAccount('JOINT', undefined)).toBe(true);
    expect(isTaxableAccount('ENTITY', undefined)).toBe(true);
    expect(isTaxableAccount('RETIREMENT', undefined)).toBe(false);
    expect(isTaxableAccount('retirement', undefined)).toBe(false); // case-insensitive
  });

  it('ownership_type overrides a conflicting account_type string', () => {
    // RETIREMENT wins even if account_type looks taxable.
    expect(isTaxableAccount('RETIREMENT', 'NA')).toBe(false);
    // INDIVIDUAL wins even if account_type looks non-taxable.
    expect(isTaxableAccount('INDIVIDUAL', 'NA non-taxable')).toBe(true);
  });

  it('falls back to the account_type string when ownership_type is absent', () => {
    expect(isTaxableAccount(undefined, 'NA')).toBe(true);
    expect(isTaxableAccount(undefined, 'S1')).toBe(true);
    expect(isTaxableAccount(undefined, 'FB')).toBe(true);
    expect(isTaxableAccount(undefined, 'NA non-taxable')).toBe(false);
    // The bug the ownership_type field caught: bare "IRA" must be non-taxable.
    expect(isTaxableAccount(undefined, 'IRA')).toBe(false);
    expect(isTaxableAccount(undefined, 'Roth IRA')).toBe(false);
  });

  it('treats unknown (both absent) as NOT taxable — conservative, never false-flags', () => {
    expect(isTaxableAccount(undefined, undefined)).toBe(false);
    expect(isTaxableAccount('', '')).toBe(false);
  });
});
