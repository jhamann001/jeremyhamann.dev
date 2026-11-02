"use client";

import { useState } from "react";
import { Button, Pill } from "@/components/ui";
import {
  DocCard,
  ListRow,
  PreviewPanel,
  PrioritySelect,
  StatusSelect,
  WorkflowProvider,
  useDecisions,
  useDocs,
  useTasks,
  useWorkflowActions,
} from "@/components/workflow";
import { TASK_STATUS_LABEL, taskTone } from "@/components/workflow/status-tone";
import type { DocStatus, TaskPriority, TaskStatus } from "@/lib/data/workflow-types";

// Dev-gallery demo for the Phase C workflow primitives. This is the client
// boundary: the (server) gallery page renders <WorkflowPrimitivesDemo/>, which
// mounts its own WorkflowProvider so the store hooks work and the
// generateTask → useTasks() round-trip is observable.
export function WorkflowPrimitivesDemo() {
  return (
    <WorkflowProvider>
      <Inner />
    </WorkflowProvider>
  );
}

function Inner() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<TaskStatus>("todo");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [docStatus, setDocStatus] = useState<DocStatus>("needed");

  const decisions = useDecisions();
  const tasks = useTasks();
  const { docs } = useDocs();
  const { generateTask } = useWorkflowActions();

  const first = decisions[0]?.items[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <ListRow
        tone={taskTone(status)}
        icon={<span>◍</span>}
        actions={<Button variant="ghost" size="sm">Action</Button>}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>ListRow sample</div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          icon + main + actions — the shared row grammar
        </div>
      </ListRow>

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <StatusSelect value={status} onChange={setStatus} />
        <PrioritySelect value={priority} onChange={setPriority} />
        <Pill tone={taskTone(status)} dot>
          {TASK_STATUS_LABEL[status]}
        </Pill>
      </div>

      <DocCard doc={docs.ach} status={docStatus} onStatus={setDocStatus} />

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Button
          size="sm"
          onClick={() =>
            first &&
            generateTask(
              { decisionId: decisions[0].id, itemId: first.id },
              {
                desc: "Demo task from the dev gallery",
                assignee: { kind: "group", label: "Operations" },
                status: "todo",
                priority: "normal",
                createdBy: "Dev gallery",
              },
            )
          }
        >
          + Generate task
        </Button>
        <span style={{ fontSize: 12, color: "var(--muted)" }}>
          Tasks in store (useTasks): <b>{tasks.length}</b>
        </span>
      </div>

      <div>
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          Open PreviewPanel
        </Button>
        <PreviewPanel
          open={open}
          onClose={() => setOpen(false)}
          title="Preview panel"
          footer={
            <Button size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          }
        >
          <p style={{ fontSize: 13, color: "var(--ink-2)" }}>
            Slide-in overlay chrome — Smart Nudges reuses this for the nudge preview.
          </p>
        </PreviewPanel>
      </div>
    </div>
  );
}
