// Asset Transfer workspace queue (ATW-01). Pure: no Prisma, no React. Task
// status (Ready / Waiting / Completed) is counted separately from the funding
// stage. Opening a task never writes status or team.
import type { FundingType, TransferStage } from "@/lib/data/transfer-types";
import { matchesFollowUpFilter } from "@/lib/transfers/task-follow-up";
import type {
  WorkspaceFollowUpFilter,
  WorkspaceLayout,
  WorkspaceOutcomeFilter,
  WorkspaceStageFilter,
  WorkspaceTaskStatusFilter,
  WorkspaceTeam,
} from "@/lib/navigation/transfer-query";

export const TASK_STATUSES = ["Ready", "Waiting", "Completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_TEAMS = ["Client Service", "Operations", "Operations / Client Service"] as const;
export type TaskTeam = (typeof TASK_TEAMS)[number];

export type WorkspaceTask = {
  id: string;
  transferId: string;
  title: string;
  sortOrder: number;
  status: TaskStatus;
  team: TaskTeam | null;
  /** Follow-up person and YYYY-MM-DD date; null when not assigned. */
  assignedTo: string | null;
  followUpOn: string | null;
};

/** The delivering account, from the transfer's own and asset-map columns. Numbers carry the last four only. */
export type WorkspaceSource = { institution: string | null; type: string | null; last4: string | null; title?: string | null };

/** The receiving Apex account; `opening` when the matched account is not yet open. */
export type WorkspaceDestination = { type: string | null; last4: string | null; opening: boolean; title?: string | null };

export type WorkspaceReceivingAccount = { label: string; open: boolean };

/** open: no response yet; returned: Operations reviews the response; resolved: accepted, not yet resubmitted. */
export type WorkspaceRejection = { owner: string; status: "open" | "returned" | "resolved" };

export type WorkspaceTransfer = {
  id: string;
  clientName: string;
  clientFirstName: string;
  clientLastName: string;
  clientSfId: string | null;
  householdSfId: string | null;
  householdName: string | null;
  stage: TransferStage;
  fundingType: FundingType | null;
  transferringFirm: string | null;
  receivingAccount: string | null;
  value: number;
  dealId: string | null;
  dealName: string | null;
  dealRef: string | null;
  source: WorkspaceSource;
  destination: WorkspaceDestination;
  receivingAccounts: WorkspaceReceivingAccount[];
  appAuthorized: boolean;
  /** Latest recorded statement: accepted or not, and the day it was recorded. */
  statement: { accepted: boolean; recordedOn: string } | null;
  /** Latest unresumed ATW-10 outcome, if any. */
  outcome: string | null;
  rejection: WorkspaceRejection | null;
  receipts: number;
  tasks: WorkspaceTask[];
};

export type WorkspaceActivity = {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  transferId: string;
};

export type QueueRow = { task: WorkspaceTask; transfer: WorkspaceTransfer };
export type QueueFilters = {
  query: string;
  team: WorkspaceTeam | null;
  stage: WorkspaceStageFilter | null;
  /** `today` is the Eastern YYYY-MM-DD the due filter compares against. */
  followUp?: { filter: WorkspaceFollowUpFilter; today: string } | null;
};
export type QueueCounts = Record<WorkspaceTaskStatusFilter, number>;

export const DEFAULT_TASK_STATUS: WorkspaceTaskStatusFilter = "Ready";

/** AC-6: no status chosen selects Ready. */
export function selectedTaskStatus(status: WorkspaceTaskStatusFilter | null): WorkspaceTaskStatusFilter {
  return status ?? DEFAULT_TASK_STATUS;
}

/** A resolved-done task is Completed; otherwise the stored Waiting holds, else Ready. */
export function effectiveTaskStatus(done: boolean, stored: string): TaskStatus {
  if (done) return "Completed";
  return stored === "Waiting" ? "Waiting" : "Ready";
}

export function taskTeam(value: string | null): TaskTeam | null {
  return (TASK_TEAMS as readonly string[]).includes(value ?? "") ? (value as TaskTeam) : null;
}

/** AC-9: a team filter includes that team and the joint Operations / Client Service owner. */
export function taskMatchesTeam(filter: WorkspaceTeam, team: TaskTeam | null): boolean {
  if (team === null) return false;
  return team === filter || team === "Operations / Client Service";
}

export type HouseholdGroup = { key: string; name: string; transfers: WorkspaceTransfer[] };

/** AC-17: movements sharing a non-empty household_sf_id form one household. */
export function groupByHousehold(transfers: readonly WorkspaceTransfer[]): HouseholdGroup[] {
  const groups = new Map<string, HouseholdGroup>();
  for (const transfer of transfers) {
    const shared = transfer.householdSfId?.trim();
    const key = shared ? `household:${shared}` : `transfer:${transfer.id}`;
    const group = groups.get(key);
    if (group) {
      group.transfers.push(transfer);
      if (!group.name && transfer.householdName) group.name = transfer.householdName;
    } else {
      groups.set(key, { key, name: (shared ? transfer.householdName : null) ?? transfer.clientName, transfers: [transfer] });
    }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export function transferSearchText(transfer: WorkspaceTransfer): string {
  return [transfer.clientName, transfer.householdName, transfer.transferringFirm, transfer.receivingAccount, transfer.dealName,
    transfer.dealRef, transfer.source.institution, transfer.source.type, transfer.source.last4, transfer.destination.type]
    .filter(Boolean).join(" ").toLowerCase();
}

function searchText(row: QueueRow): string {
  return `${transferSearchText(row.transfer)} ${row.task.title.toLowerCase()}`;
}

export type WorkspaceLifecycle = WorkspaceOutcomeFilter;

/** ATW-10: Deferred pauses; Client declined, Canceled and Purged stop the movement. */
export function transferLifecycle(transfer: Pick<WorkspaceTransfer, "outcome">): WorkspaceLifecycle {
  if (transfer.outcome === null) return "active";
  return transfer.outcome === "Deferred" ? "deferred" : "stopped";
}

export type TransferFilters = { query: string; stage: WorkspaceStageFilter | null; outcome: WorkspaceLifecycle | null };

export function filterTransfers(transfers: readonly WorkspaceTransfer[], filters: TransferFilters): WorkspaceTransfer[] {
  const query = filters.query.trim().toLowerCase();
  return transfers.filter(transfer => (!filters.stage || transfer.stage === filters.stage) &&
    (!filters.outcome || transferLifecycle(transfer) === filters.outcome) &&
    (!query || transferSearchText(transfer).includes(query)));
}

/** The task a row's next-action button opens: the first Ready task, else the first open one. */
export function nextTask(transfer: WorkspaceTransfer): WorkspaceTask | null {
  const open = [...transfer.tasks].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .filter(task => task.status !== "Completed");
  return open.find(task => task.status === "Ready") ?? open[0] ?? null;
}

export type ClientGroup = { key: string; client: string; transfers: WorkspaceTransfer[] };

/** The mockup's client deals: one group per client, in first-seen order. */
export function groupByClient(transfers: readonly WorkspaceTransfer[]): ClientGroup[] {
  const groups = new Map<string, ClientGroup>();
  for (const transfer of transfers) {
    const key = transfer.clientSfId ? `client:${transfer.clientSfId}` : `name:${transfer.clientName.toLowerCase()}`;
    const group = groups.get(key);
    if (group) group.transfers.push(transfer);
    else groups.set(key, { key, client: transfer.clientName, transfers: [transfer] });
  }
  return [...groups.values()];
}

/** AC-7/AC-8: search, team, funding stage and follow-up narrow the rows; task status is applied separately. */
export function queueRows(transfers: readonly WorkspaceTransfer[], filters: QueueFilters): QueueRow[] {
  const query = filters.query.trim().toLowerCase();
  const rows: QueueRow[] = [];
  for (const transfer of transfers) {
    if (filters.stage && transfer.stage !== filters.stage) continue;
    for (const task of [...transfer.tasks].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))) {
      const row = { task, transfer };
      if (filters.team && !taskMatchesTeam(filters.team, task.team)) continue;
      if (filters.followUp && !matchesFollowUpFilter(task, filters.followUp.filter, filters.followUp.today)) continue;
      if (query && !searchText(row).includes(query)) continue;
      rows.push(row);
    }
  }
  return rows;
}

export function queueCounts(rows: readonly QueueRow[]): QueueCounts {
  const counts: QueueCounts = { Ready: 0, Waiting: 0, Completed: 0, All: rows.length };
  for (const row of rows) counts[row.task.status] += 1;
  return counts;
}

export function rowsWithStatus(rows: readonly QueueRow[], status: WorkspaceTaskStatusFilter): QueueRow[] {
  return status === "All" ? [...rows] : rows.filter(row => row.task.status === status);
}

/**
 * By deal: movements with a task in the selected status. Under All, a movement
 * that matches the search, stage and team stays listed even with no tasks,
 * unless a follow-up filter is chosen.
 */
export function queueDealTransfers(
  transfers: readonly WorkspaceTransfer[],
  filters: QueueFilters,
  shown: readonly QueueRow[],
  status: WorkspaceTaskStatusFilter,
): WorkspaceTransfer[] {
  const ids = new Set(shown.map(row => row.transfer.id));
  const query = filters.query.trim().toLowerCase();
  const team = filters.team;
  return transfers.filter(transfer => (!filters.stage || transfer.stage === filters.stage) && (ids.has(transfer.id) ||
    (status === "All" && !filters.followUp && (!query || transferSearchText(transfer).includes(query)) &&
      (!team || transfer.tasks.some(task => taskMatchesTeam(team, task.team))))));
}

export type DealGroup = { key: string; name: string; rows: QueueRow[] };

/** By deal: one group per linked deal, or per movement when it has no deal. */
export function groupByDeal(rows: readonly QueueRow[]): DealGroup[] {
  const groups = new Map<string, DealGroup>();
  for (const row of rows) {
    const key = row.transfer.dealId ? `deal:${row.transfer.dealId}` : `transfer:${row.transfer.id}`;
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { key, name: row.transfer.dealName ?? row.transfer.clientName, rows: [row] });
  }
  return [...groups.values()];
}

/** AC-10 through AC-13, exact presentation copy. */
export function queueEmptyCopy(layout: WorkspaceLayout, status: WorkspaceTaskStatusFilter): string {
  switch (layout) {
    case "deal":
      return status === "All" ? "No deals match these filters." : `No deals with ${status.toLowerCase()} tasks match these filters.`;
    case "flat":
      return status === "All" ? "No tasks match these filters." : `No ${status.toLowerCase()} tasks match these filters.`;
    default: {
      const unreachable: never = layout;
      return unreachable;
    }
  }
}
