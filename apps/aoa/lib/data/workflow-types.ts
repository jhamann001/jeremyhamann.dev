// Workflow seam + store CONTRACT (Phase C, TDD §3, ADR-1/ADR-3).
//
// This file is the load-bearing contract for the whole Workflow pipeline. C1
// (Decision Center), C2 (Tasks), and C3 (Smart Nudges) compile against these
// types, enums, and action payloads. Freeze these signatures before C1–C3 start:
// changing them after those work orders begin ripples into every screen.
//
// Everything here is pure type-level (no runtime, no `any`). Real functions in
// Phase D will return these same shapes from `app.decision`/`app.task`/`app.nudge`;
// Phase C returns them from `lib/mock`.

// --- Enums (string unions) --------------------------------------------------

export type DecisionStatus = "open" | "snoozed" | "decided";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type TaskPriority = "low" | "normal" | "high";
export type Channel = "email" | "text" | "portal" | "phone_prep";
export type DocStatus = "needed" | "prepared" | "sent" | "signed";
export type NudgeStatus = "ready" | "scheduled" | "sent";

// --- Ownership --------------------------------------------------------------

// group: Operations / Client Service / Advisory / Trade Desk.
// person: a seed advisor name (Avery Stone / Gwen Kuhlman).
export type Owner = { kind: "group" | "person"; label: string };

// --- Apex document catalog --------------------------------------------------

export type DocForm = {
  code: string;
  name: string;
  fields: string[];
  signers: string[];
  supporting?: string;
};
export type DocCatalog = {
  docs: Record<string, DocForm>;
  needs: Record<string, string[]>;
};
export type TaskDoc = { code: string; status: DocStatus };

// --- Pipeline entities ------------------------------------------------------

export type Task = {
  id: string;
  desc: string;
  assignee: Owner;
  status: TaskStatus;
  priority: TaskPriority;
  createdBy: string;
  createdAt: string;
  docs?: TaskDoc[];
  needLabel?: string;
};

export type DecisionItem = {
  id: string;
  what: string;
  rec: string;
  category?: string;
  source?: { label: string; href?: string };
  approval?: {
    version: number;
    approvedBy: string;
    approvedAt: string;
    selections: Record<string, string>;
    selectedIds: string[];
    summary: string;
    taskCount: number;
  };
  owner: Owner;
  status: DecisionStatus;
  snoozeUntil?: string;
  downstream: string;
  tasks: Task[];
};

// One Decision per household (the mockup's per-household card).
export type Decision = {
  id: string;
  householdId: string;
  householdName: string;
  meeting: string;
  items: DecisionItem[];
};

export type Nudge = {
  id: string;
  clientId?: string;
  client: string;
  channel: Channel;
  subject: string;
  when: string;
  templateId: string;
  status: NudgeStatus;
  body: string;
};

export type NudgeTemplate = {
  id: string;
  name: string;
  desc: string;
  uses: number;
  lastUsed: string;
  channel?: Channel;
};

export type PipelineStats = { stalled: number };

// --- Seam return type -------------------------------------------------------

export type WorkflowSeed = {
  decisions: Decision[];
  nudges: Nudge[];
  templates: NudgeTemplate[];
  stats: PipelineStats;
};

// --- Derived projection -----------------------------------------------------

// The flattened Tasks projection. Every row carries its address back into the
// nested decisions→items→tasks tree so a write from the flat Tasks view
// (`updateTask`) resolves to the canonical node — the reducer never mutates a
// projected copy.
export type TaskRow = Task & {
  decisionId: string;
  itemId: string;
  householdName: string;
};

// --- Action payload addresses (C1–C3 depend on these signatures) ------------

export type TaskAddr = { decisionId: string; itemId: string; taskId: string };
export type ItemAddr = { decisionId: string; itemId: string };

// --- Intended-action requirements resolver (ticket, Phase 1) ---------------
//
// Maps an intended action (e.g. "IRA distribution") + ops-entered client state
// to the exact bundle of Apex forms. Pure type-level; the resolver in
// `lib/data/nudge-requirements.ts` reuses the DocForm catalog for name /
// supporting-doc / signers. Client state is ops-entered in Phase 1 — no feed.

export type Registration = "IRA" | "individual" | "joint" | "trust";

export type ClientState = {
  hasLinkedBank: boolean;
  registration: Registration;
  ownership?: "single" | "joint";
};

export type RequirementCondition =
  | { field: "hasLinkedBank"; equals: boolean }
  | { field: "registration"; in: Registration[] }
  | { field: "ownership"; equals: "single" | "joint" };

export type FormRequirement = {
  code: string; // must key into DOCS
  when?: RequirementCondition; // absent = always required
  reason?: string; // overrides the default reason
};

export type IntendedAction = {
  id: string;
  label: string;
  requires: FormRequirement[];
};

export type ResolvedRequirement = {
  code: string;
  name: string;
  reason: string;
  supporting?: string;
  signers: string[];
};
