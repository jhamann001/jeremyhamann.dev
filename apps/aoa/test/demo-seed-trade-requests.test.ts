// The demo seed's Trade Requests plan (lib/demo/seed/trade-requests-plan.ts) over the shared universe: the Trade
// Request demo's requests, on AoA's record shapes (person clients keyed by cedar_ridge_user_id, AoA's risk table).
import { describe, expect, it } from "vitest";
import { riskAllocation } from "@/lib/trade-requests/new-request-allocation";
import { mapRowToRequest, type RequestRow } from "@/lib/trade-requests/native/reads/requests";
import { toMachineTradeRequest } from "@/lib/trade-requests/native/reads/portrait";
import { planTradeRequests, riskFor } from "@/lib/demo/seed/trade-requests-plan";
import { cedarRidgeUserId, loadUniverse, membersOf } from "@/lib/demo/seed/universe";

const universe = loadUniverse();
const plan = planTradeRequests(universe);
const byId = new Map(plan.requests.map((r) => [r.id, r]));
const userIdOf = (household: string) => new Set(membersOf(universe, household).map((p) => cedarRidgeUserId(p.id)));

describe("demo seed: Trade Requests plan", () => {
  it("plans the Trade Request demo's twenty requests: the five stories and fifteen history requests", () => {
    expect(plan.requests.map((r) => r.id).sort()).toEqual([
      ...Array.from({ length: 15 }, (_, i) => `REQ-${String(1001 + i).padStart(8, "0")}`),
      "REQ-00001038", "REQ-00001041", "REQ-00001043", "REQ-00001045", "REQ-00001046",
    ]);
    expect(Object.fromEntries(plan.requests.filter((r) => r.storyId).map((r) => [r.storyId, [r.tradeType, r.status, r.priority]]))).toEqual({
      "TR-1046": ["Raise Cash", "Pending Review", "Urgent"],
      "TR-1045": ["Rebalance", "Pending Review", "Standard"],
      "TR-1043": ["Rebalance", "Approved", "Standard"],
      "TR-1041": ["Liquidate", "Pending Current Asset Liquidation", "Standard"],
      "TR-1038": ["Raise Cash", "Completed", "Standard"],
    });
  });

  it("keys every request's clients by the household members' clearing-firm user ids", () => {
    for (const r of plan.requests) {
      const members = userIdOf(r.household.id);
      expect(r.clientIds.length).toBeGreaterThan(0);
      for (const id of r.clientIds) {
        expect(id).toMatch(/^user-[0-9a-f-]{36}$/);
        expect(members.has(id)).toBe(true);
      }
      expect(r.clientId).toBe(r.clientIds[0]);
      expect(r.clientNames).toHaveLength(r.clientIds.length);
    }
    // Okafor's rebalance covers the joint account, so it spans both owners.
    const okafor = byId.get("REQ-00001045")!;
    expect(okafor.clientNames).toEqual(["Kofi Okafor", "Ada Okafor"]);
    expect(okafor.household.name).toBe("Okafor Household");
    expect(okafor.advisorNotes).toMatch(/Edward Jones/);
  });

  it("selects the household's accounts the way the Trade Request demo does and stores their clearing ids", () => {
    const alvarez = byId.get("REQ-00001046")!;
    expect(alvarez.selectedAccounts).toEqual(["DEMO-113317"]);
    expect(alvarez.tradeAmount).toBe("85000");
    expect(alvarez.raiseCashReason).toBe("Home purchase closing");
    for (const r of plan.requests) {
      expect(r.accountMetadata.map((a) => a.accountNumber)).toEqual(r.selectedAccounts);
      expect(r.totalValue).toBe(r.accountMetadata.reduce((t, a) => t + a.balance, 0));
      for (const a of r.accountMetadata) expect(a.accountId).toMatch(/^01SYNTH[0-9A-Z]{19}$/);
    }
  });

  it("uses AoA's risk table for the target allocation", () => {
    for (const r of plan.requests) {
      expect(r.riskProfile).toBe(riskFor(r.household));
      expect(r.baseAllocation).toEqual(riskAllocation(r.riskProfile));
    }
  });

  it("gives the advisors and traders identities, with the transfer specialist on the trader roster", () => {
    expect(plan.users.map((u) => [u.name, u.role]).sort()).toEqual([
      ["Dana Pruitt", "advisor"], ["Ethan Cole", "trader"], ["Jordan Reyes", "trader"], ["Rachel Moss", "advisor"], ["Sam Ortiz", "advisor"],
    ]);
    const traders = plan.users.filter((u) => u.role === "trader").map((u) => u.id);
    for (const r of plan.requests) {
      expect(r.notifications.filter((n) => traders.includes(n.userId))).toHaveLength(traders.length);
      expect(r.audit[0].action).toBe("Created Request");
    }
  });

  it("keys the exclusions by the ids the client list gives", () => {
    const clientIds = new Set(plan.clients.map((c) => c.id));
    const accountIds = new Set(plan.accounts.map((a) => a.id));
    for (const e of plan.exclusions) expect((e.scope === "client" ? clientIds : accountIds).has(e.key)).toBe(true);
    expect(plan.exclusions.map((e) => e.ticker).sort()).toEqual(["AAPL", "NVDA", "VNQ"]);
  });

  it("projects as the Client Portrait's authoritative rows, found by any member's id", () => {
    const r = byId.get("REQ-00001043")!;
    const row: RequestRow = {
      id: r.id, client_id: r.clientId, client_name: r.clientName, client_ids: r.clientIds, client_names: r.clientNames,
      advisor_name: "Dana Pruitt", trade_type: r.tradeType, trade_amount: r.tradeAmount, deposit_account: r.depositAccount,
      rebalance_all: r.rebalanceAll, status: r.status, created_at: new Date(), updated_at: new Date(), selected_accounts: r.selectedAccounts,
      total_value: String(r.totalValue), priority: r.priority, advisor_notes: r.advisorNotes, residence: r.residence,
      liquidation_approval: r.liquidationApproval, advisor_exclusions: null, client_exclusions: null, esg_filters: null,
      risk_profile: r.riskProfile, base_allocation: r.baseAllocation, equity_strategies: [], raise_cash_reason: null,
      liquidity_deadline: null, liquidate_option: null, liquidate_positions: null, execution_plan: null,
      account_metadata: r.accountMetadata, asset_location_mode: "priority", household_id: String(r.householdNumber), household_name: r.household.name,
    };
    const projected = toMachineTradeRequest(mapRowToRequest(row, []));
    expect(projected.clientIds).toEqual(r.clientIds);
    expect(projected.householdName).toBe("Patel Trust");
    expect(projected.accounts.every((a) => a.accountNumber?.startsWith("****"))).toBe(true);
    expect(projected.profile?.instructions.find((i) => i.key === "tax_preference")?.value).toBe("New York municipal preference");
  });

  it("is the same plan every time", () => {
    expect(planTradeRequests(universe)).toEqual(plan);
  });
});
