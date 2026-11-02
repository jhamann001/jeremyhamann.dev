// Trade Requests only this demo holds: the older, completed requests that set the investment profile on the showcase
// households' longest-held accounts. The Trade Request demo's plan (trade-requests-plan.ts) covers the recent queue,
// with the story households' current requests; these come from years before it, so the Client Portrait's
// Investment instructions and Risk profile cards have an approved source for those accounts. Their ids
// (REQ-00000901 onward) sit below the shared plan's, and the request dialog links only shared ids to the other demo
// (lib/demo/links.ts). The second members' own accounts (own-accounts.ts) join the request records' client and account
// lists the same way. Pure: no database, no clock.

import { riskAllocation } from "@/lib/trade-requests/new-request-allocation";
import { ownAccounts, ownAccountUlid, type OwnAccount } from "./own-accounts";
import {
  TRADE_ACCOUNT_TYPE, residenceFor, riskFor, tradeRequestAccountId, tradeRequestUserId, type PlannedAccount,
  type PlannedRequest, type TradeRequestPlan,
} from "./trade-requests-plan";
import { cedarRidgeUserId, seededInt, type Universe, type UniverseAccount } from "./universe";

/** Days before the seed's day an account was opened, as people.ts dates it in the custodian mirror. */
export const accountOpenedDaysAgo = (account: UniverseAccount): number =>
  "openedDaysAgo" in account ? (account as OwnAccount).openedDaysAgo : seededInt(`${account.id}:opened`, 120, 1400);

interface History {
  n: number;
  account: string;
  /** Days after the account opened the request was made. */
  afterOpen: number;
  notes: string;
}

const HISTORY: History[] = [
  { n: 901, account: "own-okafor-ada", afterOpen: 6, notes: "First SEP IRA contribution. Invest in Meridian Growth 80/20, the household's model." },
  { n: 902, account: "acct-007", afterOpen: 4, notes: "Rollover from the old employer plan landed as cash. Invest in Meridian Income; Erik draws required distributions from this account." },
  { n: 903, account: "acct-010", afterOpen: 5, notes: "401(k) rollover arrived as cash. Invest in Meridian Balanced 60/40. Harvest losses in the bond funds when they come up." },
];

const DAY = 24 * 60;

/** Days before the seed's day an account's Initial Funding request here was made; null when it has none. */
export function fundedDaysAgo(account: UniverseAccount): number | null {
  const history = HISTORY.find((r) => r.account === account.id);
  return history ? accountOpenedDaysAgo(account) - history.afterOpen : null;
}

/** The shared plan, with these requests and the second members' own accounts added. */
export function withOwnTradeRecords(plan: TradeRequestPlan, universe: Universe): TradeRequestPlan {
  const own = ownAccounts(universe);
  const person = new Map(universe.people.map((p) => [p.id, p]));
  const clients = [...plan.clients];
  const accounts = [...plan.accounts];
  for (const a of own) {
    const owner = person.get(a.owner)!;
    const clientId = cedarRidgeUserId(owner.id);
    if (!clients.some((c) => c.id === clientId)) {
      clients.push({ id: clientId, name: `${owner.first} ${owner.last}`, personId: owner.id, householdId: a.household });
    }
    accounts.push({
      id: tradeRequestAccountId(a.id),
      ulid: ownAccountUlid(a),
      clientId,
      accountNumber: a.number,
      accountType: TRADE_ACCOUNT_TYPE[a.type] ?? "Taxable",
      balance: a.value,
      cash: Math.round(a.value * a.cashShare * 100) / 100,
      fixed: 0,
      equity: Math.round(a.value * (1 - a.cashShare) * 100) / 100,
      universe: a,
    });
  }

  const byAccount = new Map<string, PlannedAccount>(accounts.map((a) => [a.universe.id, a]));
  const household = new Map(universe.households.map((h, i) => [h.id, { h, number: 1001 + i }]));
  const requests: PlannedRequest[] = HISTORY.map((r) => {
    const account = byAccount.get(r.account);
    if (!account) throw new Error(`own trade history account ${r.account} not found`);
    const { h, number } = household.get(account.universe.household)!;
    const client = clients.find((c) => c.id === account.clientId)!;
    const advisor = universe.staff.find((s) => s.id === h.advisor)!;
    const trader = universe.staff.find((s) => s.role === "trader")!;
    const risk = riskFor(h);
    const created = (accountOpenedDaysAgo(account.universe) - r.afterOpen) * DAY + seededInt(`own-request:${r.n}`, 540, 960);
    const completed = created - seededInt(`own-request:${r.n}:done`, 1, 2) * DAY;
    return {
      id: `REQ-${String(r.n).padStart(8, "0")}`,
      storyId: null,
      household: h,
      householdNumber: number,
      clientId: client.id,
      clientName: client.name,
      clientIds: [client.id],
      clientNames: [client.name],
      advisorId: tradeRequestUserId(advisor.id),
      tradeType: "Initial Funding",
      tradeAmount: null,
      depositAccount: null,
      rebalanceAll: true,
      status: "Completed",
      totalValue: account.balance,
      selectedAccounts: [account.accountNumber],
      accountMetadata: [{ accountId: account.ulid, accountNumber: account.accountNumber, accountType: account.accountType, balance: account.balance }],
      priority: "Standard",
      advisorNotes: r.notes,
      residence: residenceFor(h.id),
      liquidationApproval: null,
      riskProfile: risk,
      baseAllocation: riskAllocation(risk),
      raiseCashReason: null,
      liquidityDeadlineDays: null,
      liquidateOption: null,
      createdMinutesAgo: created,
      updatedMinutesAgo: completed,
      audit: [
        { userName: advisor.name, userId: tradeRequestUserId(advisor.id), action: "Created Request", notes: r.notes, minutesAgo: created },
        { userName: trader.name, userId: tradeRequestUserId(trader.id), action: "Status changed to Completed", notes: null, minutesAgo: completed },
      ],
      notifications: [
        { userId: tradeRequestUserId(advisor.id), body: `Trade request REQ-${String(r.n).padStart(8, "0")} status updated to: Completed`, minutesAgo: completed, read: true },
      ],
    };
  });

  return { ...plan, clients, accounts, requests: [...plan.requests, ...requests] };
}
