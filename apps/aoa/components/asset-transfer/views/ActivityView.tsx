import type { WorkspaceActivity, WorkspaceTransfer } from "@/lib/transfers/workspace-queue";
import { Blank, PageHeading } from "@/components/asset-transfer/workspace/ui";
import { workspaceRoleLabel } from "@/components/asset-transfer/workspace/WorkspaceShell";
import { WorkspaceRecordLink } from "./WorkspaceRecordLink";
import { FilterForm } from "./FilterForm";
import { sourceShort } from "./view-helpers";

const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
});

const ACTION_TEXT: Record<string, string> = {
  "transfer.create": "Created the transfer.",
  "transfer.update": "Updated the transfer details.",
  "transfer.stage_change": "Changed the funding stage.",
  "transfer.task_toggle": "Updated a task.",
  "transfer.decision_set": "Recorded a holding decision.",
  "transfer.account_status": "Updated a receiving account’s status.",
  "transfer.funding_plan_approve": "Approved the current funding plan.",
  "transfer.asset_map_link": "Linked the asset-mapping account.",
  "transfer.asset_map_unlink": "Unlinked the asset-mapping account.",
  "transfer.archive": "Archived the transfer.",
  "transfer.statement_record": "Recorded a source statement.",
  "transfer.account_match_record": "Recorded the delivering and receiving account types.",
  "transfer.mailing_record": "Recorded a paperwork mailing.",
  "transfer.submission_record": "Logged the transfer submission.",
  "transfer.tracking_record": "Recorded a tracking update.",
  "transfer.receipt_record": "Recorded received assets.",
  "transfer.check_ticket_record": "Recorded the check service ticket.",
  "transfer.ach_initiation_record": "Recorded the client’s ACH initiation.",
  "transfer.follow_up_record": "Recorded follow-up work.",
  "transfer.outcome_record": "Recorded a transfer outcome.",
};

export function activityText(action: string): string {
  const known = ACTION_TEXT[action];
  if (known) return known;
  const words = action.replace(/^transfer\./, "").replace(/[._]+/g, " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}.` : "Recorded action.";
}

function actorText(role: string | null): string {
  return role ? workspaceRoleLabel(role) : "Recorded";
}

/** Recorded actions across every transfer, newest first. */
export function ActivityView({ transfers, activity, query, scope, listHref }: {
  transfers: WorkspaceTransfer[]; activity: WorkspaceActivity[]; query: string; scope: string; listHref: string;
}) {
  const byId = new Map(transfers.map(transfer => [transfer.id, transfer]));
  const needle = query.trim().toLowerCase();
  const events = activity.flatMap(event => {
    const transfer = byId.get(event.transferId);
    if (!transfer) return [];
    const text = `${transfer.clientName} ${sourceShort(transfer)} ${actorText(event.actor)} ${activityText(event.action)}`.toLowerCase();
    return !needle || text.includes(needle) ? [{ event, transfer }] : [];
  });
  return <>
    <PageHeading kicker="All transfers" title="Transfer activity" text="Recorded actions across every transfer, newest first. Open a transfer for its own activity log." />
    <FilterForm className="toolbar" params={{ view: "activity" }}>
      <input className="search" type="search" name="q" defaultValue={query} aria-label="Search activity" placeholder="Search client, account, or recorded action…" />
    </FilterForm>
    <p className="queue-view-note">{events.length} recorded events</p>
    <section className="activity-list">
      {events.length ? events.map(({ event, transfer }) => (
        <article key={event.id} data-transfer-id={transfer.id}>
          <div className="activity-dot" />
          <div>
            <p className="activity-meta">{TIME.format(new Date(event.at))} · {actorText(event.actor)}</p>
            <h3>{activityText(event.action)}</h3>
            <p>{transfer.clientName} · {sourceShort(transfer)}</p>
          </div>
          <WorkspaceRecordLink scope={scope} listHref={listHref} transferId={transfer.id} from="activity" className="btn tiny">View transfer →</WorkspaceRecordLink>
        </article>
      )) : <Blank>No recorded activity matches this search.</Blank>}
    </section>
  </>;
}
