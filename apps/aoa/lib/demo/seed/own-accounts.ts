// Accounts only this demo holds: one of their own for each household's second member. The shared universe gives every
// non-joint account to a household's first member (people.ts accountOwners), so a second member's Client Portrait
// had no account, no AUM and no funding of their own. These sit beside the universe's accounts in AoA's custodian
// mirror and its Trade Request records, and nowhere else: the other demos never show them, and nothing here links
// one to another demo. Pure: no database, no clock.

import { accountUlid, membersOf, seeded, seededInt, type Universe, type UniverseAccount, type UniversePerson } from "./universe";

export interface OwnAccount extends UniverseAccount {
  /** The universe person who owns it. */
  owner: string;
  /** Days before the seed's day it was opened. */
  openedDaysAgo: number;
  /** Share of the value held in cash. */
  cashShare: number;
}

// Ada Okafor's SEP IRA: the household's first account with the firm, before the Edward Jones accounts started moving.
const FIXED: Record<string, Pick<OwnAccount, "type" | "value" | "openedDaysAgo" | "cashShare">> = {
  "okafor-ada": { type: "sep-ira", value: 88_340, openedDaysAgo: 1_130, cashShare: 0.03 },
};

// Retirement accounts a second member is most likely to hold on their own, first choice first.
const OWN_TYPES = ["roth-ira", "traditional-ira", "sep-ira", "rollover-ira"] as const;

/** Each second member's own account, in universe order. */
export function ownAccounts(universe: Universe): OwnAccount[] {
  const taken = new Set(universe.accounts.map((a) => a.number));
  const out: OwnAccount[] = [];
  for (const h of universe.households) {
    const second: UniversePerson | undefined = membersOf(universe, h.id)[1];
    if (!second) continue;
    const held = new Set(universe.accounts.filter((a) => a.household === h.id).map((a) => a.type));
    const fixed = FIXED[second.id];
    const type = fixed?.type ?? OWN_TYPES.find((t) => !held.has(t)) ?? "roth-ira";
    let number = "";
    for (let salt = 0; !number || taken.has(number); salt++) number = `DEMO-${seededInt(`own:${second.id}:number:${salt}`, 100_000, 999_999)}`;
    taken.add(number);
    out.push({
      id: `own-${second.id}`,
      number,
      household: h.id,
      type,
      custodian: "apex",
      model: h.model,
      value: fixed?.value ?? seededInt(`own:${second.id}:value`, 38, 260) * 1_000 + seededInt(`own:${second.id}:dollars`, 0, 999),
      owner: second.id,
      openedDaysAgo: fixed?.openedDaysAgo ?? seededInt(`own:${second.id}:opened`, 200, 1_800),
      cashShare: fixed?.cashShare ?? 0.02 + Math.round(seeded(`own:${second.id}:cash`) * 40) / 1_000,
    });
  }
  return out;
}

/** The clearing firm's account id for one of these accounts. */
export const ownAccountUlid = (account: OwnAccount): string => accountUlid(account.id);
