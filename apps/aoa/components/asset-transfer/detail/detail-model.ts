// Flag-on transfer detail presentation model (mockup fidelity). Pure: no
// Prisma, no React, no server-only — the server page and client dialogs share it.
import { WORKSPACE_VIEWS, type WorkspaceView } from "@/lib/navigation/transfer-query";
import { FUNDING_TYPE_LABEL, type FundingType, type TransferStage } from "@/lib/data/transfer-types";
import { includedInInstructions, type EligibilityHolding } from "@/lib/transfers/holding-eligibility";
import type { RouteLabel } from "@/lib/transfers/route-label";
import type { TaskStatus } from "@/lib/transfers/workspace-queue";
import type { BadgeTone } from "@/components/asset-transfer/workspace/ui";

export const CORE_SECTIONS = ["intake", "mapping", "paperwork"] as const;
export type CoreSection = (typeof CORE_SECTIONS)[number];
export type SectionId = CoreSection | "followups" | "history";
export type GuideTarget = CoreSection | "related-work" | "transfer-progress";

export function parseFromView(value: string | string[] | undefined): WorkspaceView {
  const text = Array.isArray(value) ? value[0] : value;
  return (WORKSPACE_VIEWS as readonly string[]).includes(text ?? "") ? (text as WorkspaceView) : "transfers";
}

// ---------------------------------------------------------------------------
// Movement outcome (ATW-10)

export type OutcomeStatus = "active" | "deferred" | "declined" | "canceled" | "purged";

export type OutcomeSummary = {
  status: OutcomeStatus;
  label: string;
  reason: string | null;
  followUpOn: string | null;
  outcomeOn: string | null;
  recordedAt: string | null;
  previous: { outcome: string; reason: string | null; recordedAt: string; resumed: boolean }[];
};

type OutcomeRow = { outcome: string; reason: string | null; followUpOn: string | null; outcomeOn?: string | null; resumed: boolean; recordedAt: string };

function outcomeKey(outcome: string): OutcomeStatus {
  switch (outcome) {
    case "Client declined": return "declined";
    case "Deferred": return "deferred";
    case "Canceled": return "canceled";
    case "Purged": return "purged";
    default: return "active";
  }
}

/** The latest unresumed outcome decides the movement's status; older rows stay as history. */
export function outcomeSummary(outcomes: readonly OutcomeRow[] | null | undefined): OutcomeSummary {
  const rows = outcomes ?? [];
  const latest = rows[0];
  const status = latest && !latest.resumed ? outcomeKey(latest.outcome) : "active";
  const active = status !== "active";
  return {
    status,
    label: active ? latest.outcome : "Active",
    reason: active ? latest.reason : null,
    followUpOn: active ? latest.followUpOn : null,
    outcomeOn: active ? latest.outcomeOn ?? null : null,
    recordedAt: active ? latest.recordedAt : null,
    previous: rows.slice(active ? 1 : 0).map(row => ({ outcome: row.outcome, reason: row.reason, recordedAt: row.recordedAt, resumed: row.resumed })),
  };
}

export function outcomeTerminal(status: OutcomeStatus): boolean {
  return status === "declined" || status === "canceled" || status === "purged";
}

export function outcomeDescription(status: Exclude<OutcomeStatus, "active">): string {
  switch (status) {
    case "deferred": return "Preparation and submission are paused. Resume this transfer when the client is ready; the current plan will be checked again.";
    case "declined": return "The client chose not to proceed. The statement, plan and recorded activity remain available.";
    case "canceled": return "This transfer is stopped. Its submission and any received assets remain in the record.";
    case "purged": return "This transfer was purged at the custodian. Its earlier evidence and activity remain available.";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// Facts the guide and section badges read

export type RejectionState = "open" | "awaiting_review" | "accepted" | null;

export type DetailFacts = {
  stage: TransferStage;
  fundingType: FundingType | null;
  route: RouteLabel | null;
  outcome: OutcomeStatus;
  statementAccepted: boolean;
  accountMatchOk: boolean;
  planApproved: boolean;
  sentPacket: boolean;
  returnedSignature: boolean;
  appAuthorization: boolean;
  submitted: boolean;
  rejection: RejectionState;
  openFollowUpTasks: number;
  historyCount: number;
};

export function fundingStageNumber(stage: TransferStage): 1 | 2 | 3 {
  switch (stage) {
    case "DECISION": return 1;
    case "IN_TRANSFER": return 2;
    case "FUNDED": return 3;
    default: {
      const unreachable: never = stage;
      return unreachable;
    }
  }
}

export const FUNDING_STAGE_LABELS = ["Decision", "In transfer", "Funded"] as const;

export function needsSignature(route: RouteLabel | null): boolean {
  switch (route) {
    case "Full ACAT · signed paperwork · Apex API":
    case "Partial ACAT · signed paperwork · Ascend entry":
    case "Manual · custodian-library process":
    case "DRS · Apex service request":
      return true;
    case "Full ACAT · app authorization · Apex API":
    case "Rollover · physical check":
    case "ACH · client self-service":
    case "Wire · client instructions":
    case null:
      return false;
    default: {
      const unreachable: never = route;
      return unreachable;
    }
  }
}

export function isAcat(fundingType: FundingType | null): boolean {
  return fundingType === "ACAT_FULL" || fundingType === "ACAT_PARTIAL";
}

export function intakeReady(facts: Pick<DetailFacts, "statementAccepted" | "accountMatchOk">): boolean {
  return facts.statementAccepted && facts.accountMatchOk;
}

export type WorkflowGuide = { id: GuideTarget; title: string; text: string; offerApproval: boolean };

function movementGuide(facts: DetailFacts): Pick<WorkflowGuide, "title" | "text"> {
  switch (facts.fundingType) {
    case "WIRE": return { title: "Provide the wire instructions", text: "Use the account-specific instructions and keep the Apex service ticket with this wire." };
    case "ACH": return { title: "Provide the self-service ACH instructions", text: "The client initiates ACH through self-service." };
    case "CHECK": return { title: "Follow the rollover check", text: "Track possession, mailing, and the Apex notice for this check." };
    case "ACAT_FULL":
    case "ACAT_PARTIAL": return { title: "Log the ACAT submission", text: "Use the current authorization or signed paperwork for this plan." };
    case "DRS":
    case "MANUAL":
    case null: return { title: "Complete the movement steps", text: "Use the current authorization or signed paperwork for this plan." };
    default: {
      const unreachable: never = facts.fundingType;
      return unreachable;
    }
  }
}

/** The mockup's "Next step" box, mapped onto the recorded facts. */
export function workflowGuide(facts: DetailFacts): WorkflowGuide {
  const plain = (id: GuideTarget, title: string, text: string): WorkflowGuide => ({ id, title, text, offerApproval: false });
  if (facts.outcome !== "active") {
    return facts.outcome === "deferred"
      ? plain("transfer-progress", "Transfer paused · resume when ready", "The follow-up date and reason are shown above. Resume explicitly before preparation continues.")
      : plain("transfer-progress", "Transfer stopped · evidence retained", facts.submitted
        ? "Review any assets that arrive after the stop. Start a new transfer for a new client instruction."
        : "Start a new transfer if the client gives a new instruction.");
  }
  if (facts.stage === "FUNDED") return plain("related-work", "Funds arrived · finish the follow-ups", "Trade instructions, fee review and cost basis are available below and in Tasks.");
  if (facts.rejection === "open" || facts.rejection === "awaiting_review") {
    return plain("transfer-progress", "Resolve the ACAT rejection", "Use the rejection follow-up above. Open an earlier section if the account details or plan need correction.");
  }
  if (facts.submitted) return plain("paperwork", "Track the movement and confirm arrival", "Earlier preparation is collapsed. Keep the transfer stage current and verify the expected assets when they arrive.");
  if (!intakeReady(facts)) return plain("intake", "Start with the statement and account checks", "Resolve the source-evidence checks before preparing this movement.");
  if (!facts.fundingType) return plain("mapping", "Map the assets and review the funding plan", "Use the current statement to determine what moves and how.");
  const signature = needsSignature(facts.route);
  if (!facts.planApproved) {
    return plain("mapping", signature ? "Approve the current funding plan before generating paperwork" : "Approve the current funding plan",
      `Ops reviews the mapped assets, account checks, and movement instructions before approval.${signature ? " Paperwork generation waits for this approval." : ""}`);
  }
  if (signature && !facts.returnedSignature) {
    return plain("paperwork", "Prepare and follow the required paperwork", "The funding plan is approved. Generate the current packet, send it to the client, and record the returned signature.");
  }
  if (facts.fundingType === "ACAT_FULL" && facts.route === "Full ACAT · app authorization · Apex API" && !facts.appAuthorization) {
    return plain("paperwork", "Record the client’s app authorization", "CS or Ops records the existing authorization for this funding plan. Submission waits for that record.");
  }
  return { id: "paperwork", ...movementGuide(facts), offerApproval: false };
}

/** Mockup workflowSectionOpen: the guide's section opens; the others start closed. */
export function sectionOpen(guide: WorkflowGuide, id: CoreSection): boolean {
  return guide.id === id;
}

export function relatedOpen(guide: WorkflowGuide): boolean {
  return guide.id === "related-work";
}

export function sectionStatus(facts: DetailFacts, id: SectionId): [BadgeTone, string] {
  switch (id) {
    case "intake":
      return intakeReady(facts) ? ["completed", "Checks accepted"] : ["blocked", "Needs attention"];
    case "mapping":
      return facts.planApproved ? ["completed", "Funding plan approved"] : facts.fundingType ? ["waiting", "Ops approval needed"] : ["waiting", "Mapping needed"];
    case "paperwork":
      if (facts.stage === "FUNDED") return ["completed", "Assets arrived"];
      if (facts.submitted) return ["progress", "In transfer"];
      if (facts.rejection === "open" || facts.rejection === "awaiting_review") return ["blocked", "Rejection follow-up"];
      return ["waiting", needsSignature(facts.route) && facts.sentPacket && !facts.returnedSignature ? "Waiting for signature" : "Movement steps"];
    case "followups":
      return facts.openFollowUpTasks ? ["waiting", `${facts.openFollowUpTasks} open ${facts.openFollowUpTasks === 1 ? "task" : "tasks"}`] : ["completed", "Follow-up recorded"];
    case "history":
      return ["neutral", `${facts.historyCount} recorded ${facts.historyCount === 1 ? "event" : "events"}`];
    default: {
      const unreachable: never = id;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// Funding plan bar and route box

export function planApprovalLabel(facts: Pick<DetailFacts, "planApproved" | "statementAccepted" | "accountMatchOk">): { text: string; attention: boolean } {
  if (!intakeReady(facts)) return { text: "Needs attention", attention: true };
  return { text: facts.planApproved ? "Ops approved" : "Ops approval needed", attention: false };
}

export function scopeLabel(fundingType: FundingType | null): string | null {
  switch (fundingType) {
    case "CHECK":
    case "WIRE":
    case "ACH":
      return "Cash only";
    case "MANUAL":
      return "Selected holdings";
    case "ACAT_FULL":
    case "ACAT_PARTIAL":
    case "DRS":
    case null:
      return null;
    default: {
      const unreachable: never = fundingType;
      return unreachable;
    }
  }
}

function shortList(items: string[]): string {
  return items.slice(0, 2).join(", ") + (items.length > 2 ? ` +${items.length - 2} more` : "");
}

/** Mockup fundingBarInstructions: what moves, in words. */
export function fundingBarInstructions(fundingType: FundingType | null, holdings: readonly EligibilityHolding[]): string {
  switch (fundingType) {
    case "ACAT_FULL": return "Entire account as held";
    case "ACH":
    case "WIRE": return "Existing cash only";
    case "CHECK": return "Cash by rollover check";
    case null: return "Asset instructions need review";
    case "ACAT_PARTIAL":
    case "DRS":
    case "MANUAL": {
      const moving = holdings.filter(holding => includedInInstructions(holding)).map(holding => holding.symbol);
      const left = holdings.filter(holding => !includedInInstructions(holding)).map(holding => holding.symbol);
      const parts = [moving.length ? `In kind: ${shortList(moving)}` : "", left.length ? `Stays at source: ${shortList(left)}` : ""].filter(Boolean);
      return parts.join(" · ") || "Asset instructions need review";
    }
    default: {
      const unreachable: never = fundingType;
      return unreachable;
    }
  }
}

export function routeCopy(fundingType: FundingType | null): string {
  switch (fundingType) {
    case "ACAT_FULL": return "Full ACAT moves the entire account as held, with client authorization through the app or client-signed paperwork. Ops approves the current funding plan before paperwork is generated or sent, then submits through the Apex API.";
    case "ACAT_PARTIAL": return "Selected holdings move according to the transfer-form instructions. Ops approves the current funding plan first; CS can then generate and send the partial packet. Ops keys the signed instruction into Ascend.";
    case "MANUAL": return "Ops approves the current funding plan first. Then prepare the packet using the applicable contra playbook and asset instructions; follow the contra requirements for submission.";
    case "DRS": return "DRS can cover the full account or selected holdings. Use the statement and required signed instructions for an Apex service request. Ops approves the current funding plan before paperwork is generated or sent.";
    case "CHECK": return "The client requests liquidation and initiates the rollover distribution. Cash moves by check; no transfer form is required. Provide instructions, offer optional call support, and track check delivery and the Apex ticket.";
    case "ACH": return "Move existing cash only. The client initiates ACH through self-service; track initiation and actual arrival.";
    case "WIRE": return "Move existing cash only. Provide wire instructions, then track the client’s initiation, Apex service ticket, and cash receipt.";
    case null: return "Choose the funding method in Edit mapping & plan. The route decides which paperwork and submission steps apply.";
    default: {
      const unreachable: never = fundingType;
      return unreachable;
    }
  }
}

export function routeText(fundingType: FundingType | null, route: RouteLabel | null): string {
  if (route) return route;
  return fundingType ? FUNDING_TYPE_LABEL[fundingType] : "Funding method not chosen";
}

/** Mockup instructionSummary: "Transfer in kind: A, B · Leave behind: C". */
export function instructionSummary(fundingType: FundingType | null, holdings: readonly EligibilityHolding[]): string {
  if (fundingType === "ACAT_FULL") return holdings.length ? `Transfer in kind: ${holdings.map(holding => holding.symbol).join(", ")}` : "Entire account as held";
  const moving = holdings.filter(holding => includedInInstructions(holding)).map(holding => holding.symbol);
  const left = holdings.filter(holding => !includedInInstructions(holding)).map(holding => holding.symbol);
  return [moving.length ? `Transfer in kind: ${moving.join(", ")}` : "", left.length ? `Leave behind: ${left.join(", ")}` : ""]
    .filter(Boolean).join(" · ") || "No holdings mapped yet";
}

export type MappingRow = {
  symbol: string;
  description: string;
  finding: string;
  findingNote: string;
  included: boolean;
  movement: string;
  instruction: string;
  value: number | null;
};

export function mappingRows(fundingType: FundingType | null, holdings: readonly EligibilityHolding[]): MappingRow[] {
  const acat = isAcat(fundingType);
  return holdings.map(holding => {
    const included = fundingType === "ACAT_FULL" || includedInInstructions(holding);
    const ineligible = holding.ineligible === true || holding.cannotTransferInKind === true;
    return {
      symbol: holding.symbol,
      description: holding.description ?? "Mapped position",
      finding: ineligible ? (acat ? "Not eligible for in-kind ACAT" : "Use selected movement route") : "Eligible for in-kind ACAT",
      findingNote: ineligible && acat ? "Remains at the contra for this ACAT." : "",
      included,
      movement: included ? "All shares" : "Stays at source",
      instruction: !included ? "Left behind; does not hold up this transfer." : holding.decision === "UNDECIDED" ? "Instruction not decided" : "Transfer in kind",
      value: holding.marketValue ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Transfer tracker

export type TrackerTone = "attention" | "completed" | "waiting" | "neutral" | "progress";

export function trackerTone(status: string, stage: TransferStage, outcome: OutcomeStatus): TrackerTone {
  if (/rejected/i.test(status)) return "attention";
  if (outcome === "active" && (/^completed?$/i.test(status) || stage === "FUNDED")) return "completed";
  if (/waiting|pending account opening|pending review|pending contra response|deferred/i.test(status)) return "waiting";
  if (/canceled|purged|declined/i.test(status) || stage === "DECISION") return "neutral";
  return "progress";
}

export function trackerStatus(input: {
  stage: TransferStage; outcomeLabel: string; outcome: OutcomeStatus; acatStatus: string | null; trackingStage: string | null;
}): string {
  if (input.outcome !== "active") return input.outcomeLabel;
  if (input.stage === "DECISION") return "Decision";
  if (input.stage === "FUNDED") return input.acatStatus ?? "Funded";
  return input.acatStatus ?? input.trackingStage ?? "Not recorded";
}

export function submittedLabel(fundingType: FundingType | null, rejected: boolean): string {
  switch (fundingType) {
    case "ACAT_FULL":
    case "ACAT_PARTIAL": return rejected ? "Current attempt submitted" : "Submitted to Apex";
    case "DRS": return "Submitted to Apex";
    case "MANUAL": return "Paperwork mailed";
    case "CHECK":
    case "ACH":
    case "WIRE": return "Client initiation date";
    case null: return "Submitted to Apex";
    default: {
      const unreachable: never = fundingType;
      return unreachable;
    }
  }
}

export function notSubmittedText(fundingType: FundingType | null): string {
  return fundingType === "ACH" || fundingType === "WIRE" || fundingType === "CHECK" ? "Not initiated" : "Not submitted";
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MOMENT = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short",
});

/** A YYYY-MM-DD or ISO value as "Oct 6, 2026"; anything else passes through. */
export function trackingDate(value: string | null | undefined): string {
  if (!value) return "";
  const day = /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : null;
  return day && !Number.isNaN(day.getTime()) ? DAY.format(day) : value;
}

export function displayTime(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : MOMENT.format(at);
}

// ---------------------------------------------------------------------------
// Tasks (ATW-01 model + the DRS workflow)

export type DetailTask = {
  id: string;
  kind: "checklist" | "drs" | "partial-acat";
  title: string;
  status: TaskStatus;
  owner: string;
  section: CoreSection | "related-work";
  done: boolean;
  completedAt: string | null;
  completedBy: string | null;
  /** Checklist follow-up person and YYYY-MM-DD date. DRS and partial-ACAT steps have none. */
  assignedTo: string | null;
  followUpOn: string | null;
  drs?: { taskKey: string; status: string; priority: string; updatedAt: string; fundingPlanVersion: number; ownerTeam: string };
  /** Stored decision-task status, used to mark the step done or reopen it. */
  partialAcat?: { status: string; priority: "LOW" | "NORMAL" | "HIGH"; updatedAt: string; fundingPlanVersion: number; fundingMethodRevision: number };
};

const INTAKE_TITLES = /statement|account number|receiving account|registration/i;
const MAPPING_TITLES = /asset mapper|asset decision|decision worksheet|funding plan|instructions/i;
const FOLLOW_UP_TITLES = /cost basis|fee|template|notify|client communication|reconcil/i;

/** Mockup taskSection: the section a task's action lives in. */
export function taskSection(title: string): DetailTask["section"] {
  if (INTAKE_TITLES.test(title)) return "intake";
  if (MAPPING_TITLES.test(title)) return "mapping";
  if (FOLLOW_UP_TITLES.test(title)) return "related-work";
  return "paperwork";
}

export function drsTaskStatus(status: string): TaskStatus {
  if (status === "DONE") return "Completed";
  return status === "BLOCKED" ? "Waiting" : "Ready";
}

export function teamLabel(team: string | null): string {
  switch (team) {
    case "OPERATIONS": return "Operations";
    case "CLIENT_SERVICE": return "Client Service";
    case null:
    case "": return "Team not assigned";
    default: return team;
  }
}

export type TaskBucket = "Ready" | "Waiting" | "Completed";
export const TASK_BUCKETS: readonly TaskBucket[] = ["Ready", "Waiting", "Completed"];

export function bucketLabel(bucket: TaskBucket): string {
  return bucket === "Completed" ? "Complete" : bucket;
}

export function taskCounts(tasks: readonly DetailTask[]): Record<TaskBucket, number> {
  const counts: Record<TaskBucket, number> = { Ready: 0, Waiting: 0, Completed: 0 };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}

export function badgeToneForTask(status: TaskStatus): BadgeTone {
  switch (status) {
    case "Ready": return "ready";
    case "Waiting": return "waiting";
    case "Completed": return "completed";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// History

export type HistoryEvent = { key: string; at: string; actor: string; text: string };

const ACTION_TEXT: Record<string, string> = {
  "transfer.create": "Created the transfer record.",
  "transfer.update": "Updated the transfer details.",
  "transfer.stage_change": "Changed the funding stage.",
  "transfer.task_toggle": "Updated a task.",
  "transfer.decision_set": "Recorded a holding decision.",
  "transfer.account_status": "Updated a receiving account status.",
  "transfer.funding_plan_approve": "Approved the funding plan.",
  "transfer.position_transferring": "Changed which positions transfer.",
  "transfer.asset_map_link": "Linked the asset map.",
  "transfer.asset_map_unlink": "Unlinked the asset map.",
  "transfer.slack_closeout": "Updated the Slack closeout.",
  "transfer.archive": "Removed the transfer from the board.",
  "transfer.sync_flag_dismiss": "Dismissed the sync review flag.",
  "transfer.statement_record": "Recorded a statement review.",
  "transfer.account_match_record": "Recorded the account-type check.",
  "transfer.mailing_record": "Recorded a mailing.",
  "transfer.submission_record": "Logged the submission.",
  "transfer.tracking_record": "Recorded a tracking update.",
  "transfer.receipt_record": "Recorded a receipt.",
  "transfer.check_ticket_record": "Recorded a check ticket.",
  "transfer.ach_initiation_record": "Recorded the ACH initiation.",
  "transfer.follow_up_record": "Recorded a follow-up.",
  "transfer.outcome_record": "Recorded a transfer outcome.",
};

export function historyActionText(action: string): string {
  const known = ACTION_TEXT[action];
  if (known) return known;
  const words = action.replace(/^transfer\./, "").replace(/[._]+/g, " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}.` : "Recorded an action.";
}

export function roleLabel(role: string | null): string {
  switch (role) {
    case "OPERATIONS":
    case "ADMIN": return "Operations";
    case "CLIENT_SERVICE": return "Client Service";
    case "ADVISOR": return "Advisor";
    case null: return "System";
    default: return role;
  }
}

const STAGE_WORDS: Record<string, string> = { DECISION: "Decision", IN_TRANSFER: "In transfer", FUNDED: "Funded" };

/**
 * One newest-first timeline: audit rows, plus the ATW-10 stage changes and
 * corrections that carry the text the audit detail omits. A stage-change
 * audit row is dropped when its ATW-10 record says more.
 */
export function historyEvents(input: {
  audit: readonly { id: string; at: string; actorRole: string | null; action: string }[];
  stageChanges: readonly { recordedAt: string; previousStage: string; newStage: string }[];
  corrections: readonly { recordedAt: string; correction: string }[];
  outcomes: readonly { recordedAt: string; outcome: string; reason: string | null; resumed: boolean }[];
}): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  const recordedStages = input.stageChanges.length > 0;
  for (const row of input.audit) {
    if (recordedStages && row.action === "transfer.stage_change") continue;
    if (row.action === "transfer.outcome_record" && input.outcomes.length) continue;
    events.push({ key: `audit-${row.id}`, at: row.at, actor: roleLabel(row.actorRole), text: historyActionText(row.action) });
  }
  input.stageChanges.forEach((row, index) => events.push({
    key: `stage-${index}`, at: row.recordedAt, actor: "Recorded stage change",
    text: `Funding stage changed from ${STAGE_WORDS[row.previousStage] ?? row.previousStage} to ${STAGE_WORDS[row.newStage] ?? row.newStage}.`,
  }));
  input.corrections.forEach((row, index) => events.push({ key: `correction-${index}`, at: row.recordedAt, actor: "Correction", text: row.correction }));
  input.outcomes.forEach((row, index) => events.push({
    key: `outcome-${index}`, at: row.recordedAt, actor: "Transfer outcome",
    text: `${row.outcome}${row.reason ? ` · ${row.reason}` : ""}${row.resumed ? " · resumed" : ""}`,
  }));
  return events.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}

export function lastFour(value: string | null | undefined): string | null {
  const clean = (value ?? "").replace(/[^a-zA-Z0-9]/g, "");
  return clean ? clean.slice(-4) : null;
}
