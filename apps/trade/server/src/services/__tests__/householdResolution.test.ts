import { describe, it, expect } from 'vitest';
import type { Client } from '@trade-request/shared';
import type { HouseholdConfig, HouseholdEntry } from '../householdConfig.js';
import { resolveHouseholdsForClients } from '../householdResolution.js';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function ulid(tag: string): string {
  // 26-char ULID slot; the actual format is irrelevant for the pure resolver
  // (the route is responsible for ULID validation). Using tags makes the
  // failing-test output easy to read.
  return `01JY2NPMDDS83DRA5FWXGS3${tag.padStart(3, '0').slice(0, 3)}`;
}

function client(id: string, name: string, accounts: Array<{ ulid: string; accountNumber: string }>): Client {
  return {
    id,
    name,
    accounts: accounts.map((a) => ({
      id: a.ulid,
      clientId: id,
      accountNumber: a.accountNumber,
      accountType: 'Taxable',
      balance: 100_000,
      holdings: { cash: 0, fixed: 0, equity: 100_000 },
    })),
  };
}

function entry(opts: {
  ulid: string;
  household: string;
  householdId: number | undefined;
  title?: string;
}): HouseholdEntry {
  return {
    accountNumber: opts.ulid,
    householdName: opts.household,
    accountTitle: opts.title ?? `Title-${opts.ulid.slice(-3)}`,
    householdId: opts.householdId,
  };
}

function makeConfig(entries: HouseholdEntry[]): HouseholdConfig {
  const byAccountNumber = new Map(entries.map((e) => [e.accountNumber, e] as const));
  const householdNames = new Set(entries.map((e) => e.householdName));
  return { byAccountNumber, householdNames, entries };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('resolveHouseholdsForClients', () => {
  it('returns one household with no extra accounts when the advisor picks a single-client household', () => {
    const u = ulid('A1');
    const clients = [client('CLI-1', 'Alpha One', [{ ulid: u, accountNumber: 'ACCT-A1' }])];
    const config = makeConfig([entry({ ulid: u, household: 'Alpha Household', householdId: 100 })]);

    const result = resolveHouseholdsForClients({
      clientIds: ['CLI-1'],
      accountIds: [],
      clients,
      householdConfig: config,
    });

    expect(result.households).toHaveLength(1);
    expect(result.households[0]).toMatchObject({
      householdId: 100,
      householdName: 'Alpha Household',
      clientIds: ['CLI-1'],
      selectedAccountIds: [u],
    });
    expect(result.households[0].accounts).toHaveLength(1);
    expect(result.unresolvedAccountIds).toEqual([]);
    expect(result.unresolvedClientIds).toEqual([]);
  });

  it('enumerates 3 sibling accounts in 2 other clients when picking a single client in a 4-account household', () => {
    const u1 = ulid('1');
    const u2 = ulid('2');
    const u3 = ulid('3');
    const u4 = ulid('4');
    const clients = [
      client('CLI-1', 'Alpha One', [{ ulid: u1, accountNumber: 'ACCT-1' }]),
      client('CLI-2', 'Bravo Two', [
        { ulid: u2, accountNumber: 'ACCT-2' },
        { ulid: u3, accountNumber: 'ACCT-3' },
      ]),
      client('CLI-3', 'Charlie Three', [{ ulid: u4, accountNumber: 'ACCT-4' }]),
    ];
    const config = makeConfig([
      entry({ ulid: u1, household: 'Joint Household', householdId: 200, title: 'B-Alpha' }),
      entry({ ulid: u2, household: 'Joint Household', householdId: 200, title: 'A-Bravo' }),
      entry({ ulid: u3, household: 'Joint Household', householdId: 200, title: 'C-Bravo' }),
      entry({ ulid: u4, household: 'Joint Household', householdId: 200, title: 'D-Charlie' }),
    ]);

    const result = resolveHouseholdsForClients({
      clientIds: ['CLI-1'],
      accountIds: [],
      clients,
      householdConfig: config,
    });

    expect(result.households).toHaveLength(1);
    const h = result.households[0];
    expect(h.accounts).toHaveLength(4);
    expect(h.accounts.map((a) => a.accountTitle)).toEqual(['A-Bravo', 'B-Alpha', 'C-Bravo', 'D-Charlie']);
    expect(h.clientIds).toEqual(['CLI-1', 'CLI-2', 'CLI-3']);
    expect(h.selectedAccountIds).toEqual([u1]);
  });

  it('emits 2 resolutions when picking clients in different firm households', () => {
    const uA = ulid('A1');
    const uB = ulid('B1');
    const clients = [
      client('CLI-A', 'Alpha', [{ ulid: uA, accountNumber: 'ACCT-A' }]),
      client('CLI-B', 'Bravo', [{ ulid: uB, accountNumber: 'ACCT-B' }]),
    ];
    const config = makeConfig([
      entry({ ulid: uA, household: 'Household A', householdId: 100 }),
      entry({ ulid: uB, household: 'Household B', householdId: 200 }),
    ]);

    const result = resolveHouseholdsForClients({
      clientIds: ['CLI-A', 'CLI-B'],
      accountIds: [],
      clients,
      householdConfig: config,
    });

    expect(result.households).toHaveLength(2);
    expect(result.households.map((h) => h.householdId)).toEqual([100, 200]);
    expect(result.households[0].clientIds).toEqual(['CLI-A']);
    expect(result.households[1].clientIds).toEqual(['CLI-B']);
  });

  it('reports clientIds unknown to Warehouse in unresolvedClientIds', () => {
    const clients: Client[] = [];
    const config = makeConfig([]);

    const result = resolveHouseholdsForClients({
      clientIds: ['CLI-MISSING'],
      accountIds: [],
      clients,
      householdConfig: config,
    });

    expect(result.households).toEqual([]);
    expect(result.unresolvedClientIds).toEqual(['CLI-MISSING']);
  });

  it('reports ULIDs known to Warehouse but absent from active_accounts.json in unresolvedAccountIds', () => {
    const u = ulid('Z');
    const clients = [client('CLI-1', 'Alpha', [{ ulid: u, accountNumber: 'ACCT-1' }])];
    const config = makeConfig([]);

    const result = resolveHouseholdsForClients({
      clientIds: ['CLI-1'],
      accountIds: [],
      clients,
      householdConfig: config,
    });

    expect(result.households).toEqual([]);
    expect(result.unresolvedAccountIds).toEqual([u]);
    expect(result.unresolvedClientIds).toEqual([]);
  });

  it('resolves accountId-only input (no clientIds) correctly', () => {
    const u1 = ulid('1');
    const u2 = ulid('2');
    const clients = [
      client('CLI-1', 'Alpha', [
        { ulid: u1, accountNumber: 'ACCT-1' },
        { ulid: u2, accountNumber: 'ACCT-2' },
      ]),
    ];
    const config = makeConfig([
      entry({ ulid: u1, household: 'Alpha Household', householdId: 100 }),
      entry({ ulid: u2, household: 'Alpha Household', householdId: 100 }),
    ]);

    const result = resolveHouseholdsForClients({
      clientIds: [],
      accountIds: [u1],
      clients,
      householdConfig: config,
    });

    expect(result.households).toHaveLength(1);
    expect(result.households[0].selectedAccountIds).toEqual([u1]);
    expect(result.households[0].accounts).toHaveLength(2);
  });

  it('emits resolutions for HouseholdConfig entries that have no matching Warehouse client (orphans)', () => {
    const u1 = ulid('1');
    const uOrphan = ulid('O');
    const clients = [client('CLI-1', 'Alpha', [{ ulid: u1, accountNumber: 'ACCT-1' }])];
    const config = makeConfig([
      entry({ ulid: u1, household: 'Family', householdId: 100, title: 'A-Joined' }),
      entry({ ulid: uOrphan, household: 'Family', householdId: 100, title: 'B-Orphan' }),
    ]);

    const result = resolveHouseholdsForClients({
      clientIds: ['CLI-1'],
      accountIds: [],
      clients,
      householdConfig: config,
    });

    expect(result.households).toHaveLength(1);
    const h = result.households[0];
    const orphan = h.accounts.find((a) => a.accountId === uOrphan)!;
    expect(orphan).toBeDefined();
    expect(orphan.clientId).toBeNull();
    expect(orphan.accountNumber).toBeNull();
    expect(orphan.accountType).toBeNull();
    expect(orphan.balance).toBe(0);
    expect(h.clientIds).toEqual(['CLI-1']);
  });

  it('treats HouseholdEntry.householdId === undefined as unmapped (Decision log #6)', () => {
    const u = ulid('U');
    const clients = [client('CLI-1', 'Alpha', [{ ulid: u, accountNumber: 'ACCT-1' }])];
    const config = makeConfig([entry({ ulid: u, household: 'NoIdHousehold', householdId: undefined })]);

    const result = resolveHouseholdsForClients({
      clientIds: ['CLI-1'],
      accountIds: [],
      clients,
      householdConfig: config,
    });

    expect(result.households).toEqual([]);
    expect(result.unresolvedAccountIds).toEqual([u]);
  });

  it('honors per-account deselection: explicit accountIds is the authoritative selection set', () => {
    const u1 = ulid('1');
    const u2 = ulid('2');
    const clients = [
      client('CLI-1', 'Alpha', [
        { ulid: u1, accountNumber: 'ACCT-1' },
        { ulid: u2, accountNumber: 'ACCT-2' },
      ]),
    ];
    const config = makeConfig([
      entry({ ulid: u1, household: 'Alpha Household', householdId: 100 }),
      entry({ ulid: u2, household: 'Alpha Household', householdId: 100 }),
    ]);

    const result = resolveHouseholdsForClients({
      clientIds: ['CLI-1'],
      accountIds: [u1],
      clients,
      householdConfig: config,
    });

    expect(result.households).toHaveLength(1);
    expect(result.households[0].selectedAccountIds).toEqual([u1]);
    expect(result.households[0].accounts).toHaveLength(2);
  });
});
