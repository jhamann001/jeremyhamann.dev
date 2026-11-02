// The demo's Reminders workflow at run time (data/workflow.json, written by build.ts): the showcase households'
// decisions and their clients' queued nudges, keyed by the CRM ids the demo seeds, with dates placed relative to the
// seed's day. lib/data/workflow.ts serves these in place of the development fixtures in demo mode. Safe to import from
// client code.

import type { Decision, Nudge } from "@/lib/data/workflow-types";
import data from "./data/workflow.json";
import { sampleIsoDate, sampleShortDate } from "./dates";
import type { WorkflowSample } from "./types";

const WORKFLOW = data as unknown as WorkflowSample;

export function demoWorkflow(now = new Date()): { decisions: Decision[]; nudges: Nudge[] } {
  return {
    decisions: WORKFLOW.decisions.map((d) => ({
      id: d.id,
      householdId: d.householdId,
      householdName: d.householdName,
      meeting: `${d.meeting.label} · ${sampleShortDate(d.meeting.daysAgo, now)}`,
      items: d.items.map(({ tasks, ...item }) => ({
        ...item,
        tasks: tasks.map(({ createdDaysAgo, ...task }) => ({ ...task, createdAt: sampleIsoDate(createdDaysAgo, now) })),
      })),
    })),
    nudges: WORKFLOW.nudges,
  };
}
