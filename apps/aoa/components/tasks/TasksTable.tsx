"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardBody, Pill, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import {
  DocCard,
  StatusSelect,
  PrioritySelect,
  useDocs,
  useWorkflowActions,
} from "@/components/workflow";
import type { TaskRow } from "@/components/workflow";
import type { TaskPriority, TaskStatus } from "@/components/workflow";
import { updateDecisionTask } from "@/app/(authenticated)/(workflow)/decision-center/actions";
import type { DecisionTaskRow } from "@/lib/data/decision-cases";
import type { TaskContextView, TaskLinkView } from "./tasks-model";
import type { TaskTransferSummary } from "@/lib/data/task-transfer-summary";
import { transferAccountLabel, transferRegistration, type TaskStep } from "./grouped-tasks-model";
import styles from "./TasksTable.module.css";

// One Tasks table, used for two clearly separated lists (ticket):
// - "saved": persisted tasks. Status/Priority write through updateDecisionTask;
//   the server re-checks every write. Rows carry linked-record context that was
//   resolved under the viewer's own RLS scope, so a link is shown only when the
//   viewer can open it.
// - "sample": the dev-only demo rows from the ephemeral workflow store. Only
//   these rows carry a {decisionId,itemId} store address; persisted rows no
//   longer carry a fake one. The caller passes the already-filtered rows.
export type TasksTableRow = Omit<TaskRow, "decisionId" | "itemId"> & {
  /** Ephemeral sample-store address; sample rows only. */
  decisionId?: string;
  itemId?: string;
  persistentId?: string;
  isSample?: boolean;
  drs?: DecisionTaskRow["drs"];
  fundingMethod?: DecisionTaskRow["fundingMethod"];
  canUpdate?: boolean;
  readOnlyReason?: string | null;
  context?: TaskContextView;
  transferSummary?: TaskTransferSummary | null;
  step?: TaskStep | null;
  filterContext?: boolean;
};

function LinkedRecord({ view }: { view: TaskLinkView }) {
  return view.kind === "link"
    ? <Link href={view.href} className={styles.link}>{view.label}</Link>
    : <span className={styles.note}>{view.label}</span>;
}

const STATUS_TO_DB = {
  todo: "TODO",
  in_progress: "IN_PROGRESS",
  blocked: "BLOCKED",
  done: "DONE",
} as const;
const PRIORITY_TO_DB = { low: "LOW", normal: "NORMAL", high: "HIGH" } as const;

export function TasksTable({
  rows,
  canWrite = true,
  variant = "saved",
  layout = "table",
  title,
}: {
  rows: TasksTableRow[];
  canWrite?: boolean;
  variant?: "saved" | "sample";
  layout?: "table" | "checklist";
  title?: string;
}) {
  const actions = useWorkflowActions();
  const { docs: catalog } = useDocs();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const updatePersistent = (
    row: TasksTableRow,
    patch: { status?: TaskStatus; priority?: TaskPriority },
  ) => {
    if (!row.persistentId || !canWrite || row.canUpdate === false) return;
    setError(null);
    startTransition(async () => {
      const result = await updateDecisionTask({
        taskId: row.persistentId!,
        status: STATUS_TO_DB[patch.status ?? row.status],
        priority: PRIORITY_TO_DB[patch.priority ?? row.priority],
        ...(row.fundingMethod ? {
          expectedUpdatedAt: row.fundingMethod.updatedAt,
          expectedFundingPlanVersion: row.fundingMethod.fundingPlanVersion,
          expectedFundingMethodRevision: row.fundingMethod.fundingMethodRevision,
        } : {}),
        ...(row.drs ? {
          expectedUpdatedAt: row.drs.updatedAt,
          expectedFundingPlanVersion: row.drs.fundingPlanVersion,
        } : {}),
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  };

  if (layout === "checklist") return (
    <div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <ul className={styles.checklist} aria-label={title ?? "Transfer tasks"}>
        {rows.map((row) => (
          <li key={row.id} className={styles.checklistRow}>
            <span className={`${styles.step} ${row.status === "done" ? styles.stepDone : ""}`} aria-label={row.step ? `Step ${row.step.number}${row.status === "done" ? ", done" : ""}` : undefined}>
              {row.step ? row.step.number : "•"}
            </span>
            <div className={styles.checklistTask}>
              <div className={styles.desc}>{row.desc}</div>
              <div className={styles.sub}>{row.assignee.label}{row.step?.phase ? ` · ${row.step.phase}` : ""}</div>
              {row.step?.guidance ? <div className={styles.sub}>{row.step.guidance}</div> : null}
              {row.filterContext ? <div className={styles.contextLabel}>Context · outside the selected status filter</div> : null}
              {row.context?.resolution ? <div className={styles.sub}>Approved resolution: {row.context.resolution}</div> : null}
              {row.readOnlyReason ? <div className={styles.note}>{row.readOnlyReason}</div> : null}
              {row.context?.decision ? <div className={styles.links}><LinkedRecord view={row.context.decision} /></div> : null}
            </div>
            <div className={styles.checklistControls}>
              <label className={styles.controlLabel}>Status
                <StatusSelect value={row.status}
                  disabled={pending || !canWrite || row.canUpdate === false || !row.persistentId}
                  onChange={(status) => updatePersistent(row, { status })}
                  ariaLabel={`Status for ${row.desc}`} />
              </label>
              <label className={styles.controlLabel}>Priority
                <PrioritySelect value={row.priority}
                  disabled={pending || !canWrite || row.canUpdate === false || !row.persistentId}
                  onChange={(priority) => updatePersistent(row, { priority })}
                  ariaLabel={`Priority for ${row.desc}`} />
              </label>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <h2>{title ?? (variant === "sample" ? "Demo sample tasks" : "All tasks")}</h2>
        <span className={styles.spacer} />
        <Pill tone="gray">{variant === "sample" ? "demo only" : "saved"} · {rows.length}</Pill>
      </CardHeader>
      <CardBody>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <div className={styles.scroll}>
          <Table>
            <THead>
              <TR>
                <TH>Task</TH>
                <TH>Assignee</TH>
                <TH>Status</TH>
                <TH>Priority</TH>
                <TH>Source</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => {
                // Only sample rows have an ephemeral store address.
                const addr = !row.persistentId && row.decisionId && row.itemId
                  ? { decisionId: row.decisionId, itemId: row.itemId, taskId: row.id }
                  : null;
                const docs = addr ? row.docs ?? [] : [];
                const context = row.context;
                return (
                  <Fragment key={row.id}>
                    <TR>
                      <TD>
                        <div className={styles.desc}>{row.desc}</div>
                        {row.needLabel ? (
                          <div className={styles.sub}>{row.needLabel}</div>
                        ) : null}
                        {context?.resolution ? (
                          <div className={styles.sub}>Approved resolution: {context.resolution}</div>
                        ) : null}
                        {row.readOnlyReason ? (
                          <div className={styles.note}>{row.readOnlyReason}</div>
                        ) : null}
                        {docs.length ? (
                          <div className={styles.docTag}>
                            <Pill tone="gray">
                              📎 {docs.length} {docs.length === 1 ? "doc" : "docs"}
                            </Pill>
                          </div>
                        ) : null}
                      </TD>
                      <TD>
                        <Pill tone="blue">{row.assignee.label}</Pill>
                      </TD>
                      <TD>
                        <StatusSelect
                          value={row.status}
                          disabled={Boolean(row.persistentId) && (pending || !canWrite || row.canUpdate === false)}
                          onChange={(status) =>
                            row.persistentId
                              ? updatePersistent(row, { status })
                              : addr && actions.updateTask(addr, { status })
                          }
                          ariaLabel={`Status for ${row.desc}`}
                        />
                      </TD>
                      <TD>
                        <PrioritySelect
                          value={row.priority}
                          disabled={Boolean(row.persistentId) && (pending || !canWrite || row.canUpdate === false)}
                          onChange={(priority) =>
                            row.persistentId
                              ? updatePersistent(row, { priority })
                              : addr && actions.updateTask(addr, { priority })
                          }
                          ariaLabel={`Priority for ${row.desc}`}
                        />
                      </TD>
                      <TD>
                        <div className={styles.desc}>{row.householdName}</div>
                        {row.transferSummary ? <>
                          <div className={styles.sub}>{transferRegistration(row.transferSummary)} · {row.transferSummary.deliveringCustodian || "Custodian unavailable"} · {transferAccountLabel(row.transferSummary)}</div>
                          <div className={styles.reference}>Transfer reference: {row.transferSummary.id}</div>
                          {row.transferSummary.deal?.id?.trim() ? <div className={styles.links}>
                            <Link href={`/deals/${encodeURIComponent(row.transferSummary.deal.id)}`} className={styles.link}>Deal: {row.transferSummary.deal.name || "View linked deal"} →</Link>
                          </div> : <div className={styles.note}>Linked deal unavailable</div>}
                        </> : null}
                        <div className={styles.sub}>
                          {row.isSample ? "Demo sample · " : "Saved · "}by {row.createdBy}
                        </div>
                        {context?.decision || context?.transfer ? (
                          <div className={styles.links}>
                            {context.decision ? <LinkedRecord view={context.decision} /> : null}
                            {context.transfer ? <LinkedRecord view={context.transfer} /> : null}
                            {context.transferArchived ? <Pill tone="gray">Transfer archived</Pill> : null}
                          </div>
                        ) : null}
                      </TD>
                    </TR>
                    {docs.length ? (
                      <TR>
                        <TD colSpan={5}>
                          <div className={styles.docStack}>
                            {docs.map((d) => {
                              const doc = catalog[d.code];
                              if (!doc) return null; // unknown code — skip, never throw
                              return (
                                <DocCard
                                  key={d.code}
                                  doc={doc}
                                  status={d.status}
                                  onStatus={(status) => addr && actions.updateTaskDoc(addr, d.code, status)}
                                />
                              );
                            })}
                          </div>
                        </TD>
                      </TR>
                    ) : null}
                  </Fragment>
                );
              })}
            </TBody>
          </Table>
        </div>
      </CardBody>
    </Card>
  );
}
