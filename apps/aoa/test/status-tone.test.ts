import { describe, it, expect } from "vitest";
import {
  decisionTone,
  taskTone,
  nudgeTone,
  docTone,
  channelTone,
  DECISION_STATUS_LABEL,
  TASK_STATUS_LABEL,
  TASK_PRIORITY_LABEL,
  NUDGE_STATUS_LABEL,
  DOC_STATUS_LABEL,
  CHANNEL_LABEL,
} from "@/components/workflow/status-tone";
import type {
  Channel,
  DecisionStatus,
  DocStatus,
  NudgeStatus,
  TaskPriority,
  TaskStatus,
} from "@/lib/data/workflow-types";

// The workflow tone/label maps are the single source of truth for pill colors
// and human labels across the Decision Center / Tasks / Nudges screens. These
// tests lock the intended mappings and guarantee total coverage of every enum
// member (a missing key would render an undefined tone/label at runtime).

describe("workflow tone maps", () => {
  it("maps decision statuses to tones", () => {
    expect(decisionTone("open")).toBe("amber");
    expect(decisionTone("snoozed")).toBe("gold");
    expect(decisionTone("decided")).toBe("green");
  });

  it("maps task statuses to tones", () => {
    expect(taskTone("todo")).toBe("amber");
    expect(taskTone("in_progress")).toBe("blue");
    expect(taskTone("blocked")).toBe("red");
    expect(taskTone("done")).toBe("green");
  });

  it("maps nudge statuses to tones", () => {
    expect(nudgeTone("ready")).toBe("amber");
    expect(nudgeTone("scheduled")).toBe("blue");
    expect(nudgeTone("sent")).toBe("green");
  });

  it("maps doc statuses to tones", () => {
    expect(docTone("needed")).toBe("amber");
    expect(docTone("prepared")).toBe("blue");
    expect(docTone("sent")).toBe("gold");
    expect(docTone("signed")).toBe("green");
  });

  it("maps channels to tones", () => {
    expect(channelTone("email")).toBe("blue");
    expect(channelTone("text")).toBe("green");
    expect(channelTone("portal")).toBe("gold");
    expect(channelTone("phone_prep")).toBe("amber");
  });
});

describe("workflow label maps are total (every enum member has a label)", () => {
  const cases: Array<[string, Record<string, string>, readonly string[]]> = [
    [
      "DecisionStatus",
      DECISION_STATUS_LABEL,
      ["open", "snoozed", "decided"] satisfies DecisionStatus[],
    ],
    [
      "TaskStatus",
      TASK_STATUS_LABEL,
      ["todo", "in_progress", "blocked", "done"] satisfies TaskStatus[],
    ],
    [
      "TaskPriority",
      TASK_PRIORITY_LABEL,
      ["low", "normal", "high"] satisfies TaskPriority[],
    ],
    [
      "NudgeStatus",
      NUDGE_STATUS_LABEL,
      ["ready", "scheduled", "sent"] satisfies NudgeStatus[],
    ],
    [
      "DocStatus",
      DOC_STATUS_LABEL,
      ["needed", "prepared", "sent", "signed"] satisfies DocStatus[],
    ],
    [
      "Channel",
      CHANNEL_LABEL,
      ["email", "text", "portal", "phone_prep"] satisfies Channel[],
    ],
  ];

  it.each(cases)("%s: non-empty label for each member", (_name, map, members) => {
    for (const member of members) {
      expect(map[member]).toBeTruthy();
    }
    // No stray keys beyond the enum members.
    expect(Object.keys(map).sort()).toEqual([...members].sort());
  });
});
