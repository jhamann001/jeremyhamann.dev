import Link from "next/link";
import { Card, CardBody, Pill } from "@/components/ui";
import { TasksTable } from "./TasksTable";
import { transferAccountLabel, transferFundingLabel, transferRegistration, transferStageLabel, type ClientTaskGroup, type TransferTaskGroup } from "./grouped-tasks-model";
import styles from "./GroupedTasks.module.css";

function TransferChecklist({ group, canWrite }: { group: TransferTaskGroup; canWrite: boolean }) {
  const { summary, counts, workflow, other, nextStep } = group;
  const transferLink = group.rows.find((row) => row.context.transfer?.kind === "link")?.context.transfer;
  const archived = group.rows.some((row) => row.context.transferArchived);
  const filtered = group.matchingCount !== counts.all;
  return (
    <Card className={styles.transfer} role="region" data-testid={`transfer-group-${summary.id}`}
      aria-label={`${summary.clientName} · ${transferRegistration(summary)} · ${transferAccountLabel(summary)} · ${summary.id}`}>
      <CardBody>
        <div className={styles.transferHeading}>
          <div>
            <h3>{transferRegistration(summary)}</h3>
            <p className={styles.account}>{summary.deliveringCustodian || "Custodian unavailable"} · {transferAccountLabel(summary)}</p>
          </div>
          <div className={styles.badges}>
            <Pill tone="gray">{transferFundingLabel(summary)}</Pill>
            <Pill tone="blue">{transferStageLabel(summary)}</Pill>
            {archived ? <Pill tone="gray">Transfer archived</Pill> : null}
          </div>
        </div>
        <div className={styles.links}>
          {summary.deal?.id?.trim()
            ? <Link href={`/deals/${encodeURIComponent(summary.deal.id)}`} className={styles.link}>Deal: {summary.deal.name || "View linked deal"} →</Link>
            : <span className={styles.muted}>Linked deal unavailable</span>}
          {transferLink?.kind === "link" ? <Link href={transferLink.href} className={styles.link}>View transfer →</Link> : null}
        </div>
        <p className={styles.reference}>Transfer reference: {summary.id}</p>
        <div className={styles.progress}>
          <strong>{counts.done} of {counts.all} saved tasks done</strong>
          {counts.blocked > 0 ? <span>{counts.blocked} blocked</span> : null}
          {filtered ? <span>{group.matchingCount} match the filter · {counts.all - group.matchingCount} shown for context</span> : null}
        </div>
        <progress className={styles.progressBar} value={counts.done} max={counts.all} aria-label={`${transferRegistration(summary)} task completion`} />
        <p className={styles.next}>
          {nextStep
            ? <><strong>{group.parallel ? "Open task for this stage, step" : nextStep.status === "in_progress" ? "Current step" : "Next unfinished step"} {nextStep.step?.number}:</strong> {nextStep.desc}{nextStep.status === "blocked" ? " (blocked)" : ""}</>
            : counts.done === counts.all ? "All saved tasks are done. Review the transfer for stage readiness."
              : "Review the open tasks and transfer requirements below."}
        </p>

        <div className={styles.requirements}>
          <h4>Requirements and blockers</h4>
          {summary.requirements.length || summary.blockers.length ? <ul>
            {summary.requirements.map((requirement, index) => <li key={`requirement-${index}`}>{requirement}</li>)}
            {summary.blockers.map((blocker) => <li key={blocker.id}>
              <strong>Blocking decision:</strong> {blocker.question}
            </li>)}
          </ul> : <p>No additional blockers shown here. Review full readiness on the transfer.</p>}
          <p className={styles.readiness}>{summary.readinessNote}</p>
        </div>

        {workflow.length > 0 ? <section aria-label="Workflow checklist">
          <h4 className={styles.sectionHeading}>Workflow checklist</h4>
          {group.parallel ? <p className={styles.hint}>DRS steps are grouped by phase. Tasks in the same phase can run in parallel; numbering does not lock later tasks.</p>
            : <p className={styles.hint}>Follow the numbered workflow order. Update each saved status as work progresses.</p>}
          <TasksTable rows={workflow} canWrite={canWrite} layout="checklist" title="Workflow checklist" />
        </section> : null}
        {other.length > 0 ? <section aria-label="Exceptions and other tasks">
          <h4 className={styles.sectionHeading}>Exceptions and other tasks</h4>
          <TasksTable rows={other} canWrite={canWrite} layout="checklist" title="Exceptions and other tasks" />
        </section> : null}
      </CardBody>
    </Card>
  );
}

export function GroupedTasks({ clients, canWrite }: { clients: ClientTaskGroup[]; canWrite: boolean }) {
  return (
    <div className={styles.clients}>
      {clients.map((client) => <details key={client.key} open className={styles.client} data-testid={`client-group-${client.key}`}>
        <summary className={styles.clientHeading}>
          <span className={styles.clientName}>{client.name}</span>
          {client.householdName && client.householdName !== client.name ? <span className={styles.muted}>{client.householdName}</span> : null}
          <span className={styles.muted}>{client.transfers.length} {client.transfers.length === 1 ? "transfer" : "transfers"}</span>
        </summary>
        <div className={styles.transfers}>
          {client.transfers.map((group) => <TransferChecklist key={group.summary.id} group={group} canWrite={canWrite} />)}
        </div>
      </details>)}
    </div>
  );
}
