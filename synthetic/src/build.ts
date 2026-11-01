// Builds the shared synthetic universe: one fictional advisory firm whose households appear in every demo.
// Pure and deterministic: the same world.json and seed always produce byte-identical output.

import { readFileSync } from 'node:fs';
import { Faker, en } from '@faker-js/faker';

export const SEED = 20261025;
export const HOUSEHOLD_COUNT = 40;

type World = typeof import('../world.json');
type AccountType = 'individual' | 'joint-taxable' | 'traditional-ira' | 'roth-ira' | 'rollover-ira' | 'sep-ira' | 'trust';

export interface Person { id: string; household: string; first: string; last: string; suffix?: string; email: string; phone: string }
export interface Account { id: string; number: string; household: string; type: AccountType; custodian: string; model: string; value: number }
export interface Holding { account: string; symbol: string; quantity: number; value: number }

const ACCOUNT_TYPES: AccountType[] = ['individual', 'joint-taxable', 'traditional-ira', 'roth-ira', 'rollover-ira', 'sep-ira'];
const AREA_CODES = ['206', '303', '312', '404', '503', '512', '612', '617', '704', '919'];

const round2 = (n: number) => Math.round(n * 100) / 100;
const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function loadWorld(): World {
  return JSON.parse(readFileSync(new URL('../world.json', import.meta.url), 'utf8'));
}

export function buildUniverse(world: World = loadWorld()) {
  const faker = new Faker({ locale: [en] });
  faker.seed(SEED);

  const price = new Map(world.securities.map((s) => [s.symbol, s.price]));
  const models = new Map(world.models.map((m) => [m.id, m]));
  const advisors = world.staff.filter((s) => s.role === 'advisor').map((s) => s.id);

  const people: Person[] = [];
  const accounts: Account[] = [];
  const holdings: Holding[] = [];
  const households: { id: string; name: string; advisor: string; model: string; story: boolean }[] = [];

  let phoneSeq = 0;
  let accountSeq = 0;
  const usedEmails = new Set<string>();

  const addPerson = (household: string, first: string, last: string, suffix?: string) => {
    let email = `${slug(first)}.${slug(last)}@example.com`;
    for (let n = 2; usedEmails.has(email); n++) email = `${slug(first)}.${slug(last)}${n}@example.com`;
    usedEmails.add(email);
    const phone = `(${AREA_CODES[phoneSeq % AREA_CODES.length]}) 555-01${String(phoneSeq % 100).padStart(2, '0')}`;
    phoneSeq++;
    const p: Person = { id: `${household}-${slug(first)}`, household, first, last, ...(suffix ? { suffix } : {}), email, phone };
    people.push(p);
  };

  // Fill an account with its model's weights at today's illustrative prices; leftovers go to the money fund.
  const fillAccount = (acct: Account) => {
    const model = models.get(acct.model)!;
    let invested = 0;
    for (const [symbol, weight] of Object.entries(model.weights)) {
      if (symbol === 'SWVXX') continue;
      const px = price.get(symbol)!;
      const quantity = Math.floor((acct.value * weight) / px);
      if (quantity <= 0) continue;
      const value = round2(quantity * px);
      invested += value;
      holdings.push({ account: acct.id, symbol, quantity, value });
    }
    const cash = round2(acct.value - invested);
    holdings.push({ account: acct.id, symbol: 'SWVXX', quantity: cash, value: cash });
  };

  const addAccount = (household: string, type: AccountType, value: number, model: string, suffix?: string) => {
    accountSeq++;
    const tail = suffix ?? String(1000 + ((accountSeq * 7919) % 9000)).padStart(4, '0');
    const acct: Account = {
      id: `acct-${String(accountSeq).padStart(3, '0')}`,
      number: `DEMO-${String(10 + (accountSeq % 90)).padStart(2, '0')}${tail}`,
      household, type, custodian: world.clearingFirm.id, model, value,
    };
    accounts.push(acct);
    fillAccount(acct);
  };

  // Story households first, exactly as written in world.json.
  for (const h of world.storyHouseholds) {
    households.push({ id: h.id, name: h.name, advisor: h.advisor, model: h.model, story: true });
    for (const m of h.members) addPerson(h.id, m.first, m.last, (m as { suffix?: string }).suffix);
    for (const a of h.accounts) addAccount(h.id, a.type as AccountType, a.value, h.model, a.suffix);
  }

  // Generated households to round out the book.
  const takenLast = new Set(world.storyHouseholds.flatMap((h) => h.members.map((m) => m.last)));
  while (households.length < HOUSEHOLD_COUNT) {
    const last = faker.person.lastName();
    if (takenLast.has(last) || /[^A-Za-z' -]/.test(last)) continue;
    takenLast.add(last);
    const id = slug(last);
    const joint = faker.datatype.boolean({ probability: 0.55 });
    const model = faker.helpers.arrayElement(world.models).id;
    households.push({ id, name: `${last} Household`, advisor: faker.helpers.arrayElement(advisors), model, story: false });
    addPerson(id, faker.person.firstName(), last);
    if (joint) addPerson(id, faker.person.firstName(), last);
    const types = faker.helpers.arrayElements(ACCOUNT_TYPES.filter((t) => joint || t !== 'joint-taxable'), { min: 2, max: 3 });
    for (const t of types) {
      const value = Math.round(faker.number.int({ min: 25_000, max: 1_400_000 }) / 50) * 50;
      addAccount(id, t, value, model);
    }
  }

  const stories = world.stories;
  return {
    meta: {
      seed: SEED,
      asOf: world.asOf,
      priceNote: world.priceNote,
      note: 'Every person, household, account and number here is invented. Emails use example.com; phone numbers use the reserved 555-01xx range.',
    },
    firm: world.firm,
    clearingFirm: world.clearingFirm,
    modelProvider: world.modelProvider,
    custodians: world.custodians,
    staff: world.staff,
    securities: world.securities,
    models: world.models,
    households,
    people,
    accounts,
    holdings,
    stories,
  };
}

export type Universe = ReturnType<typeof buildUniverse>;
export const serialize = (u: Universe) => `${JSON.stringify(u, null, 2)}\n`;
