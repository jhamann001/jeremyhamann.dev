import { describe, expect, it } from "vitest";
import { DRS_TASKS, drsTaskSourceKey } from "@/lib/data/drs-workflow";
import { PARTIAL_ACAT_EXECUTION_TASKS } from "@/lib/data/partial-acat-tasks";
import { buildTaskTransferSummary, type TaskTransferSummarySource } from "@/lib/data/task-transfer-summary";

function transfer(overrides: Partial<TaskTransferSummarySource> = {}): TaskTransferSummarySource {
  return {
    id: "transfer-roth", client_sf_id: "client-1", household_sf_id: "household-1",
    client_first_name: "Synthetic", client_last_name: "Client", household_name: "Synthetic Household",
    asset_map_account_type: "Roth IRA", asset_map_custodian: "Synthetic Custodian",
    asset_map_account_number: "ABC-12345678", transferring_firm: "Older Custodian",
    funding_type: "ACAT_PARTIAL", stage: "DECISION", created_at: new Date("2026-09-28T12:00:00Z"),
    archived_at: null, deal_id: "deal-roth", funding_plan_complete: true, funding_plan_version: 2,
    accounts_opened_at_apex: false, funding_initiated: false, cash_in_flight: false,
    acat_transfer_id: null, acat_record_id: null, tasks: [], decision_cases: [],
    ...overrides,
  };
}

const options = { linkedDeal: null, checklistGateEnabled: true, legacyGateEnabled: true, drsTasks: [] };

describe("Tasks transfer identity and known missing checks", () => {
  it("keeps same-client Roth and Traditional transfers distinct and only sends account last four", () => {
    const roth = buildTaskTransferSummary(transfer(), options);
    const traditional = buildTaskTransferSummary(transfer({ id: "transfer-traditional", asset_map_account_type: "Traditional IRA" }), options);
    expect(roth.clientKey).toBe(traditional.clientKey);
    expect(roth.id).not.toBe(traditional.id);
    expect([roth.accountType, traditional.accountType]).toEqual(["Roth IRA", "Traditional IRA"]);
    expect(roth.deliveringAccountLast4).toBe("5678");
    expect(JSON.stringify(roth)).not.toContain("12345678");
    expect(roth).not.toHaveProperty("asset_map_account_number");
    expect(roth).not.toHaveProperty("receivingAccount");
  });

  it("never groups clients by name and falls back only to household ID then transfer ID", () => {
    expect(buildTaskTransferSummary(transfer({ client_sf_id: null }), options).clientKey).toBe("household:household-1");
    const first = buildTaskTransferSummary(transfer({ client_sf_id: null, household_sf_id: null }), options);
    const second = buildTaskTransferSummary(transfer({ id: "other", client_sf_id: null, household_sf_id: null }), options);
    expect(first.clientName).toBe(second.clientName);
    expect(first.clientKey).not.toBe(second.clientKey);
    expect(first.clientKey).toBe("transfer:transfer-roth");
  });

  it("requires the exact linked deal and uses no deal funding method as registration", () => {
    const deal = { id: "deal-roth", name: "Synthetic Roth deal", statements: true, asset_mapped: true };
    expect(buildTaskTransferSummary(transfer(), { ...options, linkedDeal: deal }).deal).toEqual({ id: deal.id, name: deal.name });
    expect(buildTaskTransferSummary(transfer({ deal_id: null }), { ...options, linkedDeal: deal }).deal).toBeNull();
    expect(buildTaskTransferSummary(transfer(), { ...options, linkedDeal: { ...deal, id: "same-household-other-deal" } }).deal).toBeNull();
    expect(buildTaskTransferSummary(transfer({ asset_map_account_type: null }), { ...options, linkedDeal: deal }).accountType).toBeNull();
    expect(buildTaskTransferSummary(transfer(), options).deal).toBeNull();
  });

  it("uses current-stage checklist order, exact deal mirror flags and sticky overrides", () => {
    const source = transfer({ tasks: [
      { title: "Run asset mapper", done: true, override_done: false, sort_order: 20 },
      { title: "Collect statements", done: false, override_done: null, sort_order: 10 },
      { title: "Unrelated custom task", done: false, override_done: null, sort_order: 0 },
    ] });
    const deal = { id: "deal-roth", name: "Synthetic Roth deal", statements: true, asset_mapped: true };
    expect(buildTaskTransferSummary(source, { ...options, linkedDeal: deal }).requirements).toEqual(["Run asset mapper"]);
    expect(buildTaskTransferSummary(source, options).requirements).toEqual(["Collect statements", "Run asset mapper"]);
    expect(buildTaskTransferSummary({ ...source, stage: "IN_TRANSFER" }, options).requirements).toEqual([]);
  });

  it("requires versioned approval even with an empty checklist and both readiness flags off", () => {
    const result = buildTaskTransferSummary(transfer({ funding_plan_version: 0 }), {
      ...options, checklistGateEnabled: false, legacyGateEnabled: false,
    });
    expect(result.requirements).toEqual(["Approve the current funding plan before advancing."]);
    expect(result.readinessNote).toContain("full readiness");
    expect(buildTaskTransferSummary(transfer(), options).readinessNote).toContain("full readiness");
  });

  it("directs invalidated In transfer plans back to Preparation using the stage gate's recovery path", () => {
    const invalidated = buildTaskTransferSummary(transfer({
      stage: "IN_TRANSFER", funding_plan_complete: false, funding_plan_version: 2,
    }), options);
    expect(invalidated.requirements).toEqual([
      "Operations must review the invalidated funding plan. Return this transfer to Preparation and approve the current plan before advancing.",
    ]);
    const legacy = buildTaskTransferSummary(transfer({
      stage: "IN_TRANSFER", funding_plan_complete: false, funding_plan_version: 0,
    }), options);
    expect(legacy.requirements).toEqual([
      "Operations must review and approve the current funding plan before marking this transfer Funded.",
    ]);
  });

  it("applies legacy missing checks only when checklist gates are disabled", () => {
    expect(buildTaskTransferSummary(transfer(), options).requirements).toEqual([]);
    const result = buildTaskTransferSummary(transfer(), { ...options, checklistGateEnabled: false });
    expect(result.requirements).toContain("Accounts opened at Apex");
    expect(result.requirements).toContain("Funding Initiated");
    expect(result.requirements.some((requirement) => requirement.includes("real ACAT"))).toBe(true);
  });

  it("shows visible blockers while keeping unlisted legacy decisions out of decision links", () => {
    const result = buildTaskTransferSummary(transfer({ decision_cases: [
      { id: "visible-case", question: "Resolve a registration mismatch", source_key: "manual:visible-case" },
      { id: "legacy-case", question: "Legacy auto-generated judgment", source_key: "asset-transfer:t:excluded-positions" },
    ] }), options);
    expect(result.blockers).toEqual([{ id: "visible-case", question: "Resolve a registration mismatch" }]);
    expect(result.requirements).toContain("Review the transfer's additional blocking decisions on the transfer.");
  });

  it("preserves DRS canonical inventory checks when malformed rows claim to be done", () => {
    const source = transfer({ funding_type: "DRS" });
    const tasks = DRS_TASKS.map((definition) => ({ transfer_id: source.id, decision_id: null,
      source_key: drsTaskSourceKey(source.id, definition.key), task_key: definition.taskKey,
      owner_team: definition.ownerTeam, status: "DONE" }));
    expect(buildTaskTransferSummary(source, { ...options, drsTasks: tasks }).requirements).toEqual([]);
    const corrupt = tasks.map((task, index) => index === 0 ? { ...task, source_key: "wrong" } : task);
    expect(buildTaskTransferSummary(source, { ...options, drsTasks: corrupt }).requirements).toContain(
      "Initialize or repair DRS task: Obtain signed full-transfer paperwork.",
    );
  });

  it("does not claim readiness for archived, Funded or unsupported stages", () => {
    expect(buildTaskTransferSummary(transfer({ archived_at: new Date() }), options).readinessNote).toContain("cannot advance");
    expect(buildTaskTransferSummary(transfer({ stage: "FUNDED" }), options).readinessNote).toContain("remaining reconciliation");
    expect(buildTaskTransferSummary(transfer({ stage: "DISCOVERY" }), options).readinessNote).toContain("unsupported stage");
  });

  it("displays the corrected Funded method without rerouting its execution", () => {
    const result = buildTaskTransferSummary(transfer({ stage: "FUNDED", funding_type: "WIRE",
      recorded_funding_type: "DRS", funding_route_change_pending: true }), options);
    expect(result).toMatchObject({ fundingType: "DRS", operationalFundingType: "WIRE", requirements: [] });
    expect(buildTaskTransferSummary(transfer({ funding_type: "WIRE", recorded_funding_type: "DRS" }), options).fundingType).toBe("WIRE");
  });

  it.each([true, false])("keeps revised-route initiation visible with checklist gate %s", (checklistGateEnabled) => {
    const result = buildTaskTransferSummary(transfer({ funding_type: "ACH", stage: "IN_TRANSFER",
      funding_route_change_pending: true }), { ...options, checklistGateEnabled, legacyGateEnabled: false });
    expect(result.requirements).toEqual(["Confirm funding was initiated using the revised method before advancing."]);
  });

  it("requires the revised partial route's exact stage tasks and link, without inventing old readiness", () => {
    const source = transfer({ funding_route_change_pending: true, accounts_opened_at_apex: true });
    const tasks = PARTIAL_ACAT_EXECUTION_TASKS.map((definition) => ({ transfer_id: source.id, decision_id: null,
      source_key: `asset-transfer:${source.id}:standard-partial-acat:${definition.key}`,
      task_key: definition.key, owner_team: definition.owner, status: "DONE" }));
    const missing = buildTaskTransferSummary(source, options);
    expect(missing.requirements).toEqual([
      ...PARTIAL_ACAT_EXECUTION_TASKS.slice(0, 2).map((task) => task.title),
      "Link and review the ACAT for the revised partial transfer.",
    ]);
    const linked = { ...source, acat_record_id: "synthetic-reviewed-link" };
    const firstTwo = tasks.slice(0, 2);
    expect(buildTaskTransferSummary(linked, { ...options, checklistGateEnabled: false, drsTasks: firstTwo }).requirements).toEqual([]);
    expect(buildTaskTransferSummary({ ...linked, stage: "IN_TRANSFER" }, { ...options, drsTasks: firstTwo }).requirements)
      .toEqual([PARTIAL_ACAT_EXECUTION_TASKS[2].title]);
    const wrongOwner = tasks.map((task, index) => index === 0 ? { ...task, owner_team: "OPERATIONS" } : task);
    expect(buildTaskTransferSummary(linked, { ...options, drsTasks: wrongOwner }).requirements)
      .toContain(PARTIAL_ACAT_EXECUTION_TASKS[0].title);
  });

  it("keeps DRS preparation requirements after an In transfer method change", () => {
    const source = transfer({ funding_type: "DRS", stage: "IN_TRANSFER", drs_method_change_pending: true });
    const tasks = DRS_TASKS.map((definition) => ({ transfer_id: source.id, decision_id: null,
      source_key: drsTaskSourceKey(source.id, definition.key), task_key: definition.taskKey,
      owner_team: definition.ownerTeam, status: definition.requiredBefore === "IN_TRANSFER" ? "TODO" : "DONE" }));
    const result = buildTaskTransferSummary(source, { ...options, drsTasks: tasks });
    expect(result.drsMethodChangePending).toBe(true);
    expect(result.requirements).toEqual(DRS_TASKS.filter((task) => task.requiredBefore === "IN_TRANSFER").map((task) => task.title));
    expect(buildTaskTransferSummary({ ...source, drs_method_change_pending: false }, { ...options, drsTasks: tasks }).requirements).toEqual([]);
  });
});
