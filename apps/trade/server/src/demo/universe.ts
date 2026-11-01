// The shared synthetic universe (synthetic/out/universe.json) and the rules that map it onto this app:
// client ids, account ids, account types and titles. The demo seed and the stand-ins both read through
// here, so a client or account carries the same id in the database, the warehouse and the model feeds.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AccountType, Residence } from '@trade-request/shared';

// ─── Universe shape (only the parts this app reads) ──────────────────────────

export interface UniverseHousehold { id: string; name: string; advisor: string; model: string; story: boolean }
export interface UniversePerson { household: string; first: string; last: string; email: string }
export interface UniverseAccount { id: string; number: string; household: string; type: string; value: number }
export interface UniverseHolding { account: string; symbol: string; quantity: number; value: number }
export interface UniverseSecurity { symbol: string; name: string; assetClass: string; vehicle: string; price: number }
export interface UniverseModel { id: string; name: string; weights: Record<string, number> }
export interface UniverseStaff { id: string; name: string; role: string; title: string }
export interface UniverseTradeStory { id: string; household: string; type: string; amount: number | null; status: string; advisor: string }
export interface Universe {
  meta: { asOf: string };
  households: UniverseHousehold[];
  people: UniversePerson[];
  accounts: UniverseAccount[];
  holdings: UniverseHolding[];
  securities: UniverseSecurity[];
  models: UniverseModel[];
  staff: UniverseStaff[];
  stories: { trade: UniverseTradeStory[] };
}

export function loadUniverse(path = process.env.DEMO_UNIVERSE_PATH): Universe {
  const file = path ?? fileURLToPath(new URL('../../../../../synthetic/out/universe.json', import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Universe;
}

let cachedUniverse: Universe | null = null;
/** The universe, read once per process. */
export function demoUniverse(): Universe {
  cachedUniverse ??= loadUniverse();
  return cachedUniverse;
}

/** The app's users: the firm's advisors and traders. They are also the demo's sign-in personas. */
export const appStaff = (u: Universe): UniverseStaff[] => u.staff.filter((s) => s.role === 'advisor' || s.role === 'trader');
export const staffEmail = (s: UniverseStaff): string => `${s.name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;

// ─── Mapping rules ─────────────────────────────────────────────────

export const ACCOUNT_TYPE: Record<string, AccountType> = {
  'joint-taxable': 'Joint',
  individual: 'Taxable',
  trust: 'Taxable',
  'traditional-ira': 'Traditional IRA',
  'rollover-ira': 'Traditional IRA',
  'sep-ira': 'Traditional IRA',
  'roth-ira': 'Roth IRA',
};

// The clearing firm's account types and ownership classes, as its feeds spell them.
const CLEARING_TYPE: Record<string, string> = {
  'joint-taxable': 'JOINT_BROKERAGE_TENANTS_WITH_RIGHT_OF_SURVIVORSHIP',
  individual: 'BROKERAGE',
  trust: 'BROKERAGE',
  'traditional-ira': 'TRADITIONAL_IRA',
  'rollover-ira': 'TRADITIONAL_IRA',
  'sep-ira': 'TRADITIONAL_IRA',
  'roth-ira': 'ROTH_IRA',
};
const OWNERSHIP: Record<string, string> = {
  'joint-taxable': 'JOINT',
  individual: 'INDIVIDUAL',
  trust: 'ENTITY',
  'traditional-ira': 'RETIREMENT',
  'rollover-ira': 'RETIREMENT',
  'sep-ira': 'RETIREMENT',
  'roth-ira': 'RETIREMENT',
};
const TITLE_SUFFIX: Record<string, string> = {
  'joint-taxable': 'Joint Brokerage Tenants With Right Of Survivorship',
  individual: 'Brokerage',
  trust: 'Trust Brokerage',
  'traditional-ira': 'Traditional IRA',
  'rollover-ira': 'Rollover IRA',
  'sep-ira': 'SEP IRA',
  'roth-ira': 'Roth IRA',
};

export const BUCKET: Record<string, 'cash' | 'fixed' | 'equity'> = {
  cash: 'cash',
  'us-bond': 'fixed',
  treasury: 'fixed',
  'corporate-bond': 'fixed',
  'muni-bond': 'fixed',
  'us-equity': 'equity',
  'intl-equity': 'equity',
  'real-estate': 'equity',
};

// Risk level by model: a deterministic spread inside each model's band.
const RISK_BAND: Record<string, [number, number]> = {
  'meridian-income': [6, 9],
  'meridian-balanced-60-40': [12, 15],
  'meridian-growth-80-20': [18, 21],
};
// Story households that live in the two states with their own models.
const STORY_RESIDENCE: Record<string, Residence> = { 'patel-trust': 'NY', brennan: 'CA' };

export function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** A well-mixed draw in [0, 1) for a key. Use it where nearby keys must not correlate. */
export function seeded(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) / 2 ** 32;
}

export const residenceFor = (householdId: string): Residence =>
  STORY_RESIDENCE[householdId] ?? (['Other', 'Other', 'Other', 'NY', 'CA'] as const)[hash(householdId) % 5];

export function riskFor(h: UniverseHousehold): number {
  const [lo, hi] = RISK_BAND[h.model] ?? [12, 15];
  return lo + (hash(h.id) % (hi - lo + 1));
}

// ─── Ids ──────────────────────────────────────────────────────

/** Client id per household, in universe order: HH-1001, HH-1002, ... */
export function clientIds(universe: Universe): Map<string, string> {
  return new Map(universe.households.map((h, i) => [h.id, `HH-${1001 + i}`]));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The clearing firm's 26-character account id (ULID-shaped), stable per universe account. */
export function accountUlid(accountId: string): string {
  const bytes = createHash('sha256').update(`account:${accountId}`).digest();
  let tail = '';
  for (let i = 0; i < 19; i++) tail += CROCKFORD[bytes[i] % 32];
  return `01SYNTH${tail}`;
}

export const clearingAccountType = (a: UniverseAccount): string => CLEARING_TYPE[a.type] ?? 'BROKERAGE';
export const ownershipType = (a: UniverseAccount): string => OWNERSHIP[a.type] ?? 'INDIVIDUAL';

/** "Lucia Alvarez & Mateo Alvarez - Joint Brokerage ...", in the model provider's title style. */
export function accountTitle(universe: Universe, a: UniverseAccount): string {
  const household = universe.households.find((h) => h.id === a.household);
  const people = universe.people.filter((p) => p.household === a.household);
  const name = (p: UniversePerson) => `${p.first} ${p.last}`;
  let owner: string;
  if (a.type === 'trust') owner = household?.name.replace(/ Family$/, ' Family Trust') ?? 'Family Trust';
  else if (a.type === 'joint-taxable' && people.length > 1) owner = `${name(people[0])} & ${name(people[1])}`;
  else {
    // Retirement accounts belong to one person; spread a household's IRAs across its people.
    const iras = universe.accounts.filter((x) => x.household === a.household && x.type !== 'joint-taxable' && x.type !== 'trust');
    const idx = Math.max(0, iras.findIndex((x) => x.id === a.id));
    owner = people.length ? name(people[idx % people.length]) : household?.name ?? 'Client';
  }
  return `${owner} - ${TITLE_SUFFIX[a.type] ?? 'Brokerage'}`;
}
