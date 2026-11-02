import type { PillTone } from "@/components/ui";
import type {
  Channel,
  DecisionStatus,
  DocStatus,
  NudgeStatus,
  TaskPriority,
  TaskStatus,
} from "@/lib/data/workflow-types";

// One status/channel → PillTone map for every Workflow list (TDD cross-screen
// patterns). Screens call these instead of re-deriving tones inline.

const DECISION: Record<DecisionStatus, PillTone> = {
  open: "amber",
  snoozed: "gold",
  decided: "green",
};
const TASK: Record<TaskStatus, PillTone> = {
  todo: "amber",
  in_progress: "blue",
  blocked: "red",
  done: "green",
};
const NUDGE: Record<NudgeStatus, PillTone> = {
  ready: "amber",
  scheduled: "blue",
  sent: "green",
};
const DOC: Record<DocStatus, PillTone> = {
  needed: "amber",
  prepared: "blue",
  sent: "gold",
  signed: "green",
};
const CHANNEL: Record<Channel, PillTone> = {
  email: "blue",
  text: "green",
  portal: "gold",
  phone_prep: "amber",
};

export const decisionTone = (s: DecisionStatus): PillTone => DECISION[s];
export const taskTone = (s: TaskStatus): PillTone => TASK[s];
export const nudgeTone = (s: NudgeStatus): PillTone => NUDGE[s];
export const docTone = (s: DocStatus): PillTone => DOC[s];
export const channelTone = (c: Channel): PillTone => CHANNEL[c];

// Human-readable labels for the enum values.
export const DECISION_STATUS_LABEL: Record<DecisionStatus, string> = {
  open: "Open",
  snoozed: "Snoozed",
  decided: "Decided",
};
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};
export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
};
export const NUDGE_STATUS_LABEL: Record<NudgeStatus, string> = {
  ready: "Ready",
  scheduled: "Scheduled",
  sent: "Sent",
};
export const DOC_STATUS_LABEL: Record<DocStatus, string> = {
  needed: "Needed",
  prepared: "Prepared",
  sent: "Sent",
  signed: "Signed",
};
export const CHANNEL_LABEL: Record<Channel, string> = {
  email: "Email",
  text: "Text",
  portal: "Portal",
  phone_prep: "Phone prep",
};
