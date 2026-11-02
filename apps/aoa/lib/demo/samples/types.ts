// The public demo's sample data for the screens production backs with typed fixtures (lib/mock): beneficiaries, the
// Insights profile, meeting prep, Dual-View and the Reminders workflow. build.ts writes it from the shared universe into
// data/*.json, keyed by the CRM ids the demo seeds; index.ts serves it at run time, where the universe file is not
// shipped. Dates are kept as days before the day the demo was seeded (the nightly reset's day), so they stay in step
// with the seeded records. Safe to import from client code.

import type { Beneficiary } from "@/lib/data/types";
import type { DecisionItem, Nudge, Task } from "@/lib/data/workflow-types";
import type { DualViewInsight } from "@/lib/mock/client-experiences";

/** A dated line in Dual-View's real-time or historical column. */
export interface SampleMoment {
  daysAgo: number;
  text: string;
  source: string;
}

export interface SampleDualView {
  label: string;
  description: string;
  meetingLabel: string;
  tenure: string;
  brief: string;
  realTime: SampleMoment[];
  historical: SampleMoment[];
  insights: DualViewInsight[];
}

export interface SamplePrep {
  advisor: string;
  aum: string;
  tenure: string;
  riskProfile: string;
  lastMeeting: { daysAgo: number; label: string };
  recentSignals: string[];
  openItems: string[];
  talkingPoints: string;
  notes: string;
}

export interface ClientSample {
  name: string;
  /** Written by hand for this client (showcase.ts), not generated. */
  showcase: boolean;
  bene: Beneficiary[];
  portrait: Record<string, string>;
  risk: { score: number; tolerance: string };
  prep: SamplePrep | null;
  dualView: SampleDualView | null;
}

export type SampleTask = Omit<Task, "createdAt"> & { createdDaysAgo: number };
export type SampleDecisionItem = Omit<DecisionItem, "tasks"> & { tasks: SampleTask[] };

export interface SampleDecision {
  id: string;
  householdId: string;
  householdName: string;
  meeting: { label: string; daysAgo: number };
  items: SampleDecisionItem[];
}

export interface WorkflowSample {
  decisions: SampleDecision[];
  nudges: Nudge[];
}

export interface DemoSamples {
  /** By client CRM id (003…). */
  clients: Record<string, ClientSample>;
  /** The showcase clients' CRM ids, in the order the Dual-View notice lists them. */
  showcase: Array<{ id: string; name: string }>;
}
