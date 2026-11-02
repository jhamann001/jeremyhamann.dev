import { beforeEach, describe, expect, it, vi } from "vitest";
const { scope } = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("@/lib/rls", () => ({ withUserScope: scope }));
vi.mock("@/lib/flags", () => ({ checklistStageGateEnabled: () => true, transferDealSourcedRedesignEnabled: () => false }));
import { listDecisionTasks } from "@/lib/data/decision-cases";

const identity = { role: "OPERATIONS", email: "synthetic-ops@example.test" };
const at = new Date("2026-09-28T12:00:00Z");
function transfer(id = "transfer-roth") {
  return { id, client_sf_id: "client-1", household_sf_id: "household-1",
    client_first_name: "Synthetic", client_last_name: "Client", household_name: "Synthetic Household",
    asset_map_account_type: "Roth IRA", asset_map_custodian: "Synthetic Custodian", asset_map_account_number: "971622147016",
    transferring_firm: null, deal_id: "exact-roth-deal", created_at: at, funding_type: "ACAT_PARTIAL",
    funding_plan_complete: true, funding_plan_version: 1, accounts_opened_at_apex: true,
    funding_initiated: true, cash_in_flight: false, acat_transfer_id: null, acat_record_id: "record-1",
    stage: "DECISION", archived_at: null, tasks: [], decision_cases: [] };
}
function task(id = "task-1") {
  return { id, source_key: "asset-transfer:transfer-roth:standard-partial-acat:track-partial-acat",
    task_key: "track-partial-acat", sort_order: 30, decision_id: null, transfer_id: "transfer-roth",
    parent_task_id: null, title: "Track partial ACAT", owner_team: "OPERATIONS", status: "TODO",
    priority: "NORMAL", created_by: identity.email, created_at: at, updated_at: at, decision: null,
    transfer: transfer() };
}

beforeEach(() => vi.clearAllMocks());

describe("grouped Tasks read model in the caller's scope", () => {
  it("loads exact deals once in the same scope, returns registration and masks the account", async () => {
    const first = task();
    const second = { ...task("task-2"), transfer_id: "transfer-traditional", sort_order: 20,
      transfer: { ...transfer("transfer-traditional"), asset_map_account_type: "Traditional IRA", deal_id: "exact-traditional-deal" } };
    const tx = { decisionTask: { findMany: vi.fn(async () => [first, second]) }, deal: { findMany: vi.fn(async () => [
      { id: "exact-roth-deal", name: "Synthetic Roth deal", statements: true, asset_mapped: false },
    ]) } };
    scope.mockImplementation(async (_identity, fn) => fn(tx));
    const result = await listDecisionTasks(identity);
    expect(scope).toHaveBeenCalledWith(identity, expect.any(Function));
    expect(tx.deal.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: ["exact-roth-deal", "exact-traditional-deal"] } },
      select: { id: true, name: true, statements: true, asset_mapped: true },
    });
    expect(result.map((row) => row.transferSummary?.accountType)).toEqual(["Roth IRA", "Traditional IRA"]);
    expect(result.map((row) => row.sortOrder)).toEqual([30, 20]);
    expect(result[0].taskKey).toBe("track-partial-acat");
    expect(result[0].transferSummary?.deal).toEqual({ id: "exact-roth-deal", name: "Synthetic Roth deal" });
    expect(result[1].transferSummary?.deal).toBeNull();
    expect(result[0].transferSummary?.deliveringAccountLast4).toBe("7016");
    expect(JSON.stringify(result)).not.toContain("971622147016");
    expect(tx.decisionTask.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ transfer: expect.objectContaining({ select: expect.objectContaining({
        recorded_funding_type: true, funding_route_change_pending: true,
        drs_method_change_pending: true, funding_method_revision: true,
        decision_cases: expect.objectContaining({ where: { status: { in: ["OPEN", "SNOOZED"] }, blocks_transfer: true } }),
      }) }) }),
    }));
  });

  it("retains tasks with hidden or missing links and never looks up a household substitute", async () => {
    const hidden = { ...task("hidden"), transfer: null };
    const unlinked = { ...task("unlinked"), transfer_id: null, source_key: null, transfer: null };
    const noDeal = { ...task("no-deal"), transfer: { ...transfer(), deal_id: null } };
    const tx = { decisionTask: { findMany: vi.fn(async () => [hidden, unlinked, noDeal]) }, deal: { findMany: vi.fn() } };
    scope.mockImplementation(async (_identity, fn) => fn(tx));
    const result = await listDecisionTasks(identity);
    expect(result.map((row) => row.id)).toEqual(["hidden", "unlinked", "no-deal"]);
    expect(result[0].transferSummary).toBeNull();
    expect(result[0].context?.transfer?.visible).toBe(false);
    expect(result[1].transferSummary).toBeNull();
    expect(result[1].context?.transfer).toBeNull();
    expect(result[2].transferSummary?.deal).toBeNull();
    expect(tx.deal.findMany).not.toHaveBeenCalled();
  });

  it("preserves route-changed task status and inactive context while enriching the transfer", async () => {
    const changed = { ...task(), status: "DONE", transfer: { ...transfer(), funding_type: "WIRE", deal_id: null } };
    const tx = { decisionTask: { findMany: vi.fn(async () => [changed]) } };
    scope.mockImplementation(async (_identity, fn) => fn(tx));
    const result = await listDecisionTasks(identity);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: "DONE", context: { inactiveReason: "ROUTE_CHANGED" },
      transferSummary: { id: "transfer-roth", fundingType: "WIRE" } });
    expect(changed.status).toBe("DONE");
  });

  it("carries revised partial tokens and a Funded correction without changing active route context", async () => {
    const row = { ...task(), transfer: { ...transfer(), stage: "FUNDED", recorded_funding_type: "ACH",
      funding_method_revision: 3, funding_plan_version: 4 } };
    const tx = { decisionTask: { findMany: vi.fn(async () => [row]) }, deal: { findMany: vi.fn(async () => []) } };
    scope.mockImplementation(async (_identity, fn) => fn(tx));
    const [result] = await listDecisionTasks(identity);
    expect(result.fundingMethod).toEqual({ updatedAt: at.toISOString(), fundingPlanVersion: 4, fundingMethodRevision: 3 });
    expect(result.transferSummary).toMatchObject({ fundingType: "ACH", operationalFundingType: "ACAT_PARTIAL" });
    expect(result.context).toMatchObject({ inactiveReason: null, transfer: { fundingType: "ACAT_PARTIAL" } });
  });

  it("preserves pending DRS metadata and excludes off-route or malformed DRS rows", async () => {
    const row = { ...task("drs"), task_key: "drs-paperwork", owner_team: "CLIENT_SERVICE",
      source_key: "asset-transfer:transfer-roth:drs:paperwork", transfer: {
        ...transfer(), funding_type: "DRS", stage: "IN_TRANSFER", drs_method_change_pending: true,
      } };
    const tx = { decisionTask: { findMany: vi.fn(async () => [row,
      { ...row, id: "wrong-route", transfer: { ...row.transfer, funding_type: "WIRE" } },
      { ...row, id: "wrong-owner", owner_team: "OPERATIONS" },
    ]) }, deal: { findMany: vi.fn(async () => []) } };
    scope.mockImplementation(async (_identity, fn) => fn(tx));
    const result = await listDecisionTasks(identity);
    expect(result.map((task) => task.id)).toEqual(["drs"]);
    expect(result[0].drs).toMatchObject({ methodChangePending: true, stage: "IN_TRANSFER" });
    expect(result[0].transferSummary).toMatchObject({ drsMethodChangePending: true, operationalFundingType: "DRS" });
  });
});
