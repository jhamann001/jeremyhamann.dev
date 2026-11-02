import { describe, expect, it } from "vitest";
import {
  DEMO_ACCOUNT_KEYS,
  DEMO_CLIENT_IDS,
  DEMO_DEAL_IDS,
  DEMO_HOUSEHOLD_IDS,
  DEMO_TRANSFER_IDS,
  PROTECTED_FIRM_ACCOUNT_IDS,
  type DemoReference,
  type DemoTransferBlockerEvidence,
  type DemoTransferCleanupEvidence,
  classifyDemoTransferBlocker,
  demoTransferCleanupBlockers,
  isDemoTransferCleanupEligible,
  opaqueDemoTransferId,
  unexpectedDemoReferences,
} from "../lib/data/demo-data-audit";

describe("demo data audit manifest", () => {
  it("keeps the stable seed-key cardinalities", () => {
    expect(DEMO_HOUSEHOLD_IDS).toHaveLength(5);
    expect(DEMO_CLIENT_IDS).toHaveLength(6);
    expect(DEMO_DEAL_IDS).toHaveLength(24);
    expect(DEMO_TRANSFER_IDS).toHaveLength(12);
    expect(DEMO_ACCOUNT_KEYS).toHaveLength(16);
    expect(PROTECTED_FIRM_ACCOUNT_IDS).toHaveLength(4);
  });

  it("never treats protected firm accounts as synthetic account keys", () => {
    expect(
      PROTECTED_FIRM_ACCOUNT_IDS.some((key) =>
        (DEMO_ACCOUNT_KEYS as readonly string[]).includes(key),
      ),
    ).toBe(false);
  });

  it("flags references outside the reviewed cleanup graph", () => {
    const references: DemoReference[] = [
      {
        group: "client",
        schema: "mirror",
        table: "client",
        column: "sf_id",
        count: 6,
      },
      {
        group: "client",
        schema: "mirror",
        table: "appointment",
        column: "client_sf_id",
        count: 1,
      },
    ];

    expect(unexpectedDemoReferences(references)).toEqual([references[1]]);
  });
});

describe("demo transfer blocker classification", () => {
  const pristine: DemoTransferBlockerEvidence = {
    source: "IMPORT",
    stage: "DECISION",
    archived: false,
    deal_snapshot_matches: true,
    accounts_opened_at_apex: false,
    funding_plan_complete: false,
    funding_initiated: false,
    cash_in_flight: false,
    funding_type_selected: false,
    acat_linked: false,
    asset_map_linked: false,
    ownership_customized: false,
    manual_guidance_present: false,
    sync_flag_present: false,
    actor_present: false,
    completed_tasks: 0,
    task_overrides: 0,
    decisions: 0,
    decided_positions: 0,
    accounts: 0,
    opened_accounts: 0,
    position_flags: 0,
    slack_closeouts: 0,
    slack_items: 0,
    completed_slack_items: 0,
  };

  it("recognizes an untouched deal-sync artifact", () => {
    expect(classifyDemoTransferBlocker(pristine)).toBe("SYNC_PRISTINE");
  });

  it("replaces raw transfer ids with deterministic one-way audit ids", () => {
    const raw = "cm1234567890rawtransfer";
    expect(opaqueDemoTransferId(raw)).toMatch(/^[a-f0-9]{20}$/);
    expect(opaqueDemoTransferId(raw)).toBe(opaqueDemoTransferId(raw));
    expect(opaqueDemoTransferId(raw)).not.toContain(raw);
    expect(opaqueDemoTransferId(`${raw}-other`)).not.toBe(
      opaqueDemoTransferId(raw),
    );
  });

  it.each([
    { stage: "IN_TRANSFER" },
    { actor_present: true },
    { completed_tasks: 1 },
    { decisions: 1 },
    { accounts: 1 },
    { funding_type_selected: true },
    { acat_linked: true },
    { asset_map_linked: true },
    { ownership_customized: true },
    { manual_guidance_present: true },
    { sync_flag_present: true },
    { slack_closeouts: 1 },
  ])("keeps progressed or integrated sync rows blocked: %j", (change) => {
    expect(classifyDemoTransferBlocker({ ...pristine, ...change })).toBe(
      "SYNC_PROGRESSED",
    );
  });

  it.each([
    { source: "APP" },
    { deal_snapshot_matches: false },
  ])("does not call non-sync lineage pristine: %j", (change) => {
    expect(classifyDemoTransferBlocker({ ...pristine, ...change })).toBe(
      "NON_SYNC_LINKED",
    );
  });
});

describe("demo transfer cleanup eligibility", () => {
  const stageOnly: DemoTransferCleanupEvidence = {
    source: "IMPORT",
    stage: "FUNDED",
    archived: false,
    deal_snapshot_matches: true,
    deal_projection_matches: true,
    stage_matches_deal: true,
    accounts_opened_at_apex: false,
    funding_plan_complete: false,
    funding_initiated: false,
    cash_in_flight: false,
    funding_type_selected: false,
    acat_linked: false,
    asset_map_linked: false,
    ownership_customized: false,
    manual_guidance_present: false,
    sync_flag_present: false,
    actor_present: false,
    completed_tasks: 0,
    task_overrides: 0,
    task_template_matches: true,
    custom_tasks: 0,
    decisions: 0,
    decided_positions: 0,
    accounts: 0,
    opened_accounts: 0,
    position_flags: 0,
    slack_closeouts: 0,
    slack_items: 0,
    completed_slack_items: 0,
  };

  it("accepts a system-only transfer whose stage exactly follows its demo deal", () => {
    expect(demoTransferCleanupBlockers(stageOnly)).toEqual([]);
    expect(isDemoTransferCleanupEligible(stageOnly)).toBe(true);
  });

  it.each([
    [{ source: "APP" }, "SOURCE_NOT_IMPORT"],
    [{ deal_snapshot_matches: false }, "DEAL_SNAPSHOT_MISMATCH"],
    [{ deal_projection_matches: false }, "DEAL_PROJECTION_MISMATCH"],
    [{ stage_matches_deal: false }, "STAGE_NOT_DEAL_DERIVED"],
    [{ actor_present: true }, "ACTOR_PRESENT"],
    [{ funding_initiated: true }, "WORKFLOW_STATE_PRESENT"],
    [{ acat_linked: true }, "EXTERNAL_LINK_PRESENT"],
    [{ completed_tasks: 1 }, "TASK_ACTIVITY_PRESENT"],
    [{ task_template_matches: false }, "TASK_TEMPLATE_MISMATCH"],
    [{ custom_tasks: 1 }, "CUSTOM_TASK_PRESENT"],
    [{ decisions: 1 }, "DECISION_CHILD_PRESENT"],
    [{ accounts: 1 }, "ACCOUNT_CHILD_PRESENT"],
    [{ position_flags: 1 }, "POSITION_FLAG_PRESENT"],
    [{ slack_items: 1 }, "SLACK_CHILD_PRESENT"],
  ] as const)("blocks drift %j as %s", (change, expected) => {
    const evidence = { ...stageOnly, ...change };
    expect(demoTransferCleanupBlockers(evidence)).toContain(expected);
    expect(isDemoTransferCleanupEligible(evidence)).toBe(false);
  });

  it("reports every independent reason rather than hiding later drift", () => {
    expect(
      demoTransferCleanupBlockers({
        ...stageOnly,
        source: "APP",
        actor_present: true,
        custom_tasks: 2,
      }),
    ).toEqual([
      "SOURCE_NOT_IMPORT",
      "ACTOR_PRESENT",
      "CUSTOM_TASK_PRESENT",
    ]);
  });
});
