"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setTaskFollowUp, toggleTask } from "@/app/(authenticated)/asset-transfer/actions";
import { updateDecisionTask } from "@/app/(authenticated)/(workflow)/decision-center/actions";
import { drsTaskStatusError, type DrsTaskStatus } from "@/lib/data/drs-workflow";
import type { DecisionTaskPriorityValue } from "@/lib/data/decision-cases";
import { partialAcatCompletionUpdate } from "@/lib/transfers/partial-acat-queue";
import { ASSIGNED_TO_MAX, type TaskFollowUpError } from "@/lib/transfers/task-follow-up";
import type { RosterPerson } from "@/lib/transfers/connections";
import { Badge } from "@/components/asset-transfer/workspace/ui";
import { TaskFollowUpSummary } from "@/components/asset-transfer/workspace/TaskFollowUpSummary";
import { DetailDialog } from "./DetailDialog";
import { openWorkflowSection } from "./SectionNav";
import {
  TASK_BUCKETS, badgeToneForTask, bucketLabel, displayTime, taskCounts,
  type DetailTask, type TaskBucket,
} from "./detail-model";

const EMPTY: Record<TaskBucket, string> = {
  Ready: "Nothing is ready right now. Check Waiting for the next dependency.",
  Waiting: "No tasks are waiting on a dependency.",
  Completed: "No tasks have been completed yet.",
};

const SECTION_NAME: Record<DetailTask["section"], string> = {
  intake: "Statement & accounts",
  mapping: "Asset mapping & plan",
  paperwork: "Movement",
  "related-work": "Follow-up & history",
};

export function TaskPanel({ transferId, tasks, contextLine, canWrite, role, stage, methodChangePending, paused, today, roster }: {
  transferId: string; tasks: DetailTask[]; contextLine: string; canWrite: boolean; role: string;
  stage: string; methodChangePending: boolean; paused: boolean; today: string;
  /** AOA users a follow-up can be assigned to; free text when absent. */
  roster?: RosterPerson[];
}) {
  const [bucket, setBucket] = useState<TaskBucket>("Ready");
  const [openId, setOpenId] = useState<string | null>(null);
  const counts = taskCounts(tasks);
  const shown = tasks.filter(task => task.status === bucket);
  const selected = tasks.find(task => task.id === openId) ?? null;

  return (
    <section className="section task-panel" id="transfer-tasks" aria-labelledby="transfer-tasks-title">
      <header className="sectionhead">
        <div>
          <div className="kicker">Existing tasks · This transfer</div>
          <div className="row between"><h2 id="transfer-tasks-title">Tasks</h2><small>{counts.Ready + counts.Waiting} open</small></div>
          <p>Open a task to act or view details.</p>
        </div>
      </header>
      <div className="task-tabs" role="tablist" aria-label="Transfer task status">
        {TASK_BUCKETS.map(key => (
          <button key={key} type="button" role="tab" id={`task-tab-${key}`} aria-selected={bucket === key} aria-controls="task-bucket-panel"
            tabIndex={bucket === key ? 0 : -1} onClick={() => setBucket(key)}>
            {bucketLabel(key)} <b>{counts[key]}</b>
          </button>
        ))}
      </div>
      <div className="task-list" id="task-bucket-panel" role="tabpanel" aria-labelledby={`task-tab-${bucket}`} tabIndex={0}>
        {shown.length ? shown.map(task => (
          <article className="task-card" id={`task-${task.id}`} key={task.id}>
            <button type="button" className="task-open" data-task-detail={task.id} onClick={() => setOpenId(task.id)}
              aria-label={`${task.status === "Completed" ? "View completed task: " : task.status === "Waiting" ? "View waiting task: " : "Open task: "}${task.title}`}>
              <span className="task-name">{task.title}</span>
              <span className="task-meta"><span>{task.owner}</span><span>{task.status === "Ready" ? "Open" : "View"} <span aria-hidden="true">→</span></span></span>
            </button>
          </article>
        )) : <p className="task-empty">{EMPTY[bucket]}</p>}
      </div>
      <DetailDialog title={selected?.title ?? "Task"} open={selected != null} onClose={() => setOpenId(null)}>
        {selected ? (
          <TaskRecord key={selected.id} transferId={transferId} task={selected} contextLine={contextLine} canWrite={canWrite} role={role}
            stage={stage} methodChangePending={methodChangePending} paused={paused} today={today} roster={roster} onClose={() => setOpenId(null)} />
        ) : null}
      </DetailDialog>
    </section>
  );
}

function drsRefusal(task: DetailTask, role: string, stage: string, methodChangePending: boolean): string | null {
  if (!task.drs) return null;
  const current = task.drs.status as DrsTaskStatus;
  return drsTaskStatusError({
    taskKey: task.drs.taskKey, role, stage, status: current === "DONE" ? "TODO" : "DONE", currentStatus: current, methodChangePending,
  });
}

function taskRefusal(task: DetailTask, canWrite: boolean, role: string, stage: string, methodChangePending: boolean, paused: boolean): string | null {
  if (!canWrite) return "Your role can view this task.";
  switch (task.kind) {
    case "drs":
      return drsRefusal(task, role, stage, methodChangePending);
    case "partial-acat":
      return null;
    case "checklist":
      return paused ? "Preparation is paused." : null;
    default: {
      const unreachable: never = task.kind;
      return unreachable;
    }
  }
}

async function saveTask(transferId: string, task: DetailTask): Promise<{ ok: true } | { ok: false; message: string }> {
  switch (task.kind) {
    case "drs": {
      if (!task.drs) return { ok: false, message: "This task is no longer available." };
      return updateDecisionTask({
        taskId: task.id,
        status: task.drs.status === "DONE" ? "TODO" : "DONE",
        priority: task.drs.priority as DecisionTaskPriorityValue,
        expectedUpdatedAt: task.drs.updatedAt,
        expectedFundingPlanVersion: task.drs.fundingPlanVersion,
      });
    }
    case "partial-acat": {
      if (!task.partialAcat) return { ok: false, message: "This task is no longer available." };
      return updateDecisionTask(partialAcatCompletionUpdate({ id: task.id, ...task.partialAcat }));
    }
    case "checklist": {
      const result = await toggleTask(transferId, task.id, !task.done);
      if (result && !result.ok) return { ok: false, message: result.errors[0]?.message ?? "This task could not be updated." };
      return { ok: true };
    }
    default: {
      const unreachable: never = task.kind;
      return unreachable;
    }
  }
}

function TaskRecord({ transferId, task, contextLine, canWrite, role, stage, methodChangePending, paused, today, roster, onClose }: {
  transferId: string; task: DetailTask; contextLine: string; canWrite: boolean; role: string; stage: string;
  methodChangePending: boolean; paused: boolean; today: string; roster?: RosterPerson[]; onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const refusal = taskRefusal(task, canWrite, role, stage, methodChangePending, paused);
  const complete = task.status === "Completed";

  const run = () => {
    setError(null);
    startTransition(async () => {
      const saved = await saveTask(transferId, task);
      if (!saved.ok) { setError(saved.message); return; }
      router.refresh();
      onClose();
    });
  };

  const evidence: Array<[string, string]> = [];
  if (task.done && task.completedBy) evidence.push(["Recorded by", task.completedBy]);
  if (task.done && task.completedAt) evidence.push(["Recorded", displayTime(task.completedAt)]);
  evidence.push(["Section", SECTION_NAME[task.section]]);

  return (
    <>
      <p className="small">{contextLine}</p>
      <div className="row between"><Badge tone={badgeToneForTask(task.status)}>{bucketLabel(task.status)}</Badge><span className="small">{task.owner}</span></div>
      {!complete && refusal ? <p className="task-record-reason">{refusal}</p> : null}
      <dl className="task-evidence">
        {evidence.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {task.kind === "checklist" ? (
        <TaskFollowUpForm transferId={transferId} task={task} canEdit={canWrite && !complete} today={today} roster={roster} />
      ) : null}
      {error ? <p className="upload-error" role="alert">{error}</p> : null}
      <div className="row task-detail-actions">
        {!refusal ? (
          <button type="button" className="btn primary" disabled={pending} onClick={run}>
            {pending ? "Saving…" : complete ? "Reopen task" : "Mark task done"}
          </button>
        ) : null}
        <button type="button" className="btn" onClick={() => { onClose(); openWorkflowSection(task.section); }}>
          Open {SECTION_NAME[task.section]} ↓
        </button>
      </div>
    </>
  );
}

/** The mockup's "Assign follow-up": a person and date, separate from the owning team. */
function TaskFollowUpForm({ transferId, task, canEdit, today, roster }: {
  transferId: string; task: DetailTask; canEdit: boolean; today: string; roster?: RosterPerson[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<TaskFollowUpError[]>([]);
  const [saved, setSaved] = useState(false);
  const assigned = Boolean(task.assignedTo || task.followUpOn);
  const fieldError = (field: TaskFollowUpError["field"]) => errors.find(item => item.field === field)?.message;

  const save = (input: { assignedTo: string; followUpOn: string } | null) => {
    setErrors([]);
    setSaved(false);
    startTransition(async () => {
      const result = await setTaskFollowUp(transferId, task.id, input);
      if (!result.ok) { setErrors(result.errors); return; }
      setSaved(true);
      router.refresh();
    });
  };

  const summary = <TaskFollowUpSummary task={task} today={today} />;
  if (!canEdit) return assigned ? <div className="task-followup-panel">{summary}</div> : null;

  return (
    <form className="task-followup-panel" aria-label={assigned ? "Edit follow-up" : "Assign follow-up"} noValidate
      onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        save({ assignedTo: String(data.get("assignedTo") ?? ""), followUpOn: String(data.get("followUpOn") ?? "") });
      }}>
      <strong>{assigned ? "Edit follow-up" : "Assign follow-up"}</strong>
      {assigned ? summary : null}
      <div className="twocol">
        <label className="field"><span>Assigned person</span>
          {roster ? (
            <select name="assignedTo" required defaultValue={task.assignedTo ?? ""} aria-invalid={Boolean(fieldError("assignedTo")) || undefined}>
              <option value="" disabled>Choose from the AOA user roster</option>
              {task.assignedTo && !roster.some(person => person.name === task.assignedTo)
                ? <option value={task.assignedTo} disabled>{task.assignedTo} · not on the roster</option> : null}
              {roster.map(person => <option key={person.email} value={person.name}>{person.name}</option>)}
            </select>
          ) : (
            <input name="assignedTo" required maxLength={ASSIGNED_TO_MAX} autoComplete="off" defaultValue={task.assignedTo ?? ""}
              placeholder="Person responsible for following up" aria-invalid={Boolean(fieldError("assignedTo")) || undefined} />
          )}
          {fieldError("assignedTo") ? <small className="field-error-message">{fieldError("assignedTo")}</small> : null}
        </label>
        <label className="field"><span>Follow-up date</span>
          <input name="followUpOn" type="date" required defaultValue={task.followUpOn ?? ""} aria-invalid={Boolean(fieldError("followUpOn")) || undefined} />
          {fieldError("followUpOn") ? <small className="field-error-message">{fieldError("followUpOn")}</small> : null}
        </label>
      </div>
      <p className="small">This person follows up on the waiting work. {task.owner} remains the team responsible for the task.</p>
      {fieldError("form") ? <p className="upload-error" role="alert">{fieldError("form")}</p> : null}
      {saved ? <p className="small" role="status">Follow-up saved.</p> : null}
      <div className="row task-followup-form-actions">
        <button className="btn primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save follow-up"}</button>
        {assigned ? <button className="btn quiet tiny" type="button" disabled={pending} onClick={() => save(null)}>Clear follow-up</button> : null}
      </div>
    </form>
  );
}
