"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { HouseholdTaskHistoryRow } from "@/lib/data/types";
import type { HouseholdHistoryPage } from "@/lib/data/household-history";
import { utcDateLabel } from "@/lib/display-date";
import { householdHistoryLocation, isHouseholdTaskAssigneeFilter } from "@/lib/navigation/household-history-query";
import { useProgressiveList } from "@/components/navigation/useProgressiveList";
import { ProgressiveListControls } from "@/components/navigation/ProgressiveListControls";
import { crmTaskUrl } from "@/lib/crm";
import { Pill, type PillTone } from "@/components/ui";
import { rememberTaskDisclosure, TASKS_OPEN_ID } from "./task-disclosures";
import styles from "./TasksCard.module.css";

const EMPTY_META: HouseholdHistoryPage<"tasks">["meta"] = { openCount: 0, completedCount: 0 };

function statusTone(status: string | null): PillTone {
  switch ((status ?? "").trim().toLowerCase()) {
    case "completed":
      return "gray";
    case "in progress":
      return "blue";
    case "waiting on someone else":
      return "gold";
    default:
      return "green"; // Not Started / other → open
  }
}

function assignmentLabel(task: HouseholdTaskHistoryRow): string {
  if (task.assignment_state === "UNASSIGNED") return "Unassigned";
  const name = task.assignee_name?.trim();
  if (task.assignment_state === "ASSIGNED" && name &&
    (task.assignee_type === "USER" || task.assignee_type === "QUEUE")) {
    return `Assigned to: ${name} · ${task.assignee_type === "QUEUE" ? "Queue" : "Person"}`;
  }
  // An unreadable owner or unresolved label is not an unassigned task.
  return "Assignment unavailable";
}

function TaskRow({ task, initiallyOpen, onOpenChange }: {
  task: HouseholdTaskHistoryRow;
  initiallyOpen: boolean;
  onOpenChange: (id: string, open: boolean) => void;
}) {
  const subject = task.subject ?? "Untitled task";
  const taskUrl = crmTaskUrl(task.sf_id);
  // Memory retains a bounded subset, while every live row remains independent.
  // A history restore clears/remounts the rows with fresh authorized data.
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <li className={styles.row} data-list-row-id={task.sf_id}>
      <details className={styles.task} open={open} onToggle={event => {
        event.stopPropagation();
        const next = event.currentTarget.open;
        if (next !== open) {
          setOpen(next);
          onOpenChange(task.sf_id, next);
        }
      }}>
      <summary className={styles.taskSummary}>
        {taskUrl ? (
          <a
            className={styles.subjectLink}
            href={taskUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${subject} — open in CRM (new tab)`}
            title={subject}
            onClick={event => event.stopPropagation()}
          >
            {subject} <span aria-hidden="true">↗</span>
          </a>
        ) : (
          <span className={styles.subject}>{subject}</span>
        )}
        {task.status ? <span className={styles.status}><Pill tone={statusTone(task.status)}>{task.status}</Pill></span> : null}
        <span className={styles.rowMeta}>
          <span className={styles.assignment} title={assignmentLabel(task)}>{assignmentLabel(task)}</span>
          {task.source_modified_at ? (
            <span className={styles.date}>Updated {utcDateLabel(task.source_modified_at)}</span>
          ) : null}
          <span className={styles.taskAction}>
            <span className={styles.viewLabel}>View details</span>
            <span className={styles.hideLabel}>Hide details</span>
            <span className={styles.taskChevron} aria-hidden="true">⌄</span>
          </span>
        </span>
      </summary>
      <div className={styles.details}>
        <h3 className={styles.fullSubject}>{subject}</h3>
        <p className={styles.fullAssignment}>{assignmentLabel(task)}</p>
        <div className={styles.meta}>
          {task.priority ? <span>Priority: {task.priority}</span> : null}
          {taskUrl ? <a href={taskUrl} target="_blank" rel="noopener noreferrer">Open in CRM ↗</a> : null}
        </div>
        {task.description ? <p className={styles.desc}>{task.description}</p> :
          <p className={styles.empty}>No task description is available.</p>}
      </div>
      </details>
    </li>
  );
}

export function TasksCard({ initialPage, householdId, scope, includeCompleted }: {
  initialPage: HouseholdHistoryPage<"tasks">;
  householdId: string;
  scope: string;
  includeCompleted: boolean;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The URL updates before a streamed server card can deliver its new props on
  // Back/Forward. Restore against the URL's filter, never the outgoing props.
  const completedFilter = search.has("tasksCompleted") ? search.get("tasksCompleted") === "1" : false;
  const requestedAssignee = search.get("tasksAssignee");
  const assigneeFilter = isHouseholdTaskAssigneeFilter(requestedAssignee) ? requestedAssignee : "";
  const { href, historyHref } = householdHistoryLocation(pathname, search.toString(), "tasks");
  const params = new URLSearchParams({ household: householdId });
  if (completedFilter) params.set("tasksCompleted", "1");
  if (assigneeFilter) params.set("tasksAssignee", assigneeFilter);
  const state = useProgressiveList({ initialPage, scope, href, historyHref,
    endpoint: `/api/navigation/household-tasks?${params}`, rowIdKey: "sf_id", emptyMeta: EMPTY_META,
    scrollSelector: "[data-history-scroll='tasks']" });
  const { openCount, completedCount } = state.page.meta;
  const assigneeOptions = state.page.meta.assigneeOptions ?? [];
  const expanded = state.expandedIds.includes(TASKS_OPEN_ID);
  function changeFilter(key: "tasksCompleted" | "tasksAssignee", value: string) {
    state.pause();
    const next = new URLSearchParams(search.toString());
    if (value) next.set(key, value); else next.delete(key);
    // Other household sections own their numbered-page selection independently.
    if (next.get("list") === "tasks") { next.delete("list"); next.delete("page"); }
    startTransition(() => router.push(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false }));
  }
  function rememberOpen(id: string, open: boolean) {
    state.setExpandedIds(current => rememberTaskDisclosure(current, id, open));
  }

  return (
    <div ref={state.rootRef} data-history-list="tasks" data-list-ready={state.ready} aria-busy={pending || state.loadState === "restoring"}>
    <details className={styles.tasksCard} open={expanded} onToggle={event => {
      if (event.target !== event.currentTarget) return;
      const open = event.currentTarget.open;
      if (open !== expanded) rememberOpen(TASKS_OPEN_ID, open);
    }}>
      <summary className={styles.summary}>
        <h2>Tasks</h2>
        <span className={styles.count}>
          {openCount} open · {completedCount} completed
        </span>
        <span className={styles.disclosure} aria-hidden="true">＋</span>
      </summary>
      <div className={styles.body}>
        <p className={styles.sub}>Household-level tasks from CRM.</p>
        <label className={styles.filter}>
          <span>Assigned to</span>
          <select value={assigneeFilter} onChange={event => changeFilter("tasksAssignee", event.target.value)}
            disabled={!state.ready || pending || state.loadState === "restoring"}>
            <option value="">All assignments</option>
            {(["QUEUE", "USER"] as const).map(type => {
              const options = assigneeOptions.filter(option => option.type === type);
              return options.length ? <optgroup key={type} label={type === "QUEUE" ? "Queues" : "People"}>
                {options.map(option => <option key={option.token} value={option.token}>{option.label}</option>)}
              </optgroup> : null;
            })}
            <option value="unassigned">Unassigned</option>
            <option value="unavailable">Assignment unavailable</option>
            {assigneeFilter && !["unassigned", "unavailable"].includes(assigneeFilter) &&
              !assigneeOptions.some(option => option.token === assigneeFilter) ?
              <option value={assigneeFilter}>Selected assignment</option> : null}
          </select>
        </label>
        <div className={styles.scroll} data-history-scroll="tasks">
          {state.loadState === "idle" && state.page.total === 0 ?
            <p className={styles.empty}>{assigneeFilter ?
              (completedFilter ? "No tasks for this assignment." : "No open tasks for this assignment.") :
              (completedCount > 0 && !completedFilter ? "No open tasks." : "No tasks on file.")}</p> : null}
          <ul className={styles.list}>
            {/* Preserve outgoing DOM until the hook saves its position on URL changes.
                History restoration itself clears and remounts authorized rows. */}
            {state.page.rows.map(task => <TaskRow key={task.sf_id} task={task}
              initiallyOpen={state.expandedIds.includes(task.sf_id)} onOpenChange={rememberOpen} />)}
          </ul>
          <ProgressiveListControls state={state} label="Tasks" href={href} />
        </div>
        {completedCount > 0 || completedFilter || includeCompleted ? (
          <button type="button" className={styles.toggle} onClick={() => changeFilter("tasksCompleted", completedFilter ? "" : "1")}
            disabled={!state.ready || pending} aria-pressed={completedFilter}>
            {completedFilter ? "Hide completed" : `Show completed (${completedCount})`}
          </button>
        ) : null}
      </div>
    </details>
    </div>
  );
}
