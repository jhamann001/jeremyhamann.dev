"use client";

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import { getDocCatalog, getWorkflowSeed } from "@/lib/data/workflow";
import type {
  Decision,
  DecisionItem,
  DocCatalog,
  DocStatus,
  ItemAddr,
  Nudge,
  NudgeTemplate,
  PipelineStats,
  Task,
  TaskAddr,
  TaskRow,
} from "@/lib/data/workflow-types";

// Client-side EPHEMERAL pipeline store (Phase C, TDD ADR-3). Seeded once from the
// mock seam; mutations are in-memory only — NO persistence (no storage, no write
// effects), so a refresh re-seeds. Mounted once via the (workflow) route-group
// layout, so Decision Center / Tasks / Smart Nudges share one instance and a
// mutation in any screen re-renders the others. Wire to real data in Phase D by
// seeding from a server read instead of the mock — hooks/actions stay identical.

const DOC_CATALOG: DocCatalog = getDocCatalog();

type State = {
  decisions: Decision[];
  nudges: Nudge[];
  templates: NudgeTemplate[];
  stats: PipelineStats;
  seq: number; // monotonic counter for generated task ids (deterministic, no random/Date)
};

type Action =
  | { type: "markDecided"; addr: ItemAddr }
  | { type: "undoDecide"; addr: ItemAddr }
  | { type: "wake"; addr: ItemAddr }
  | { type: "snooze"; addr: ItemAddr; until: string }
  | {
      type: "editDecision";
      addr: ItemAddr;
      patch: Partial<Pick<DecisionItem, "what" | "rec" | "owner" | "downstream">>;
    }
  | { type: "upsertDecision"; decision: Decision }
  | { type: "generateTask"; addr: ItemAddr; task: Omit<Task, "id" | "createdAt"> }
  | {
      type: "updateTask";
      addr: TaskAddr;
      patch: Partial<Pick<Task, "status" | "priority">>;
    }
  | { type: "updateTaskDoc"; addr: TaskAddr; code: string; status: DocStatus }
  | { type: "sendNudge"; nudgeId: string }
  | { type: "scheduleNudge"; nudgeId: string; when?: string }
  | { type: "resendNudge"; nudgeId: string };

// --- immutable tree helpers (resolve an addr, transform the matched node) ------
function mapItem(
  decisions: Decision[],
  addr: ItemAddr,
  fn: (item: DecisionItem) => DecisionItem,
): Decision[] {
  return decisions.map((d) =>
    d.id !== addr.decisionId
      ? d
      : { ...d, items: d.items.map((it) => (it.id !== addr.itemId ? it : fn(it))) },
  );
}
function mapTask(
  decisions: Decision[],
  addr: TaskAddr,
  fn: (task: Task) => Task,
): Decision[] {
  return mapItem(decisions, addr, (it) => ({
    ...it,
    tasks: it.tasks.map((t) => (t.id !== addr.taskId ? t : fn(t))),
  }));
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "markDecided":
      return { ...state, decisions: mapItem(state.decisions, action.addr, (it) => ({ ...it, status: "decided", snoozeUntil: undefined })) };
    case "undoDecide":
      return { ...state, decisions: mapItem(state.decisions, action.addr, (it) => ({ ...it, status: "open" })) };
    case "wake":
      return { ...state, decisions: mapItem(state.decisions, action.addr, (it) => ({ ...it, status: "open", snoozeUntil: undefined })) };
    case "snooze":
      return { ...state, decisions: mapItem(state.decisions, action.addr, (it) => ({ ...it, status: "snoozed", snoozeUntil: action.until })) };
    case "editDecision":
      return { ...state, decisions: mapItem(state.decisions, action.addr, (it) => ({ ...it, ...action.patch })) };
    case "upsertDecision": {
      const exists = state.decisions.some((decision) => decision.id === action.decision.id);
      return {
        ...state,
        decisions: exists
          ? state.decisions.map((decision) =>
              decision.id === action.decision.id ? action.decision : decision
            )
          : [action.decision, ...state.decisions],
      };
    }
    case "generateTask": {
      const id = `t-${state.seq}`;
      const task: Task = { ...action.task, id, createdAt: "" };
      return {
        ...state,
        seq: state.seq + 1,
        decisions: mapItem(state.decisions, action.addr, (it) => ({ ...it, tasks: [...it.tasks, task] })),
      };
    }
    case "updateTask":
      return { ...state, decisions: mapTask(state.decisions, action.addr, (t) => ({ ...t, ...action.patch })) };
    case "updateTaskDoc":
      return {
        ...state,
        decisions: mapTask(state.decisions, action.addr, (t) => ({
          ...t,
          docs: (t.docs ?? []).map((d) => (d.code !== action.code ? d : { ...d, status: action.status })),
        })),
      };
    case "sendNudge":
      return { ...state, nudges: state.nudges.map((n) => (n.id !== action.nudgeId ? n : { ...n, status: "sent" })) };
    case "scheduleNudge":
      return { ...state, nudges: state.nudges.map((n) => (n.id !== action.nudgeId ? n : { ...n, status: "scheduled", when: action.when ?? n.when })) };
    case "resendNudge":
      return { ...state, nudges: state.nudges.map((n) => (n.id !== action.nudgeId ? n : { ...n, status: "sent" })) };
    default:
      return state;
  }
}

function init(now: string | undefined): State {
  const seed = getWorkflowSeed(now ? new Date(now) : undefined);
  return { decisions: seed.decisions, nudges: seed.nudges, templates: seed.templates, stats: seed.stats, seq: 1 };
}

type Actions = {
  markDecided: (addr: ItemAddr) => void;
  undoDecide: (addr: ItemAddr) => void;
  wake: (addr: ItemAddr) => void;
  snooze: (addr: ItemAddr, until: string) => void;
  editDecision: (addr: ItemAddr, patch: Partial<Pick<DecisionItem, "what" | "rec" | "owner" | "downstream">>) => void;
  upsertDecision: (decision: Decision) => void;
  generateTask: (addr: ItemAddr, task: Omit<Task, "id" | "createdAt">) => void;
  updateTask: (addr: TaskAddr, patch: Partial<Pick<Task, "status" | "priority">>) => void;
  updateTaskDoc: (addr: TaskAddr, code: string, status: DocStatus) => void;
  sendNudge: (nudgeId: string) => void;
  scheduleNudge: (nudgeId: string, when?: string) => void;
  resendNudge: (nudgeId: string) => void;
};

type ContextValue = { state: State; actions: Actions };

const WorkflowContext = createContext<ContextValue | null>(null);

export function WorkflowProvider({ children, now }: { children: ReactNode; now?: string }) {
  const [state, dispatch] = useReducer(reducer, now, init);

  const actions = useMemo<Actions>(
    () => ({
      markDecided: (addr) => dispatch({ type: "markDecided", addr }),
      undoDecide: (addr) => dispatch({ type: "undoDecide", addr }),
      wake: (addr) => dispatch({ type: "wake", addr }),
      snooze: (addr, until) => dispatch({ type: "snooze", addr, until }),
      editDecision: (addr, patch) => dispatch({ type: "editDecision", addr, patch }),
      upsertDecision: (decision) => dispatch({ type: "upsertDecision", decision }),
      generateTask: (addr, task) => dispatch({ type: "generateTask", addr, task }),
      updateTask: (addr, patch) => dispatch({ type: "updateTask", addr, patch }),
      updateTaskDoc: (addr, code, status) => dispatch({ type: "updateTaskDoc", addr, code, status }),
      sendNudge: (nudgeId) => dispatch({ type: "sendNudge", nudgeId }),
      scheduleNudge: (nudgeId, when) => dispatch({ type: "scheduleNudge", nudgeId, when }),
      resendNudge: (nudgeId) => dispatch({ type: "resendNudge", nudgeId }),
    }),
    [],
  );

  const value = useMemo<ContextValue>(() => ({ state, actions }), [state, actions]);
  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>;
}

function useWorkflow(): ContextValue {
  const ctx = useContext(WorkflowContext);
  if (!ctx) throw new Error("useWorkflow* hooks must be used inside <WorkflowProvider> (the (workflow) route-group layout mounts it).");
  return ctx;
}

export function useDecisions(): Decision[] {
  return useWorkflow().state.decisions;
}

// Flattened Tasks projection — each row carries {decisionId,itemId,taskId} so a
// write from the flat Tasks view resolves back to the canonical nested node.
export function useTasks(): TaskRow[] {
  const { decisions } = useWorkflow().state;
  return useMemo(
    () =>
      decisions.flatMap((d) =>
        d.items.flatMap((it) =>
          it.tasks.map<TaskRow>((t) => ({ ...t, decisionId: d.id, itemId: it.id, householdName: d.householdName })),
        ),
      ),
    [decisions],
  );
}

export function useNudges(): Nudge[] {
  return useWorkflow().state.nudges;
}
export function useTemplates(): NudgeTemplate[] {
  return useWorkflow().state.templates;
}
export function usePipelineStats(): PipelineStats {
  return useWorkflow().state.stats;
}
export function useDocs(): DocCatalog {
  return DOC_CATALOG;
}
export function useWorkflowActions(): Actions {
  return useWorkflow().actions;
}
