// Trade Requests for the demo seed, planned from the shared universe: the Trade Request demo's plan
// (apps/trade/server/src/db/demoSeed.ts and src/demo/universe.ts) ported onto AoA's moved records, so the same
// requests carry the same ids, types, statuses, priorities, amounts, accounts, notes and ages in both demos.
// Where AoA's records differ from that demo's, AoA's production shape wins, because AoA's own screens read them:
//   - A client is a person, keyed by the clearing firm's user id (cedar_ridge_user_id), as the moved production
//     records are: the household, client and transfer screens find requests by those ids. The Trade Request demo
//     keys its clients by household (HH-1001…); here the household rides on household_id/household_name.
//   - The target allocation is AoA's own risk table (lib/trade-requests/new-request-allocation.ts), so a new
//     request at the same risk score compares equal to the stored one.
//   - No execution plan: AoA's backend has no asset-location engine (plan generation is off) and no screen shows one.
// Pure: no database, no clock except the `now` passed in.

import { riskAllocation, type BaseAllocation } from "@/lib/trade-requests/new-request-allocation";
import { accountOwners } from "./people";
import {
  accountUlid, cedarRidgeUserId, demoUuid, fnv, staffEmail, storyTradeRequestId, type Universe, type UniverseAccount,
  type UniverseHousehold, type UniverseStaff,
} from "./universe";

export type TradeType = "Rebalance" | "Cash Deposit" | "Raise Cash" | "Initial Funding" | "Liquidate";
export type RequestStatus =
  | "Pending Review" | "Needs Info" | "Approved" | "Rejected" | "Completed" | "Pending Current Asset Liquidation";
export type Priority = "Urgent" | "Standard" | "Low";
export type Residence = "NY" | "CA" | "Other";
export type AccountType = "Taxable" | "Joint" | "Traditional IRA" | "Roth IRA";

/** The Trade Request demo's account types (its universe.ts ACCOUNT_TYPE). */
export const TRADE_ACCOUNT_TYPE: Record<string, AccountType> = {
  "joint-taxable": "Joint",
  individual: "Taxable",
  trust: "Taxable",
  "traditional-ira": "Traditional IRA",
  "rollover-ira": "Traditional IRA",
  "sep-ira": "Traditional IRA",
  "roth-ira": "Roth IRA",
};

const BUCKET: Record<string, "cash" | "fixed" | "equity"> = {
  cash: "cash",
  "us-bond": "fixed",
  treasury: "fixed",
  "corporate-bond": "fixed",
  "muni-bond": "fixed",
  "us-equity": "equity",
  "intl-equity": "equity",
  "real-estate": "equity",
};

// Risk level by model, a deterministic spread inside each model's band, and the two story households that live in
// the states with their own models: the Trade Request demo's rules.
const RISK_BAND: Record<string, [number, number]> = {
  "meridian-income": [6, 9],
  "meridian-balanced-60-40": [12, 15],
  "meridian-growth-80-20": [18, 21],
};
const STORY_RESIDENCE: Record<string, Residence> = { "patel-trust": "NY", brennan: "CA" };

export const residenceFor = (householdId: string): Residence =>
  STORY_RESIDENCE[householdId] ?? (["Other", "Other", "Other", "NY", "CA"] as const)[fnv(householdId) % 5];

export function riskFor(h: UniverseHousehold): number {
  const [lo, hi] = RISK_BAND[h.model] ?? [12, 15];
  return lo + (fnv(h.id) % (hi - lo + 1));
}

/** Slack member id for a staff member, in Slack's U-prefixed shape (the Trade Request demo's). */
export const slackMemberId = (staffId: string): string => `U0DEMO${String(fnv(staffId) % 100000).padStart(5, "0")}`;

export interface PlannedUser {
  id: string;
  staffId: string;
  email: string;
  name: string;
  role: "advisor" | "trader";
  slackUserId: string;
}

export interface PlannedClient { id: string; name: string; personId: string; householdId: string }

export interface PlannedAccount {
  id: string;
  /** The clearing firm's account id: what the request's stored account details carry. */
  ulid: string;
  clientId: string;
  accountNumber: string;
  accountType: AccountType;
  balance: number;
  cash: number;
  fixed: number;
  equity: number;
  universe: UniverseAccount;
}

export interface PlannedAudit { userName: string; userId: string | null; action: string; notes: string | null; minutesAgo: number }
export interface PlannedNotification { userId: string; body: string; minutesAgo: number; read: boolean }

export interface PlannedRequest {
  id: string;
  storyId: string | null;
  household: UniverseHousehold;
  householdNumber: number;
  clientId: string;
  clientName: string;
  clientIds: string[];
  clientNames: string[];
  advisorId: string | null;
  tradeType: TradeType;
  tradeAmount: string | null;
  depositAccount: string | null;
  rebalanceAll: boolean;
  status: RequestStatus;
  totalValue: number;
  selectedAccounts: string[];
  accountMetadata: Array<{ accountId: string; accountNumber: string; accountType: AccountType; balance: number }>;
  priority: Priority;
  advisorNotes: string | null;
  residence: Residence;
  liquidationApproval: boolean | null;
  riskProfile: number;
  baseAllocation: BaseAllocation;
  raiseCashReason: string | null;
  /** Days after creation the cash is needed by (a raise-cash request's liquidity deadline). */
  liquidityDeadlineDays: number | null;
  liquidateOption: string | null;
  /** Minutes before `now` it was created, and last changed. */
  createdMinutesAgo: number;
  updatedMinutesAgo: number;
  audit: PlannedAudit[];
  notifications: PlannedNotification[];
}

export interface PlannedExclusion {
  scope: "client" | "account";
  /** The client id, or the account id the client list gives the account. */
  key: string;
  ticker: string;
  kind: "client" | "advisor";
  reason: string;
  noBuy: boolean;
  noSell: boolean;
  createdBy: string | null;
  createdByName: string;
  createdMinutesAgo: number;
}

export interface PlannedClassification {
  ticker: string;
  name: string;
  category: string;
  assetClass: string;
  instrumentKind: "etf" | "mutualfund";
}

export interface TradeRequestPlan {
  users: PlannedUser[];
  clients: PlannedClient[];
  accounts: PlannedAccount[];
  requests: PlannedRequest[];
  exclusions: PlannedExclusion[];
  classifications: PlannedClassification[];
}

/**
 * Who has a Trade Request identity: the Trade Request demo's users (the firm's advisors and its trader), plus the
 * transfer specialist, who reviews requests in AoA's trading queue (an OPERATIONS user, so a trader there, and on the
 * roster that gets new-request notifications). Everyone else in an allowed role acts under AoA's role rule and gets
 * an identity on their first write, as production does.
 */
export function tradeRequestStaff(universe: Universe): UniverseStaff[] {
  return universe.staff.filter((s) => s.role === "advisor" || s.role === "trader" || s.role === "transfers");
}

export const tradeRequestUserId = (staffId: string): string => demoUuid(`trade-request:user:${staffId}`);
export const tradeRequestAccountId = (accountId: string): string => demoUuid(`trade-request:account:${accountId}`);

const STORY_TYPE: Record<string, TradeType> = {
  "raise-cash": "Raise Cash", "rebalance-to-model": "Rebalance", "model-change": "Rebalance", "tax-loss-harvest": "Liquidate",
};
const STORY_STATUS: Record<string, RequestStatus> = {
  new: "Pending Review", "in-review": "Pending Review", approved: "Approved", executing: "Pending Current Asset Liquidation", done: "Completed",
};
// Minutes before `now` each story request was created.
const STORY_AGE: Record<string, number> = {
  "REQ-00001046": 12, "REQ-00001045": 60, "REQ-00001043": 180, "REQ-00001041": 300, "REQ-00001038": 1440,
};
const HISTORY_TYPES: TradeType[] = ["Rebalance", "Cash Deposit", "Raise Cash", "Initial Funding", "Rebalance", "Liquidate"];
const HISTORY_STATUSES: RequestStatus[] = ["Completed", "Completed", "Approved", "Completed", "Rejected", "Needs Info", "Completed", "Pending Review"];

function storyNote(storyId: string): string {
  if (storyId.endsWith("1046")) return "Client is funding a home purchase closing Friday. The wire request is HD-2479 in the help desk.";
  if (storyId.endsWith("1045")) return "Transfer from Edward Jones settles this week. Rebalance into the Meridian Growth 80/20 model once it lands.";
  if (storyId.endsWith("1038")) return "2026 required minimum distribution.";
  return "";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const requestId = (n: number) => `REQ-${String(n).padStart(8, "0")}`;

export function planTradeRequests(universe: Universe): TradeRequestPlan {
  const staff = tradeRequestStaff(universe);
  const users: PlannedUser[] = staff.map((s) => ({
    id: tradeRequestUserId(s.id),
    staffId: s.id,
    email: staffEmail(s),
    name: s.name,
    role: s.role === "advisor" ? "advisor" : "trader",
    slackUserId: slackMemberId(s.id),
  }));
  const userByStaff = new Map(users.map((u) => [u.staffId, u]));
  // The Trade Request demo's trader works the queue in its history; the specialist joins the roster.
  const historyTrader = users.find((u) => universe.staff.find((s) => s.id === u.staffId)?.role === "trader") ?? null;
  const traders = users.filter((u) => u.role === "trader");

  // Clients: each account's primary owner (people.ts accountOwners), as the clearing firm's client list keys them.
  const personName = new Map(universe.people.map((p) => [p.id, `${p.first} ${p.last}`]));
  const clients = new Map<string, PlannedClient>();
  const bucketOf = new Map(universe.securities.map((s) => [s.symbol, BUCKET[s.assetClass] ?? "equity"]));
  const accounts: PlannedAccount[] = [];
  for (const a of universe.accounts) {
    const primary = accountOwners(universe, a)[0];
    const clientId = cedarRidgeUserId(primary.id);
    if (!clients.has(clientId)) clients.set(clientId, { id: clientId, name: personName.get(primary.id)!, personId: primary.id, householdId: a.household });
    const totals = { cash: 0, fixed: 0, equity: 0 };
    for (const hd of universe.holdings) if (hd.account === a.id) totals[bucketOf.get(hd.symbol) ?? "equity"] += hd.value;
    accounts.push({
      id: tradeRequestAccountId(a.id),
      ulid: accountUlid(a.id),
      clientId,
      accountNumber: a.number,
      accountType: TRADE_ACCOUNT_TYPE[a.type] ?? "Taxable",
      balance: a.value,
      cash: round2(totals.cash),
      fixed: round2(totals.fixed),
      equity: round2(totals.equity),
      universe: a,
    });
  }
  const accountsByHousehold = new Map<string, PlannedAccount[]>();
  for (const a of accounts) accountsByHousehold.set(a.universe.household, [...(accountsByHousehold.get(a.universe.household) ?? []), a]);

  type Plan = {
    household: UniverseHousehold; type: TradeType; amount: number | null; status: RequestStatus; priority: Priority;
    ageMin: number; advisor: string; notes: string; n: number; storyId: string | null;
  };
  const hhById = new Map(universe.households.map((h) => [h.id, h]));
  const plans: Plan[] = [];
  for (const s of universe.stories.trade) {
    const n = Number(s.id.replace(/\D/g, ""));
    plans.push({
      household: hhById.get(s.household)!,
      type: STORY_TYPE[s.type] ?? "Rebalance",
      amount: s.amount,
      status: STORY_STATUS[s.status] ?? "Pending Review",
      priority: s.id.endsWith("1046") ? "Urgent" : "Standard",
      ageMin: STORY_AGE[storyTradeRequestId(s.id)] ?? 600,
      advisor: s.advisor,
      notes: storyNote(s.id),
      n,
      storyId: s.id,
    });
  }
  const others = universe.households.filter((h) => !h.story);
  for (let i = 0; i < 15; i++) {
    const h = others[(i * 7) % others.length];
    const type = HISTORY_TYPES[i % HISTORY_TYPES.length];
    plans.push({
      household: h,
      type,
      amount: type === "Raise Cash" || type === "Cash Deposit" ? 5_000 * (2 + (fnv(h.id + i) % 18)) : null,
      status: HISTORY_STATUSES[i % HISTORY_STATUSES.length],
      priority: i % 5 === 0 ? "Low" : "Standard",
      ageMin: 60 * 24 * (2 + i * 3) + (fnv(h.id) % 600),
      advisor: h.advisor,
      notes: "",
      n: 1000 + i + 1,
      storyId: null,
    });
  }

  const householdNumber = new Map(universe.households.map((h, i) => [h.id, 1001 + i]));
  const requests: PlannedRequest[] = plans.map((p) => {
    const id = requestId(p.n);
    const householdAccounts = accountsByHousehold.get(p.household.id) ?? [];
    const singleAccount = p.type === "Raise Cash" || p.type === "Cash Deposit" || p.type === "Liquidate";
    const selected = singleAccount ? householdAccounts.slice(0, 1) : householdAccounts;
    // The request spans every owner of the selected accounts (a household rebalance across a joint account spans
    // both people), primary owner first.
    const ownerIds: string[] = [];
    for (const a of selected) {
      for (const o of accountOwners(universe, a.universe)) {
        const cid = cedarRidgeUserId(o.id);
        if (!ownerIds.includes(cid)) ownerIds.push(cid);
      }
    }
    const nameOf = (cid: string) => personName.get(universe.people.find((x) => cedarRidgeUserId(x.id) === cid)!.id)!;
    const risk = riskFor(p.household);
    const advisor = userByStaff.get(p.advisor) ?? null;
    const advisorName = universe.staff.find((s) => s.id === p.advisor)?.name ?? "Advisor";
    const updatedMinutesAgo = p.status === "Pending Review" ? p.ageMin : Math.max(5, p.ageMin - 90);
    const allocationType = p.type === "Rebalance" || p.type === "Initial Funding";
    const clientLabel = ownerIds.map(nameOf);

    const audit: PlannedAudit[] = [
      { userName: advisorName, userId: advisor?.id ?? null, action: "Created Request", notes: p.notes || null, minutesAgo: p.ageMin },
    ];
    const notifications: PlannedNotification[] = traders.map((t) => ({
      userId: t.id,
      body: `New trade request ${id} submitted for ${clientLabel[0]}`,
      minutesAgo: p.ageMin,
      read: p.status !== "Pending Review",
    }));
    if (p.status !== "Pending Review") {
      audit.push({
        userName: historyTrader?.name ?? "Trader", userId: historyTrader?.id ?? null, action: `Status changed to ${p.status}`,
        notes: null, minutesAgo: updatedMinutesAgo,
      });
      if (advisor) {
        notifications.push({
          userId: advisor.id, body: `Trade request ${id} status updated to: ${p.status}`, minutesAgo: updatedMinutesAgo,
          read: p.ageMin > 60 * 24 * 7,
        });
      }
    }

    return {
      id,
      storyId: p.storyId,
      household: p.household,
      householdNumber: householdNumber.get(p.household.id)!,
      clientId: ownerIds[0],
      clientName: clientLabel[0],
      clientIds: ownerIds,
      clientNames: clientLabel,
      advisorId: advisor?.id ?? null,
      tradeType: p.type,
      tradeAmount: p.amount != null ? String(p.amount) : null,
      depositAccount: p.type === "Cash Deposit" ? selected[0]?.accountNumber ?? null : null,
      rebalanceAll: allocationType,
      status: p.status,
      totalValue: selected.reduce((t, a) => t + a.balance, 0),
      selectedAccounts: selected.map((a) => a.accountNumber),
      accountMetadata: selected.map((a) => ({ accountId: a.ulid, accountNumber: a.accountNumber, accountType: a.accountType, balance: a.balance })),
      priority: p.priority,
      advisorNotes: p.notes || null,
      residence: residenceFor(p.household.id),
      liquidationApproval: p.type === "Liquidate" ? true : null,
      riskProfile: risk,
      baseAllocation: riskAllocation(risk),
      raiseCashReason: p.type === "Raise Cash" ? (p.n === 1046 ? "Home purchase closing" : "Client distribution") : null,
      liquidityDeadlineDays: p.type === "Raise Cash" ? 4 : null,
      liquidateOption: p.type === "Liquidate" ? "Specific Positions" : null,
      createdMinutesAgo: p.ageMin,
      updatedMinutesAgo,
      audit,
      notifications,
    };
  });

  // A few standing exclusions so the exclusions screens have something to show (the Trade Request demo's three).
  const advisorStaff = universe.staff.find((s) => s.role === "advisor");
  const advisorUser = advisorStaff ? userByStaff.get(advisorStaff.id) ?? null : null;
  const primaryClientOf = (householdId: string) => accountsByHousehold.get(householdId)?.[0]?.clientId;
  const exclusion = (scope: PlannedExclusion["scope"], key: string | undefined, ticker: string, kind: PlannedExclusion["kind"], reason: string, noBuy: boolean, noSell: boolean): PlannedExclusion[] =>
    key ? [{ scope, key, ticker, kind, reason, noBuy, noSell, createdBy: advisorUser?.id ?? null, createdByName: advisorStaff?.name ?? "Advisor", createdMinutesAgo: 60 * 24 * 30 }] : [];
  const exclusions: PlannedExclusion[] = [
    ...exclusion("client", primaryClientOf("okafor"), "NVDA", "client", "Concentrated position; client wants to hold, not add", false, true),
    ...exclusion("client", primaryClientOf("alvarez"), "VNQ", "advisor", "Already owns rental property; avoid more real estate", true, false),
    ...exclusion("account", accountsByHousehold.get("okafor")?.[0]?.id, "AAPL", "client", "Low cost basis; do not sell", false, true),
  ];

  return { users, clients: [...clients.values()], accounts, requests, exclusions, classifications: fundClassifications(universe) };
}

// Fund category and asset class by the universe's asset class, as the classification cache stores them.
const FUND_CLASS: Record<string, [string, string]> = {
  "us-equity": ["Large Blend", "US Equity"],
  "intl-equity": ["Foreign Large Blend", "Intl Equity"],
  "real-estate": ["Real Estate", "Real Estate"],
  "us-bond": ["Intermediate Core Bond", "US Bond"],
  treasury: ["Short Government", "Short-Term Bond"],
  "corporate-bond": ["Short-Term Bond", "Short-Term Bond"],
  "muni-bond": ["Muni National Interm", "Muni Bond"],
  cash: ["Money Market-Taxable", "Money Market"],
};
const FUND_CLASS_OVERRIDE: Record<string, [string, string]> = {
  AVUV: ["Small Value", "US Equity"],
  BBGLX: ["Large Growth", "US Equity"],
  SCHR: ["Intermediate Government", "US Bond"],
  VMSXX: ["Money Market-Tax-Free", "Money Market"],
};

/** The universe's funds in the security classification cache (the Trade Request demo adds the same rows). */
export function fundClassifications(universe: Universe): PlannedClassification[] {
  return universe.securities.flatMap((sec) => {
    const cls = FUND_CLASS_OVERRIDE[sec.symbol] ?? FUND_CLASS[sec.assetClass];
    if (!cls || sec.vehicle === "stock") return [];
    return [{ ticker: sec.symbol, name: sec.name, category: cls[0], assetClass: cls[1], instrumentKind: sec.vehicle === "etf" ? "etf" : "mutualfund" }];
  });
}
