import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listDecisionTasks } from "@/lib/data/decision-cases";
import { getAssetTransferWorkspace } from "@/lib/data/asset-transfer-workspace";
import { assetTransferWorkspaceEnabled, tasksSampleRowsEnabled } from "@/lib/flags";
import { parseTransferBoardQuery } from "@/lib/navigation/transfer-query";
import { safeListHref } from "@/lib/navigation/list-routes";
import { easternToday } from "@/lib/transfers/eastern-day";
import { groupByHousehold } from "@/lib/transfers/workspace-queue";
import { TasksWorkspace } from "@/components/tasks/TasksWorkspace";
import { NonTransferTasks } from "@/components/tasks/NonTransferTasks";
import { WorkQueueView } from "@/components/asset-transfer/views/WorkQueueView";
import { WorkingAs } from "@/components/asset-transfer/workspace/ui";
import { WorkspaceShell } from "@/components/asset-transfer/workspace/WorkspaceShell";

// Tasks — grouped client/transfer checklists and an optional flat work queue,
// whether generated directly by an approved route or by a resolved decision.
// Totals and filters count only the persisted tasks this viewer can read under
// RLS (ticket). The in-memory demo sample rows are off unless the dev-only
// switch is on; it is evaluated here, server-side, and passed down as a boolean
// so the client bundle never reads environment configuration.
// With ASSET_TRANSFER_WORKSPACE on, this tab is the asset transfer work queue.

type SearchParams = Record<string, string | string[] | undefined>;

export default async function TasksPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const session = await auth();
  if (!session?.user) redirect("/");
  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const identity = { role, email: session.user.email ?? null };
  const canWrite = role !== "VIEWER" && identity.email != null;
  if (assetTransferWorkspaceEnabled()) {
    return <TransferWorkQueue identity={identity} canWrite={canWrite} scope={session.navigationScope ?? ""}
      searchParams={searchParams ? await searchParams : {}} />;
  }
  const tasks = await listDecisionTasks(identity);
  return (
    <TasksWorkspace
      durableTasks={tasks}
      canWrite={canWrite}
      role={role}
      sampleRowsEnabled={tasksSampleRowsEnabled()}
    />
  );
}

async function TransferWorkQueue({ identity, canWrite, scope, searchParams }: {
  identity: { role: string; email: string | null }; canWrite: boolean; scope: string; searchParams: SearchParams;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) for (const item of value) params.append(key, item);
    else if (value) params.set(key, value);
  }
  const listHref = safeListHref(params.size ? `/tasks?${params}` : "/tasks");
  if (!listHref) redirect("/tasks");
  params.set("view", "queue");
  let query;
  try { query = parseTransferBoardQuery(params); } catch { redirect("/tasks"); }
  const [{ transfers }, savedTasks] = await Promise.all([getAssetTransferWorkspace(identity), listDecisionTasks(identity)]);
  const householdGroup = query.household ? groupByHousehold(transfers).find(group => group.key === query.household) ?? null : null;
  const nonTransfer = savedTasks.filter(task => task.transferId === null);
  return (
    <WorkspaceShell label="Tasks">
      <div data-workspace-view="queue">
        <WorkQueueView transfers={householdGroup ? householdGroup.transfers : transfers} query={query.query}
          taskStatus={query.workspace.taskStatus} team={query.workspace.team} stage={query.workspace.stage}
          followUp={query.workspace.followUp} today={easternToday()} layout={query.workspace.layout}
          household={householdGroup ? householdGroup.key : ""} householdName={householdGroup?.name ?? null}
          controls={<WorkingAs role={identity.role} />} scope={scope} listHref={listHref} />
      </div>
      {nonTransfer.length ? <NonTransferTasks tasks={nonTransfer} canWrite={canWrite} role={identity.role} /> : null}
    </WorkspaceShell>
  );
}
