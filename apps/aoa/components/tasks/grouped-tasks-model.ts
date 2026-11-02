import { DRS_TASKS } from "@/lib/data/drs-workflow";
import { FUNDING_TYPE_LABEL, STAGE_LABEL, type FundingType, type TransferStage } from "@/lib/data/transfer-types";
import type { TaskTransferSummary } from "@/lib/data/task-transfer-summary";
import { countTasks, type PersistedTaskView, type TaskCounts } from "./tasks-model";
import type { FilterValue } from "./StatusFilter";

// Stable keys from the partial-ACAT workflow, not task titles. The server's
// persisted sort order remains on every row; only recognized workflow tasks
// receive numbered steps. Decision/exception tasks never imply a prerequisite.
const PARTIAL_STEPS = [
  "prepare-wet-signature-paperwork",
  "review-submit-partial-acat",
  "track-partial-acat",
] as const;

export type TaskStep = {
  number: number;
  phase: string | null;
  guidance: string | null;
};
export type GroupedTaskRow = PersistedTaskView & {
  step: TaskStep | null;
  filterContext: boolean;
};
export type TransferTaskGroup = {
  summary: TaskTransferSummary;
  rows: GroupedTaskRow[];
  workflow: GroupedTaskRow[];
  other: GroupedTaskRow[];
  counts: TaskCounts;
  matchingCount: number;
  nextStep: GroupedTaskRow | null;
  parallel: boolean;
};
export type ClientTaskGroup = {
  key: string;
  name: string;
  householdName: string;
  transfers: TransferTaskGroup[];
};

const clientNames = new Intl.Collator("en", { sensitivity: "base" });
const compareIds = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function transferCreatedAt(summary: TaskTransferSummary): number {
  const timestamp = Date.parse(summary.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Infinity;
}

export function taskStep(row: PersistedTaskView): TaskStep | null {
  if (row.source !== "ASSET_TRANSFER") return null;
  const partial = PARTIAL_STEPS.findIndex((key) => key === row.taskKey);
  if (partial >= 0) return {
    number: partial + 1,
    phase: null,
    guidance: partial > 0 ? `After step ${partial}: ${partial === 1 ? "review the signed paperwork before submission." : "follow the submitted transfer through completion."}` : null,
  };
  const drs = DRS_TASKS.findIndex((definition) => definition.taskKey === row.taskKey);
  if (drs < 0) return null;
  const definition = DRS_TASKS[drs];
  return {
    number: drs + 1,
    phase: definition.requiredBefore === "IN_TRANSFER" ? "Preparation"
      : definition.requiredBefore === "FUNDED" ? "In transfer" : "Follow-up",
    guidance: null,
  };
}

export function transferRegistration(summary: TaskTransferSummary): string {
  return summary.accountType?.trim() || "Registration unavailable";
}

export function transferAccountLabel(summary: TaskTransferSummary): string {
  // Defensive display guard: never print an accidentally supplied full account.
  const suffix = summary.deliveringAccountLast4?.trim();
  return suffix && /^[a-zA-Z0-9]{4}$/.test(suffix) ? `Account ••••${suffix}` : "Account unavailable";
}

export function transferStageLabel(summary: TaskTransferSummary): string {
  return STAGE_LABEL[summary.stage as TransferStage] ?? "Stage unavailable";
}

export function transferFundingLabel(summary: TaskTransferSummary): string {
  return FUNDING_TYPE_LABEL[summary.fundingType as FundingType] ?? "Funding type unavailable";
}

/** Preserve the entire active transfer when any task matches the filter. */
export function groupTasks(rows: PersistedTaskView[], status: FilterValue = "all"): {
  clients: ClientTaskGroup[];
  other: PersistedTaskView[];
} {
  const clients = new Map<string, ClientTaskGroup>();
  const other: PersistedTaskView[] = [];
  const matches = (row: PersistedTaskView) => status === "all" || row.status === status;
  for (const row of rows) {
    const summary = row.transferSummary;
    if (!summary?.id?.trim() || !summary.clientKey?.trim()) {
      if (matches(row)) other.push(row);
      continue;
    }
    let client = clients.get(summary.clientKey);
    if (!client) {
      client = { key: summary.clientKey, name: summary.clientName?.trim() || "Client name unavailable",
        householdName: summary.householdName, transfers: [] };
      clients.set(summary.clientKey, client);
    }
    let transfer = client.transfers.find((group) => group.summary.id === summary.id);
    if (!transfer) {
      transfer = { summary, rows: [], workflow: [], other: [], counts: countTasks([]), matchingCount: 0,
        nextStep: null, parallel: (summary.operationalFundingType !== undefined
          ? summary.operationalFundingType : summary.fundingType) === "DRS" };
      client.transfers.push(transfer);
    }
    transfer.rows.push({ ...row, step: taskStep(row), filterContext: !matches(row) });
  }
  for (const client of clients.values()) {
    // Choose the same heading even if transfers have different recorded client
    // names. Do this before filtering so changing a filter cannot rename a group.
    client.transfers.sort((a, b) => transferCreatedAt(a.summary) - transferCreatedAt(b.summary)
      || compareIds(a.summary.id, b.summary.id));
    client.name = client.transfers[0].summary.clientName?.trim() || "Client name unavailable";
    client.householdName = client.transfers[0].summary.householdName;
    for (const transfer of client.transfers) {
      transfer.counts = countTasks(transfer.rows);
      transfer.matchingCount = transfer.rows.filter(matches).length;
      transfer.workflow = transfer.rows.filter((row) => row.step).sort((a, b) =>
        a.step!.number - b.step!.number || (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
      transfer.other = transfer.rows.filter((row) => !row.step).sort((a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
      // DRS preparation tasks are parallel within their stage. This highlights
      // an open task in the current stage without inventing predecessor locks.
      transfer.nextStep = transfer.workflow.find((row) => row.status !== "done" && (!transfer.parallel ||
        (transfer.summary.stage === "DECISION" ? row.step?.phase === "Preparation"
          : transfer.summary.stage === "IN_TRANSFER" ? transfer.summary.drsMethodChangePending || row.step?.phase !== "Preparation"
            : transfer.summary.stage === "FUNDED" && row.step?.phase === "Follow-up"))) ?? null;
    }
    // Retain creation order when task status/priority changes or filters hide cards.
    client.transfers = client.transfers.filter((transfer) => transfer.matchingCount > 0);
  }
  return { clients: [...clients.values()].filter((client) => client.transfers.length > 0)
    .sort((a, b) => clientNames.compare(a.name, b.name) || compareIds(a.key, b.key)), other };
}
