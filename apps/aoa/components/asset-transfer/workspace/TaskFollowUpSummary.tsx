import { followUpDateText, followUpDueLabel, followUpState, type TaskFollowUpFields } from "@/lib/transfers/task-follow-up";

/** The mockup's compact follow-up: person, date and due label. */
export function TaskFollowUpSummary({ task, today }: { task: TaskFollowUpFields; today: string }) {
  const state = followUpState(task, today);
  const label = followUpDueLabel(state);
  const tone = state === "overdue" ? " overdue" : state === "today" ? " today" : state === "completed" ? " historical" : "";
  return (
    <div className={`task-followup compact${tone}`} aria-label={state === "completed" ? "Recorded task follow-up" : "Task follow-up"}>
      <div className="task-followup-summary">
        <span className="task-followup-person">{task.assignedTo ?? "Unassigned"}</span>
        <span className="task-followup-date">
          {state === "completed" ? "Follow-up was " : ""}{task.followUpOn ? followUpDateText(task.followUpOn) : "No follow-up date"}
        </span>
        {label ? <span className="task-followup-due">{label}</span> : null}
      </div>
    </div>
  );
}
