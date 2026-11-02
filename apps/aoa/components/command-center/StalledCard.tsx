"use client";

import { useState } from "react";
import type { StalledItem } from "@/lib/data/types";
import type { ResolvedStalledItem } from "@/lib/mock/command-center";
import { Card, CardHeader, CardBody, Pill, Button, PreviewBadge } from "@/components/ui";
import {
  defaultSnoozeDate,
  fmtSnoozeDate,
  isValidSnoozeDate,
} from "./cc-interactivity";
import { useToast } from "./Toast";
import styles from "./StalledCard.module.css";

// "Stalled & at risk" card with the mockup's B1 interactivity (ticket):
// per-row Snooze (inline date picker → the row leaves the list) and Create task
// (inline form → "Task created" pill), plus the expandable "Resolved · N"
// section with Reopen (mockup index.html:3670–3698, :3713).
//
// Phase C ephemeral posture, deliberately: everything below is plain client
// state that resets on refresh. Nothing is persisted and the workflow store is
// NOT wired — the Command Center lives outside the (workflow) route group,
// exactly like the mockup keeps this state page-local.

// Screen-local assignee/priority picklists (TDD §6 posture: picklists are
// deferred mock). Groups + seed personas; not wired to app.User.
const ASSIGNEES = ["Operations", "Client Service", "Riley Ops", "Avery Stone", "Gwen Kuhlman"];
const PRIORITIES = ["High", "Medium", "Low"];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function SnoozeForm({
  item,
  onSet,
  onCancel,
}: {
  item: StalledItem;
  onSet: (dateIso: string) => void;
  onCancel: () => void;
}) {
  const today = todayIso();
  const [date, setDate] = useState(() => defaultSnoozeDate(new Date()));
  return (
    <div className={styles.inline}>
      <div className={styles.inlineTitle}>Snooze — {item.what}</div>
      <label className={styles.field}>
        <span className={styles.label}>Remind on</span>
        <input
          type="date"
          className={styles.dateInput}
          value={date}
          min={today}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <p className={styles.note}>Sample only — the row returns on refresh.</p>
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!isValidSnoozeDate(date, today)} onClick={() => onSet(date)}>
          Set
        </Button>
      </div>
    </div>
  );
}

function CreateTaskForm({
  item,
  onCreate,
  onCancel,
}: {
  item: StalledItem;
  onCreate: (desc: string, assignee: string, priority: string) => void;
  onCancel: () => void;
}) {
  const [desc, setDesc] = useState(item.what);
  const [assignee, setAssignee] = useState(ASSIGNEES[0]);
  const [priority, setPriority] = useState(PRIORITIES[0]);
  return (
    <div className={styles.inline}>
      <div className={styles.inlineTitle}>Create task — {item.what}</div>
      <label className={styles.field}>
        <span className={styles.label}>Task description · auto-generated, editable</span>
        <textarea
          className={styles.textarea}
          rows={2}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
      </label>
      <div className={styles.grid2}>
        <label className={styles.field}>
          <span className={styles.label}>Assign to</span>
          <select
            className={styles.select}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            {ASSIGNEES.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Priority</span>
          <select
            className={styles.select}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          >
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>
      <p className={styles.note}>Sample only — resets on refresh (not saved to Tasks).</p>
      <div className={styles.actions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!desc.trim()}
          onClick={() => onCreate(desc.trim(), assignee, priority)}
        >
          Create task
        </Button>
      </div>
    </div>
  );
}

export function StalledCard({
  items: initialItems,
  resolved: initialResolved,
}: {
  items: StalledItem[];
  resolved: ResolvedStalledItem[];
}) {
  // Ephemeral P2 state (resets on refresh — Phase C posture, ADR-4).
  const [items, setItems] = useState(initialItems);
  const [resolved, setResolved] = useState(initialResolved);
  const [taskCreated, setTaskCreated] = useState<readonly string[]>([]);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const [taskFor, setTaskFor] = useState<string | null>(null);
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const { show, toast } = useToast();

  const snooze = (item: StalledItem, dateIso: string) => {
    setItems((prev) => prev.filter((i) => i.what !== item.what));
    setSnoozeFor(null);
    show(`Snoozed until ${fmtSnoozeDate(dateIso)} — "${item.what}"`);
  };

  const createTask = (item: StalledItem, assignee: string) => {
    setTaskCreated((prev) => [...prev, item.what]);
    setTaskFor(null);
    show(`Task created → ${assignee}`);
  };

  const reopen = (r: ResolvedStalledItem) => {
    setResolved((prev) => prev.filter((i) => i.what !== r.what));
    setItems((prev) => [...prev, { what: r.what, type: r.type, age: r.age }]);
    show(`Reopened: ${r.what}`);
  };

  return (
    <Card>
      <CardHeader>
        <h2>Stalled &amp; at risk</h2>
        <PreviewBadge />
      </CardHeader>
      <CardBody>
        {items.map((item) => (
          <div key={item.what} className={styles.row} data-testid="stalled-row">
            <div className={styles.rowHead}>
              <div className={styles.rowMain}>
                <div className={styles.what}>{item.what}</div>
                <div className={styles.meta}>
                  <Pill tone="gray">{item.type}</Pill>
                </div>
              </div>
              <span className={styles.age}>{item.age}</span>
            </div>
            <div className={styles.rowActions}>
              {taskCreated.includes(item.what) ? (
                <Pill tone="green" dot>
                  Task created
                </Pill>
              ) : (
                <Button
                  size="sm"
                  onClick={() => {
                    setTaskFor(taskFor === item.what ? null : item.what);
                    setSnoozeFor(null);
                  }}
                >
                  Create task
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSnoozeFor(snoozeFor === item.what ? null : item.what);
                  setTaskFor(null);
                }}
              >
                Snooze
              </Button>
            </div>
            {snoozeFor === item.what && (
              <SnoozeForm
                item={item}
                onSet={(d) => snooze(item, d)}
                onCancel={() => setSnoozeFor(null)}
              />
            )}
            {taskFor === item.what && (
              <CreateTaskForm
                item={item}
                onCreate={(_d, a) => createTask(item, a)}
                onCancel={() => setTaskFor(null)}
              />
            )}
          </div>
        ))}
        {items.length === 0 && (
          <p className={styles.empty}>Nothing stalled — all clear (sample resets on refresh).</p>
        )}

        {resolved.length > 0 && (
          <div className={styles.resolvedSection}>
            <button
              type="button"
              className={styles.resolvedToggle}
              aria-expanded={resolvedOpen}
              onClick={() => setResolvedOpen((o) => !o)}
            >
              <span aria-hidden="true">{resolvedOpen ? "▾" : "▸"}</span>
              Resolved · {resolved.length}
            </button>
            {resolvedOpen && (
              <div className={styles.resolvedList}>
                {resolved.map((r) => (
                  <div key={r.what} className={styles.resolvedRow}>
                    <div className={styles.rowMain}>
                      <div className={styles.resolvedWhat}>{r.what}</div>
                      <div className={styles.resolvedMeta}>
                        {r.resolvedBy} · {r.resolvedWhen}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => reopen(r)}>
                      Reopen
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardBody>
      {toast}
    </Card>
  );
}
