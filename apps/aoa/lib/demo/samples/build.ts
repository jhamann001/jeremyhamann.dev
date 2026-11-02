// Writes the demo's sample data (types.ts) from the shared universe: the showcase clients' hand-written sections
// (showcase.ts) with the advisor, AUM, tenure and risk their records give, and for everyone else a baseline drawn from
// their own household and accounts: beneficiaries on each account that takes one, an Insights profile, and the risk
// their model gives. scripts/demo-samples.ts writes the result to data/*.json; a test checks the files are current.
// Also plans each client's realized-gains budget for the seed (planning.ts). Pure: no database, no clock.

import type { Beneficiary } from "@/lib/data/types";
import type { Nudge } from "@/lib/data/workflow-types";
import { ownAccounts, type OwnAccount } from "../seed/own-accounts";
import { ACCOUNT_TYPE_LABEL, accountOwners } from "../seed/people";
import { riskFor } from "../seed/trade-requests-plan";
import { accountOpenedDaysAgo, fundedDaysAgo } from "../seed/trade-requests-own";
import {
  householdIds, membersOf, personIds, pick, seeded, seededInt, staffOf, type Universe, type UniverseAccount,
  type UniverseHousehold, type UniversePerson,
} from "../seed/universe";
import { SHOWCASE, SHOWCASE_DECISIONS, SHOWCASE_NUDGES, type ShowcaseMoment } from "./showcase";
import type { ClientSample, DemoSamples, SampleMoment, WorkflowSample } from "./types";

type Account = UniverseAccount | OwnAccount;

/** The risk band's label, as the Trade Request profile names a score (lib/data/trade-request-profile.ts). */
export function toleranceFor(score: number): string {
  if (score <= 5) return "Conservative";
  if (score <= 10) return "Moderately conservative";
  if (score <= 15) return "Moderate";
  if (score <= 20) return "Growth";
  return "Aggressive";
}

const RETIREMENT = new Set(["traditional-ira", "rollover-ira", "sep-ira", "roth-ira"]);
const CHILD_NAMES = [
  "Amelia", "Noah", "Clara", "Owen", "Isla", "Theo", "Maya", "Felix", "Ruby", "Jonah", "Elena", "Silas", "Hazel", "Miles",
  "Iris", "Callum", "Nora", "Ezra", "Lena", "Rowan",
];
const COMMUNICATION = [
  "Email; quarterly calls", "Phone first; email for documents", "Portal messages; prefers written follow-ups",
  "Text for quick questions; meets twice a year",
];
const BEHAVIOR = [
  "Long-term; low reactivity to volatility", "Checks the portfolio weekly; asks before big moves",
  "Hands-off; trusts the model", "Detail-oriented; reads every statement",
];
const GOALS: Record<string, string> = {
  "meridian-income": "Dependable income in retirement",
  "meridian-balanced-60-40": "Steady growth with volatility kept in check",
  "meridian-growth-80-20": "Long-term growth toward retirement",
};
const WORRY: Record<string, string[]> = {
  "meridian-income": ["Outliving savings", "Inflation eroding income"],
  "meridian-balanced-60-40": ["A downturn just before retirement", "Paying more tax than needed"],
  "meridian-growth-80-20": ["Taxes as the portfolio grows", "Concentration in a few holdings"],
};
const THEME: Record<string, string> = {
  "traditional-ira": "Retirement income",
  "rollover-ira": "Retirement income",
  "sep-ira": "Self-employed retirement saving",
  "roth-ira": "Tax-free growth",
  trust: "Estate planning",
  "joint-taxable": "Household planning",
  individual: "Tax-efficient investing",
};

const masked = (number: string) => `••••${number.slice(-4)}`;
const dob = (key: string, from: number, to: number) =>
  `${String(seededInt(`${key}:m`, 1, 12)).padStart(2, "0")}/${String(seededInt(`${key}:d`, 1, 28)).padStart(2, "0")}/${seededInt(`${key}:y`, from, to)}`;
const usdShort = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${Math.round(n / 1_000)}K`);
const nameOf = (p: UniversePerson) => `${p.first} ${p.last}`;

function tenureFrom(days: number): string {
  const years = Math.floor(days / 365.25);
  if (years >= 1) return `${years} year${years === 1 ? "" : "s"}`;
  const months = Math.max(1, Math.floor(days / 30.4));
  return `${months} month${months === 1 ? "" : "s"}`;
}

export interface SampleWorld {
  universe: Universe;
  own: OwnAccount[];
  personSf: Map<string, string>;
  householdSf: Map<string, string>;
  accountsOfPerson(personId: string): Account[];
  accountsOfHousehold(householdId: string): Account[];
  household(id: string): UniverseHousehold;
  account(id: string): Account;
}

export function sampleWorld(universe: Universe): SampleWorld {
  const own = ownAccounts(universe);
  const all: Account[] = [...universe.accounts, ...own];
  const ownersOf = (a: Account) => ("owner" in a ? [a.owner] : accountOwners(universe, a).map((p) => p.id));
  return {
    universe,
    own,
    personSf: personIds(universe),
    householdSf: householdIds(universe),
    accountsOfPerson: (personId) => all.filter((a) => ownersOf(a).includes(personId)),
    accountsOfHousehold: (householdId) => all.filter((a) => a.household === householdId),
    household: (id) => universe.households.find((h) => h.id === id)!,
    account: (id) => {
      const found = all.find((a) => a.id === id);
      if (!found) throw new Error(`sample account ${id} not found`);
      return found;
    },
  };
}

/** Two invented adult children per household, for beneficiaries and the Insights profile. */
function childrenOf(world: SampleWorld, household: UniverseHousehold): Array<{ name: string; first: string; dob: string }> {
  const members = membersOf(world.universe, household.id);
  const last = members[0]?.last ?? household.name.replace(/ Household$/, "");
  // Never a parent's own first name, and never the same name twice.
  const names = CHILD_NAMES.filter((n) => !members.some((m) => m.first === n));
  const first = pick(`${household.id}:child:0`, names);
  const rest = names.filter((n) => n !== first);
  const second = pick(`${household.id}:child:1`, rest);
  return [first, second].map((f, i) => ({ name: `${f} ${last}`, first: f, dob: dob(`${household.id}:child:${i}`, 1978, 2003) }));
}

function baselineBeneficiaries(world: SampleWorld, person: UniversePerson, household: UniverseHousehold): Beneficiary[] {
  const members = membersOf(world.universe, household.id);
  const partner = members.find((m) => m.id !== person.id);
  const children = childrenOf(world, household);
  const out: Beneficiary[] = [];
  for (const a of world.accountsOfPerson(person.id)) {
    if (a.type === "trust") continue;
    const acct = ACCOUNT_TYPE_LABEL[a.type] ?? "Individual";
    const num = masked(a.number);
    if (RETIREMENT.has(a.type) && partner) {
      out.push({ name: nameOf(partner), rel: "Spouse", pct: 100, dob: dob(`${partner.id}:dob`, 1950, 1974), acct, num });
    } else {
      const tod = !RETIREMENT.has(a.type);
      for (const c of children) out.push({ name: c.name, rel: tod ? "Child (TOD)" : "Child", pct: 50, dob: c.dob, acct, num });
    }
  }
  return out;
}

function baselinePortrait(world: SampleWorld, person: UniversePerson, household: UniverseHousehold): Record<string, string> {
  const partner = membersOf(world.universe, household.id).find((m) => m.id !== person.id);
  const [a, b] = childrenOf(world, household);
  const types = [...new Set(world.accountsOfHousehold(household.id).map((x) => x.type))];
  const themes = [...new Set(types.map((t) => THEME[t]).filter(Boolean))].slice(0, 3);
  return {
    Family: `${partner ? `Married to ${partner.first}` : "Single"}; two adult children, ${a.first} and ${b.first}`,
    Goals: GOALS[household.model] ?? "Long-term growth toward retirement",
    Communication: pick(`${person.id}:communication`, COMMUNICATION),
    Behavior: pick(`${person.id}:behavior`, BEHAVIOR),
    Worry: pick(`${person.id}:worry`, WORRY[household.model] ?? ["Outliving savings"]),
    Themes: themes.join(", "),
  };
}

function daysFor(world: SampleWorld, at: ShowcaseMoment["daysAgo"]): number {
  if (typeof at === "number") return at;
  if ("opened" in at) return accountOpenedDaysAgo(world.account(at.opened));
  const funded = fundedDaysAgo(world.account(at.funded));
  if (funded == null) throw new Error(`no funding request for ${at.funded}`);
  return funded;
}

/** Days the household has been a client: its oldest account's age. */
function householdTenureDays(world: SampleWorld, householdId: string): number {
  return Math.max(...world.accountsOfHousehold(householdId).map((a) => accountOpenedDaysAgo(a)));
}

export function buildDemoSamples(universe: Universe): DemoSamples {
  const world = sampleWorld(universe);
  const showcase = new Map(SHOWCASE.map((s) => [s.person, s]));
  const clients: Record<string, ClientSample> = {};
  for (const person of universe.people) {
    const household = world.household(person.household);
    const score = riskFor(household);
    const risk = { score, tolerance: toleranceFor(score) };
    const written = showcase.get(person.id);
    const sf = world.personSf.get(person.id)!;
    if (!written) {
      clients[sf] = {
        name: nameOf(person), showcase: false, risk, prep: null, dualView: null,
        bene: baselineBeneficiaries(world, person, household),
        portrait: baselinePortrait(world, person, household),
      };
      continue;
    }
    const tenure = tenureFrom(householdTenureDays(world, household.id));
    const aum = world.accountsOfHousehold(household.id).reduce((t, a) => t + a.value, 0);
    const moment = (m: ShowcaseMoment): SampleMoment => ({ daysAgo: daysFor(world, m.daysAgo), text: m.text, source: m.source });
    clients[sf] = {
      name: nameOf(person),
      showcase: true,
      risk,
      bene: written.beneficiaries.map((b) => {
        const a = world.account(b.account);
        return { name: b.name, rel: b.rel, pct: b.pct, dob: b.dob, acct: ACCOUNT_TYPE_LABEL[a.type] ?? "Individual", num: masked(a.number) };
      }),
      portrait: written.portrait,
      prep: {
        advisor: staffOf(universe, household.advisor).name,
        aum: usdShort(aum),
        tenure,
        riskProfile: `${risk.tolerance} (${score}/25)`,
        lastMeeting: written.prep.lastMeeting,
        recentSignals: written.prep.recentSignals,
        openItems: written.prep.openItems,
        talkingPoints: written.prep.talkingPoints.join("\n"),
        notes: written.prep.notes,
      },
      dualView: {
        label: written.dualView.label,
        description: written.dualView.description,
        meetingLabel: written.dualView.meetingLabel,
        tenure,
        brief: written.dualView.brief,
        realTime: written.dualView.realTime.map(moment),
        historical: written.dualView.historical.map(moment).sort((x, y) => x.daysAgo - y.daysAgo),
        insights: written.dualView.insights,
      },
    };
  }
  return {
    clients,
    showcase: SHOWCASE.map((s) => ({ id: world.personSf.get(s.person)!, name: clients[world.personSf.get(s.person)!].name })),
  };
}

export function buildWorkflowSample(universe: Universe): WorkflowSample {
  const world = sampleWorld(universe);
  const person = new Map(universe.people.map((p) => [p.id, p]));
  const decisions = SHOWCASE_DECISIONS.map((d, i) => ({
    id: `demo-decision-${d.household}`,
    householdId: world.householdSf.get(d.household)!,
    householdName: world.household(d.household).name,
    meeting: d.meeting,
    items: d.items.map((item, j) => ({
      ...item,
      id: `demo-item-${i + 1}${String.fromCharCode(97 + j)}`,
      tasks: item.tasks.map((t, k) => ({ ...t, id: `demo-task-${i + 1}${String.fromCharCode(97 + j)}${k + 1}` })),
    })),
  }));
  const nudges: Nudge[] = SHOWCASE_NUDGES.map((n, i) => ({
    id: `demo-nudge-${i + 1}`,
    clientId: world.personSf.get(n.person)!,
    client: nameOf(person.get(n.person)!),
    channel: n.channel,
    subject: n.subject,
    when: n.when,
    templateId: n.templateId,
    status: n.status,
    body: n.body,
  }));
  return { decisions, nudges };
}

export interface PlannedTaxBudget {
  person: string;
  budget: number;
  realized: number;
  note: string;
  /** Last year's budget, when the client was with the firm a year ago. */
  prior: number | null;
}

/** Every client's realized-gains budget for the year the seed runs in. */
export function planTaxBudgets(universe: Universe): PlannedTaxBudget[] {
  const world = sampleWorld(universe);
  const showcase = new Map(SHOWCASE.map((s) => [s.person, s]));
  return universe.people.map((p) => {
    const written = showcase.get(p.id);
    if (written) return { person: p.id, ...written.taxBudget };
    const accounts = world.accountsOfPerson(p.id);
    const taxable = accounts.filter((a) => !RETIREMENT.has(a.type)).reduce((t, a) => t + a.value, 0);
    const budget = Math.max(2_500, Math.round((taxable * 0.06) / 2_500) * 2_500);
    const used = seeded(`${p.id}:tax:used`);
    // Most clients sit comfortably inside their budget; a few run close to it and one in ten has gone over.
    const share = used < 0.1 ? 1.04 + used : used < 0.3 ? 0.8 + used / 2 : used * 0.7;
    const realized = Math.round(budget * share);
    const tenure = Math.max(0, ...accounts.map((a) => accountOpenedDaysAgo(a)));
    return { person: p.id, budget, realized, note: "", prior: tenure > 365 ? budget : null };
  });
}
