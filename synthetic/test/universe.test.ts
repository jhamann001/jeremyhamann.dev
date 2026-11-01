import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildUniverse, serialize, HOUSEHOLD_COUNT } from '../src/build.js';

const u = buildUniverse();
const json = serialize(u);

describe('determinism', () => {
  it('produces byte-identical output on every run', () => {
    expect(serialize(buildUniverse())).toBe(json);
  });
  it('matches the committed out/universe.json (run `npm run generate -w synthetic` if this fails)', () => {
    expect(readFileSync(new URL('../out/universe.json', import.meta.url), 'utf8')).toBe(json);
  });
});

describe('everything is obviously fake', () => {
  it('uses example.com for every email', () => {
    for (const p of u.people) expect(p.email).toMatch(/^[a-z0-9.]+@example\.com$/);
  });
  it('uses the reserved 555-01xx phone range', () => {
    for (const p of u.people) expect(p.phone).toMatch(/^\(\d{3}\) 555-01\d{2}$/);
  });
  it('uses DEMO- account numbers, all unique', () => {
    for (const a of u.accounts) expect(a.number).toMatch(/^DEMO-\d{6}$/);
    expect(new Set(u.accounts.map((a) => a.number)).size).toBe(u.accounts.length);
  });
  it('contains nothing shaped like an SSN', () => {
    expect(json).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
  });
});

describe('shape', () => {
  it(`has ${HOUSEHOLD_COUNT} households and roughly 100 accounts`, () => {
    expect(u.households).toHaveLength(HOUSEHOLD_COUNT);
    expect(u.accounts.length).toBeGreaterThanOrEqual(85);
    expect(u.accounts.length).toBeLessThanOrEqual(120);
  });
  it('has unique household and person ids', () => {
    expect(new Set(u.households.map((h) => h.id)).size).toBe(u.households.length);
    expect(new Set(u.people.map((p) => p.id)).size).toBe(u.people.length);
  });
  it('references only things that exist', () => {
    const households = new Set(u.households.map((h) => h.id));
    const symbols = new Set(u.securities.map((s) => s.symbol));
    const custodians = new Set([u.clearingFirm.id, ...u.custodians.map((c) => c.id)]);
    const staff = new Set(u.staff.map((s) => s.id));
    const models = new Set(u.models.map((m) => m.id));
    for (const a of u.accounts) {
      expect(households.has(a.household)).toBe(true);
      expect(custodians.has(a.custodian)).toBe(true);
      expect(models.has(a.model)).toBe(true);
    }
    for (const h of u.holdings) expect(symbols.has(h.symbol)).toBe(true);
    for (const h of u.households) expect(staff.has(h.advisor)).toBe(true);
    for (const list of Object.values(u.stories)) for (const s of list) expect(households.has(s.household)).toBe(true);
  });
  it('has model weights that sum to 1', () => {
    for (const m of u.models) expect(Object.values(m.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });
});

describe('numbers reconcile', () => {
  it('fills every account to exactly its value', () => {
    for (const a of u.accounts) {
      const sum = u.holdings.filter((h) => h.account === a.id).reduce((t, h) => t + h.value, 0);
      expect(Math.round(sum * 100)).toBe(Math.round(a.value * 100));
    }
  });
  it('has statement positions that add up to each statement account total', () => {
    for (const s of u.stories.statements) {
      for (const acct of ('accounts' in s ? s.accounts : []) ?? []) {
        const sum = acct.positions.reduce((t, p) => t + p.value, 0);
        expect(Math.round(sum * 100)).toBe(Math.round(acct.total * 100));
      }
    }
  });
});

describe('the cross-app story holds together', () => {
  const all = Object.values(u.stories).flat() as { id: string; links?: string[] }[];
  const ids = new Set(all.map((s) => s.id));
  it('only links to records that exist', () => {
    for (const s of all) for (const l of s.links ?? []) expect(ids.has(l)).toBe(true);
  });
  it('ties the Alvarez wire to its cash raise', () => {
    const hd = u.stories.helpdesk.find((t) => t.id === 'HD-2479')!;
    const tr = u.stories.trade.find((t) => t.id === 'TR-1046')!;
    expect(hd.household).toBe('alvarez');
    expect(tr.amount).toBe(85000);
    expect(tr.links).toContain('HD-2479');
  });
  it('ties the Okafor transfer to its statement', () => {
    const t = u.stories.transfers.find((x) => x.id === 'T-298')!;
    const s = u.stories.statements.find((x) => x.id === 's1')!;
    expect(t.household).toBe('okafor');
    expect(s.household).toBe('okafor');
    expect('accounts' in s && s.accounts?.[0].total).toBe(412880.4);
  });
});
