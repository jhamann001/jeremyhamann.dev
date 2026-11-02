// Task follow-up person and date (mockup TaskFollowups). Pure: no Prisma and
// no server-only, so client components can import it. A follow-up never
// changes the task's owning team or its Ready / Waiting / Completed status.
import { parseIsoDay } from "@/lib/transfers/eastern-day";
import type { TaskStatus } from "@/lib/transfers/workspace-queue";
import type { WorkspaceFollowUpFilter } from "@/lib/navigation/transfer-query";

export const ASSIGNED_TO_MAX = 100;

const FOLLOW_UP_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** "Oct 21, 2026" for a YYYY-MM-DD follow-up date. */
export function followUpDateText(day: string): string {
  const parsed = parseIsoDay(day);
  return parsed ? FOLLOW_UP_DAY.format(parsed) : day;
}

export type TaskFollowUpFields = { status: TaskStatus; assignedTo: string | null; followUpOn: string | null };

export type FollowUpState = "completed" | "none" | "unassigned" | "overdue" | "today" | "scheduled";

export type TaskFollowUpInput = { assignedTo: string; followUpOn: string };
export type TaskFollowUpError = { field: "assignedTo" | "followUpOn" | "form"; message: string };

/** Waiting work, or a Ready task that already carries a follow-up, can be scheduled. */
export function followUpEligible(task: TaskFollowUpFields): boolean {
  if (task.status === "Waiting") return true;
  return task.status === "Ready" && Boolean(task.assignedTo || task.followUpOn);
}

export function followUpState(task: TaskFollowUpFields, today: string): FollowUpState {
  if (task.status === "Completed") return "completed";
  if (!followUpEligible(task)) return "none";
  if (!task.assignedTo || !task.followUpOn) return "unassigned";
  if (task.followUpOn < today) return "overdue";
  return task.followUpOn === today ? "today" : "scheduled";
}

export function followUpDueLabel(state: FollowUpState): string {
  switch (state) {
    case "completed":
      return "Completed";
    case "overdue":
      return "Overdue";
    case "today":
      return "Due today";
    case "none":
    case "unassigned":
    case "scheduled":
      return "";
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

/** Due today & overdue counts a dated follow-up even when its person is missing. */
export function matchesFollowUpFilter(task: TaskFollowUpFields, filter: WorkspaceFollowUpFilter, today: string): boolean {
  if (task.status === "Completed" || !followUpEligible(task)) return false;
  switch (filter) {
    case "due":
      return task.followUpOn != null && task.followUpOn <= today;
    case "missing":
      return !task.assignedTo || !task.followUpOn;
    default: {
      const unreachable: never = filter;
      return unreachable;
    }
  }
}

export function validateTaskFollowUp(
  input: TaskFollowUpInput,
): { ok: true; assignedTo: string; followUpOn: Date } | { ok: false; errors: TaskFollowUpError[] } {
  const errors: TaskFollowUpError[] = [];
  const assignedTo = input.assignedTo.trim().replace(/\s+/g, " ");
  const dayText = input.followUpOn.trim();
  const followUpOn = dayText ? parseIsoDay(dayText) : null;
  if (!assignedTo) errors.push({ field: "assignedTo", message: "Enter the person following up." });
  else if (assignedTo.length > ASSIGNED_TO_MAX) {
    errors.push({ field: "assignedTo", message: `Keep the name within ${ASSIGNED_TO_MAX} characters.` });
  }
  if (!dayText) errors.push({ field: "followUpOn", message: "Choose a follow-up date." });
  else if (!followUpOn) errors.push({ field: "followUpOn", message: "Enter a valid follow-up date." });
  if (errors.length || !followUpOn) return { ok: false, errors };
  return { ok: true, assignedTo, followUpOn };
}
