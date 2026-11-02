import { createHash } from "node:crypto";

export const DEMO_HOUSEHOLD_IDS = [
  "HH-1001",
  "HH-1002",
  "HH-1003",
  "HH-2001",
  "HH-2002",
] as const;

export const DEMO_CLIENT_IDS = ["C-1", "C-2", "C-3", "C-4", "C-5", "C-6"] as const;

export const DEMO_DEAL_IDS = Array.from(
  { length: 24 },
  (_, index) => `DEMO-${String(index + 1).padStart(4, "0")}`,
);

export const DEMO_TRANSFER_IDS = Array.from(
  { length: 12 },
  (_, index) => `DEMO-T-${String(index + 1).padStart(4, "0")}`,
);

export const DEMO_ACCOUNT_KEYS = [
  ...Array.from(
    { length: 6 },
    (_, index) => `01SEEDCLIENTACCT${String(index + 1).padStart(10, "0")}`,
  ),
  "01SEEDUNLINKED000000000001",
  "01SEEDUNLINKED000000000002",
  ...Array.from({ length: 6 }, (_, index) => `APX-C${index + 1}-01`),
  "APX-U1-01",
  "APX-U2-01",
] as const;

// These rows were touched by the seed but are deliberately NOT cleanup
// candidates. Staff identities can own auth/session or business records, and
// the firm-account keys were copied from real identifiers for local parity.
export const PROTECTED_STAFF_EMAILS = [
  "admin@example.com",
  "ops@example.com",
  "avery@example.com",
  "blake@example.com",
  "view@example.com",
] as const;

export const PROTECTED_ADVISOR_IDS = ["ADV-AVERY", "ADV-BLAKE"] as const;

export const PROTECTED_FIRM_ACCOUNT_IDS = [
  "01SYNTH6BDYNAGTJ07KC0SFYGY",
  "01SYNTH69JZYE3TD78SPZ4PBWK",
  "01SYNTH1B11MYXFS3Q5B5D2WNW",
  "01SYNTH85BR7BT1ZPYKBDZAC9C",
] as const;

export const DEMO_REFERENCE_GROUPS = {
  household: DEMO_HOUSEHOLD_IDS,
  client: DEMO_CLIENT_IDS,
  deal: DEMO_DEAL_IDS,
  transfer: DEMO_TRANSFER_IDS,
  synthetic_account: DEMO_ACCOUNT_KEYS,
} as const;

export type DemoReferenceGroup = keyof typeof DEMO_REFERENCE_GROUPS;

export type DemoReference = {
  group: DemoReferenceGroup;
  schema: "app" | "mirror";
  table: string;
  column: string;
  count: number;
};

const ALLOWED_REFERENCE_LOCATIONS: Record<DemoReferenceGroup, ReadonlySet<string>> = {
  household: new Set([
    "mirror.household.sf_id",
    "mirror.client.household_id",
    "mirror.client_account_aum.household_sf_id",
    "app.deal.household_sf_id",
    "app.transfer.household_sf_id",
  ]),
  client: new Set([
    "mirror.client.sf_id",
    "mirror.client_account_aum.client_sf_id",
    "app.deal.client_sf_id",
    "app.transfer.client_sf_id",
  ]),
  deal: new Set(["app.deal.sf_deal_id", "app.transfer.deal_sf_id"]),
  transfer: new Set([
    "app.transfer.id",
    "app.transfer_task.transfer_id",
    "app.transfer_decision.transfer_id",
    "app.transfer_position_flag.transfer_id",
    "app.transfer_slack_closeout.transfer_id",
    "app.transfer_slack_item.transfer_id",
    "app.transfer_account.transfer_id",
  ]),
  synthetic_account: new Set([
    "mirror.client_account_aum.custodian_account_id",
    "mirror.client_account_aum.apex_account_number",
  ]),
};

export function referenceLocation(reference: DemoReference): string {
  return `${reference.schema}.${reference.table}.${reference.column}`;
}

export function unexpectedDemoReferences(
  references: readonly DemoReference[],
): DemoReference[] {
  return references.filter(
    (reference) =>
      reference.count > 0 &&
      !ALLOWED_REFERENCE_LOCATIONS[reference.group].has(referenceLocation(reference)),
  );
}

export type DemoTransferBlockerEvidence = {
  source: string;
  stage: string;
  archived: boolean;
  deal_snapshot_matches: boolean;
  accounts_opened_at_apex: boolean;
  funding_plan_complete: boolean;
  funding_initiated: boolean;
  cash_in_flight: boolean;
  funding_type_selected: boolean;
  acat_linked: boolean;
  asset_map_linked: boolean;
  ownership_customized: boolean;
  manual_guidance_present: boolean;
  sync_flag_present: boolean;
  actor_present: boolean;
  completed_tasks: number;
  task_overrides: number;
  decisions: number;
  decided_positions: number;
  accounts: number;
  opened_accounts: number;
  position_flags: number;
  slack_closeouts: number;
  slack_items: number;
  completed_slack_items: number;
};

export type DemoTransferBlockerClassification =
  | "SYNC_PRISTINE"
  | "SYNC_PROGRESSED"
  | "NON_SYNC_LINKED";

export type DemoTransferCleanupEvidence = DemoTransferBlockerEvidence & {
  deal_projection_matches: boolean;
  stage_matches_deal: boolean;
  task_template_matches: boolean;
  custom_tasks: number;
};

export type DemoTransferCleanupBlocker =
  | "SOURCE_NOT_IMPORT"
  | "DEAL_SNAPSHOT_MISMATCH"
  | "DEAL_PROJECTION_MISMATCH"
  | "STAGE_NOT_DEAL_DERIVED"
  | "ARCHIVED"
  | "WORKFLOW_STATE_PRESENT"
  | "FUNDING_TYPE_PRESENT"
  | "EXTERNAL_LINK_PRESENT"
  | "OWNERSHIP_CUSTOMIZED"
  | "MANUAL_GUIDANCE_PRESENT"
  | "SYNC_FLAG_PRESENT"
  | "ACTOR_PRESENT"
  | "TASK_ACTIVITY_PRESENT"
  | "TASK_TEMPLATE_MISMATCH"
  | "CUSTOM_TASK_PRESENT"
  | "DECISION_CHILD_PRESENT"
  | "ACCOUNT_CHILD_PRESENT"
  | "POSITION_FLAG_PRESENT"
  | "SLACK_CHILD_PRESENT";

/** Stable within this audit version, but one-way and never a raw database id. */
export function opaqueDemoTransferId(id: string): string {
  return createHash("sha256")
    .update(`aoa-demo-blocker-v1:${id}`)
    .digest("hex")
    .slice(0, 20);
}

/**
 * Classify a non-manifest transfer linked to a manifest demo deal. The
 * predicate deliberately errs toward review: any workflow progress, external
 * linkage, actor stamp, archive/flag state or snapshot mismatch prevents the
 * row from being called pristine. This is diagnostic only and never approves
 * cleanup.
 */
export function classifyDemoTransferBlocker(
  evidence: DemoTransferBlockerEvidence,
): DemoTransferBlockerClassification {
  if (evidence.source !== "IMPORT" || !evidence.deal_snapshot_matches) {
    return "NON_SYNC_LINKED";
  }

  const progressed =
    evidence.stage !== "DECISION" ||
    evidence.archived ||
    evidence.accounts_opened_at_apex ||
    evidence.funding_plan_complete ||
    evidence.funding_initiated ||
    evidence.cash_in_flight ||
    evidence.funding_type_selected ||
    evidence.acat_linked ||
    evidence.asset_map_linked ||
    evidence.ownership_customized ||
    evidence.manual_guidance_present ||
    evidence.sync_flag_present ||
    evidence.actor_present ||
    evidence.completed_tasks > 0 ||
    evidence.task_overrides > 0 ||
    evidence.decisions > 0 ||
    evidence.decided_positions > 0 ||
    evidence.accounts > 0 ||
    evidence.opened_accounts > 0 ||
    evidence.position_flags > 0 ||
    evidence.slack_closeouts > 0 ||
    evidence.slack_items > 0 ||
    evidence.completed_slack_items > 0;

  return progressed ? "SYNC_PROGRESSED" : "SYNC_PRISTINE";
}

/**
 * Explain why a generated-id transfer cannot join a future demo cleanup set.
 * Stage alone is deliberately not treated as human progress: the deal sync
 * automatically maps COMMITTED/FUNDING/WON to DECISION/IN_TRANSFER/FUNDED.
 * Instead, the stage must exactly match that source-deal mapping and every
 * other workflow/integration/actor signal must remain inert.
 */
export function demoTransferCleanupBlockers(
  evidence: DemoTransferCleanupEvidence,
): DemoTransferCleanupBlocker[] {
  const blockers: DemoTransferCleanupBlocker[] = [];
  if (evidence.source !== "IMPORT") blockers.push("SOURCE_NOT_IMPORT");
  if (!evidence.deal_snapshot_matches)
    blockers.push("DEAL_SNAPSHOT_MISMATCH");
  if (!evidence.deal_projection_matches)
    blockers.push("DEAL_PROJECTION_MISMATCH");
  if (!evidence.stage_matches_deal)
    blockers.push("STAGE_NOT_DEAL_DERIVED");
  if (evidence.archived) blockers.push("ARCHIVED");
  if (
    evidence.accounts_opened_at_apex ||
    evidence.funding_plan_complete ||
    evidence.funding_initiated ||
    evidence.cash_in_flight
  )
    blockers.push("WORKFLOW_STATE_PRESENT");
  if (evidence.funding_type_selected) blockers.push("FUNDING_TYPE_PRESENT");
  if (evidence.acat_linked || evidence.asset_map_linked)
    blockers.push("EXTERNAL_LINK_PRESENT");
  if (evidence.ownership_customized) blockers.push("OWNERSHIP_CUSTOMIZED");
  if (evidence.manual_guidance_present)
    blockers.push("MANUAL_GUIDANCE_PRESENT");
  if (evidence.sync_flag_present) blockers.push("SYNC_FLAG_PRESENT");
  if (evidence.actor_present) blockers.push("ACTOR_PRESENT");
  if (evidence.completed_tasks > 0 || evidence.task_overrides > 0)
    blockers.push("TASK_ACTIVITY_PRESENT");
  if (!evidence.task_template_matches)
    blockers.push("TASK_TEMPLATE_MISMATCH");
  if (evidence.custom_tasks > 0) blockers.push("CUSTOM_TASK_PRESENT");
  if (evidence.decisions > 0 || evidence.decided_positions > 0)
    blockers.push("DECISION_CHILD_PRESENT");
  if (evidence.accounts > 0 || evidence.opened_accounts > 0)
    blockers.push("ACCOUNT_CHILD_PRESENT");
  if (evidence.position_flags > 0) blockers.push("POSITION_FLAG_PRESENT");
  if (
    evidence.slack_closeouts > 0 ||
    evidence.slack_items > 0 ||
    evidence.completed_slack_items > 0
  )
    blockers.push("SLACK_CHILD_PRESENT");
  return blockers;
}

export function isDemoTransferCleanupEligible(
  evidence: DemoTransferCleanupEvidence,
): boolean {
  return demoTransferCleanupBlockers(evidence).length === 0;
}
