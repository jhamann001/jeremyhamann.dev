import type { ReactNode } from "react";
import {
  groupByClient,
  queueCounts,
  queueDealTransfers,
  queueEmptyCopy,
  queueRows,
  rowsWithStatus,
  selectedTaskStatus,
  type QueueRow,
  type TaskStatus,
  type WorkspaceTransfer,
} from "@/lib/transfers/workspace-queue";
import { followUpEligible, followUpState } from "@/lib/transfers/task-follow-up";
import {
  WORKSPACE_STAGE_FILTERS,
  WORKSPACE_TEAMS,
  type WorkspaceFollowUpFilter,
  type WorkspaceLayout,
  type WorkspaceStageFilter,
  type WorkspaceTaskStatusFilter,
  type WorkspaceTeam,
} from "@/lib/navigation/transfer-query";
import { Badge, Blank, cash, Metric, PageHeading, Summary, type BadgeTone } from "@/components/asset-transfer/workspace/ui";
import { TaskFollowUpSummary } from "@/components/asset-transfer/workspace/TaskFollowUpSummary";
import { WorkspaceRecordLink } from "./WorkspaceRecordLink";
import { FilterForm, SubmitOnChangeSelect } from "./FilterForm";
import { QueueBlocker } from "./view-parts";
import {
  dealReference,
  dealStageText,
  dealStageTone,
  destinationTo,
  initials,
  plural,
  routeText,
  scopeText,
  sourceWithType,
  stageText,
  viewHref,
} from "./view-helpers";

const STATUS_TABS: WorkspaceTaskStatusFilter[] = ["All", "Ready", "Waiting", "Completed"];
const FOLLOW_UP_OPTIONS: Array<[WorkspaceFollowUpFilter | "", string]> = [
  ["", "All follow-ups"], ["due", "Due today & overdue"], ["missing", "Needs owner or date"],
];

type LinkContext = { scope: string; listHref: string };

export function taskTone(status: TaskStatus): BadgeTone {
  switch (status) {
    case "Ready":
      return "ready";
    case "Waiting":
      return "waiting";
    case "Completed":
      return "completed";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

function TaskFollowUp({ task, today }: { task: QueueRow["task"]; today: string }) {
  if (task.status === "Completed" ? !(task.assignedTo || task.followUpOn) : !followUpEligible(task)) return null;
  return <TaskFollowUpSummary task={task} today={today} />;
}

function DealFollowUps({ rows, today }: { rows: readonly QueueRow[]; today: string }) {
  const followUps = rows.filter(row => row.task.status !== "Completed" && followUpEligible(row.task));
  if (!followUps.length) return null;
  const due = followUps.filter(row => ["overdue", "today"].includes(followUpState(row.task, today))).length;
  const missing = followUps.filter(row => followUpState(row.task, today) === "unassigned").length;
  return (
    <div className="deal-followups">
      <p className="deal-followup-counts">Follow-ups: {due} due · {missing} need an owner or date</p>
      {followUps.map(row => (
        <div className="deal-followup-next" key={row.task.id}>
          <strong>{row.task.title}</strong>
          <TaskFollowUp task={row.task} today={today} />
        </div>
      ))}
    </div>
  );
}

function DealRow({ transfer, rows, shown, links, today }: {
  transfer: WorkspaceTransfer; rows: readonly QueueRow[]; shown: readonly QueueRow[]; links: LinkContext; today: string;
}) {
  const counts = { Ready: 0, Waiting: 0, Completed: 0 };
  for (const row of rows) if (row.transfer.id === transfer.id) counts[row.task.status] += 1;
  const scope = scopeText(transfer);
  return (
    <article className="deal-row" data-deal={transfer.id} data-transfer-id={transfer.id}>
      <div className="identity">
        <strong>{sourceWithType(transfer)}</strong>
        <p>{destinationTo(transfer, " ")} · {routeText(transfer)}</p>
        <small>{dealReference(transfer)}{scope ? ` · ${scope}` : ""}</small>
        <QueueBlocker transfer={transfer} />
      </div>
      <div className="deal-stage"><Badge tone={dealStageTone(transfer.stage)}>{stageText(transfer.stage)}</Badge><p>{dealStageText(transfer)}</p></div>
      <div className="deal-work">
        <strong>{cash(transfer.value)}</strong>
        <small>Planned value</small>
        <p>Matching tasks: {counts.Ready} ready · {counts.Waiting} waiting · {counts.Completed} completed</p>
      </div>
      <WorkspaceRecordLink {...links} transferId={transfer.id} from="queue" className="btn tiny"
        ariaLabel={`Open deal: ${transfer.clientName} · ${routeText(transfer)} · ${dealReference(transfer)}`}>Open deal →</WorkspaceRecordLink>
      <DealFollowUps rows={shown.filter(row => row.transfer.id === transfer.id)} today={today} />
    </article>
  );
}

function TaskRow({ row, links, today }: { row: QueueRow; links: LinkContext; today: string }) {
  const { task, transfer } = row;
  return (
    <div className="taskrow flat" data-task-id={task.id}>
      <div className="identity">
        <strong>{transfer.clientName}</strong>
        <p>{sourceWithType(transfer)}<br />{destinationTo(transfer, " ")} · {routeText(transfer)}</p>
        <small>{dealReference(transfer)}</small>
        <QueueBlocker transfer={transfer} />
      </div>
      <div><strong>{task.title}</strong><p>{stageText(transfer.stage)} · {cash(transfer.value)} planned</p><TaskFollowUp task={task} today={today} /></div>
      <span className="taskowner">{task.team ?? "Team not assigned"}</span>
      <Badge tone={taskTone(task.status)}>{task.status}</Badge>
      <WorkspaceRecordLink {...links} transferId={transfer.id} from="queue" className="btn tiny">View task →</WorkspaceRecordLink>
    </div>
  );
}

/** Choose the next task. Task status stays separate from the funding stage (AC-15). */
export function WorkQueueView({ transfers, query, taskStatus, team, stage, followUp, today, layout, household, householdName, controls, scope, listHref }: {
  transfers: WorkspaceTransfer[]; query: string; taskStatus: WorkspaceTaskStatusFilter | null; team: WorkspaceTeam | null;
  stage: WorkspaceStageFilter | null; followUp: WorkspaceFollowUpFilter | null; today: string; layout: WorkspaceLayout | null;
  household: string; householdName: string | null; controls?: ReactNode; scope: string; listHref: string;
}) {
  const status = selectedTaskStatus(taskStatus);
  const shape: WorkspaceLayout = layout ?? "deal";
  const filters = { query, team, stage, followUp: followUp ? { filter: followUp, today } : null };
  const rows = queueRows(transfers, filters);
  const counts = queueCounts(rows);
  const shown = rowsWithStatus(rows, status);
  const links = { scope, listHref };
  const keep = { view: "queue", q: query, team, stage, followUp, household, layout, taskStatus };
  const deals = groupByClient(queueDealTransfers(transfers, filters, shown, status));
  const flat = groupByClient(transfers).flatMap(group => group.transfers.flatMap(transfer => shown.filter(row => row.transfer.id === transfer.id)));
  return <>
    <PageHeading kicker={householdName ? `Asset transfer work queue · ${householdName}` : "Asset transfer work queue"} title="Tasks"
      text="Choose the next task. Transfer stages remain separate from task status." controls={controls} />
    <Summary className="queue-summary">
      <Metric label="Ready to work" value={<span data-count="Ready">{counts.Ready}</span>} text="Tasks matching these filters." />
      <Metric label="Waiting" value={<span data-count="Waiting">{counts.Waiting}</span>} text="Open each task to see the requirement." />
    </Summary>
    <FilterForm id="queue-filters" params={{ view: "queue", household, layout, taskStatus }} />
    <FilterForm id="queue-status" params={{ ...keep, taskStatus: null }} />
    <FilterForm id="queue-layout" params={{ ...keep, layout: null }} />
    <div className="toolbar">
      <div className="queue-status-control">
        <span className="small">Task status</span>
        <div className="tabs" aria-label="Task status">
          {STATUS_TABS.map(value => (
            <button key={value} type="submit" form="queue-status" name="taskStatus" value={value} data-filter={value.toLowerCase()} aria-pressed={status === value}>
              {value} <b>{counts[value]}</b>
            </button>
          ))}
        </div>
      </div>
      <label className="queue-stage-control small">Funding stage{" "}
        <SubmitOnChangeSelect form="queue-filters" name="stage" className="select" defaultValue={stage ?? ""} aria-label="Filter by funding stage">
          <option value="">All funding stages</option>
          {WORKSPACE_STAGE_FILTERS.map(value => <option key={value} value={value}>{stageText(value)}</option>)}
        </SubmitOnChangeSelect>
      </label>
    </div>
    <div className="toolbar">
      <div className="segmented" aria-label="Queue layout">
        <button type="submit" form="queue-layout" name="layout" value="deal" aria-pressed={shape === "deal"}>By deal</button>
        <button type="submit" form="queue-layout" name="layout" value="flat" aria-pressed={shape === "flat"}>Flat list</button>
      </div>
      <input form="queue-filters" className="search" type="search" name="q" defaultValue={query} aria-label="Search work queue" placeholder="Search client, account, or task…" />
      <SubmitOnChangeSelect form="queue-filters" name="team" className="select" defaultValue={team ?? ""} aria-label="Filter by team">
        <option value="">All teams</option>
        {WORKSPACE_TEAMS.map(value => <option key={value} value={value}>{value}</option>)}
      </SubmitOnChangeSelect>
      <label className="queue-followup-control small">Follow-up{" "}
        <SubmitOnChangeSelect form="queue-filters" name="followUp" id="task-followup-filter" className="select" defaultValue={followUp ?? ""} aria-label="Filter by follow-up">
          {FOLLOW_UP_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </SubmitOnChangeSelect>
      </label>
      <a className="btn quiet" href={viewHref({ view: "queue" })}>Clear filters</a>
    </div>
    <p className="queue-view-note">{plural(shown.length, "task")} shown</p>
    {shape === "deal"
      ? deals.length
        ? deals.map(group => (
            <section key={group.key} className="queuegroup client-deals" aria-label={`${group.client} deals`}>
              <header className="grouphead">
                <div className="avatar">{initials(group.client)}</div>
                <div className="identity">
                  <strong>{group.client}</strong>
                  <p>{plural(group.transfers.length, "deal")}{status === "All" ? "" : ` with ${status.toLowerCase()} tasks`}</p>
                </div>
              </header>
              {group.transfers.map(transfer => <DealRow key={transfer.id} transfer={transfer} rows={rows} shown={shown} links={links} today={today} />)}
            </section>
          ))
        : <Blank>{queueEmptyCopy("deal", status)}</Blank>
      : flat.length
        ? <section className="queuegroup">{flat.map(row => <TaskRow key={row.task.id} row={row} links={links} today={today} />)}</section>
        : <Blank>{queueEmptyCopy("flat", status)}</Blank>}
  </>;
}
