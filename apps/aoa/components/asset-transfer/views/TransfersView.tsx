import type { ReactNode } from "react";
import { filterTransfers, nextTask, type WorkspaceLifecycle, type WorkspaceTransfer } from "@/lib/transfers/workspace-queue";
import { WORKSPACE_STAGE_FILTERS, type WorkspaceStageFilter } from "@/lib/navigation/transfer-query";
import { cash, PageHeading } from "@/components/asset-transfer/workspace/ui";
import { WorkspaceRecordLink } from "./WorkspaceRecordLink";
import type { WorkspaceView } from "@/lib/navigation/transfer-query";
import { FilterForm, SubmitOnChangeSelect } from "./FilterForm";
import { QueueBlocker, StageBadges } from "./view-parts";
import { destinationLine, routeText, sourceShort, stageText } from "./view-helpers";

const OUTCOMES: [WorkspaceLifecycle, string][] = [
  ["active", "Active"],
  ["deferred", "Deferred"],
  ["stopped", "Stopped: declined, canceled or purged"],
];

/** All households: every movement from preparation through verified arrival. */
export function TransfersView({ transfers, query, stage, outcome, controls, scope, listHref }: {
  transfers: WorkspaceTransfer[]; query: string; stage: WorkspaceStageFilter | null; outcome: WorkspaceLifecycle | null;
  controls?: ReactNode; scope: string; listHref: string;
}) {
  const shown = filterTransfers(transfers, { query, stage, outcome });
  const funded = shown.filter(transfer => transfer.stage === "FUNDED").length;
  return <>
    <PageHeading kicker="All households" title="Transfers" text="Every transfer across all households and clients, from preparation through verified arrival." controls={controls} />
    <FilterForm className="toolbar" params={{ view: "transfers" }}>
      <input className="search" type="search" name="q" defaultValue={query} aria-label="Search transfers" placeholder="Search client, account, or transfer…" />
      <SubmitOnChangeSelect className="select" name="stage" defaultValue={stage ?? ""} aria-label="Transfer funding stage">
        <option value="">All funding stages</option>
        {WORKSPACE_STAGE_FILTERS.map(value => <option key={value} value={value}>{stageText(value)}</option>)}
      </SubmitOnChangeSelect>
      <SubmitOnChangeSelect className="select" name="outcome" defaultValue={outcome ?? ""} aria-label="Transfer outcome">
        <option value="">All transfer outcomes</option>
        {OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </SubmitOnChangeSelect>
    </FilterForm>
    <p className="queue-view-note">{shown.length} transfers shown · {funded} funded</p>
    <TransferTable transfers={shown} scope={scope} listHref={listHref} from="transfers" />
  </>;
}

/** The Transfers table, shared by the Asset Transfer tab and each household's Transfers card. */
export function TransferTable({ transfers, scope, listHref, from, empty = "No transfers match these filters." }: {
  transfers: readonly WorkspaceTransfer[]; scope: string; listHref: string; from: WorkspaceView; empty?: string;
}) {
  return (
    <div className="transfer-table tablewrap">
      <table>
        <thead><tr><th>Client / source</th><th>Destination / method</th><th>Funding stage</th><th className="money">Planned value</th><th>Next action</th></tr></thead>
        <tbody>
          {transfers.length ? transfers.map(transfer => {
            const task = nextTask(transfer);
            return (
              <tr key={transfer.id} data-transfer-id={transfer.id}>
                <td><strong>{transfer.clientName}</strong><small>{sourceShort(transfer)}</small></td>
                <td>{destinationLine(transfer)}<small>{routeText(transfer)}</small></td>
                <td><StageBadges transfer={transfer} /><QueueBlocker transfer={transfer} /></td>
                <td className="money">{cash(transfer.value)}</td>
                <td>
                  <small>{task ? task.team ?? "Team not assigned" : "Transfer record"}</small>
                  <p>{task?.title ?? "No open tasks"}</p>
                  <WorkspaceRecordLink scope={scope} listHref={listHref} transferId={transfer.id} from={from} className="btn tiny">
                    {task ? "Open task →" : "View transfer →"}
                  </WorkspaceRecordLink>
                </td>
              </tr>
            );
          }) : <tr><td colSpan={5}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
