import { describe, expect, it } from "vitest";
import {
  MACRO_FOLLOW_UP_HOUR,
  assigneeChoiceOf,
  describeMacroActions,
  followUpSentence,
  keyFieldState,
} from "@/components/admin/macros/macro-form-support";

/**
 * The Key field on EDIT. The rule this pins down is not cosmetic: the key is the one value an
 * operator copies out of the macro sheet (it is how the macro is named in the audit log), so it must
 * never be rendered `disabled` — shadcn's Input dims a disabled control to 50% opacity and sets
 * `pointer-events-none`, which puts it under 4.5:1 and makes it impossible to select by long-press
 * on a phone or double-click on a desktop. `readOnly` makes it equally immutable and stays readable.
 */
describe("keyFieldState", () => {
  it("makes the key read-only on edit rather than disabled", () => {
    const state = keyFieldState("edit", false);
    expect(state.readOnly).toBe(true);
    expect(state.disabled).toBe(false);
  });

  it("announces the edit key as read-only to assistive tech", () => {
    expect(keyFieldState("edit", false).ariaReadOnly).toBe(true);
    expect(keyFieldState("create", false).ariaReadOnly).toBeUndefined();
  });

  it("never dims the edit key: no opacity or pointer-events class is applied", () => {
    const className = keyFieldState("edit", false).className ?? "";
    expect(className).not.toMatch(/opacity/);
    expect(className).not.toMatch(/pointer-events-none/);
    // A muted surface is how immutability is signalled instead.
    expect(className).toMatch(/bg-muted/);
  });

  it("leaves the key editable on create", () => {
    const state = keyFieldState("create", false);
    expect(state.readOnly).toBe(false);
    expect(state.disabled).toBe(false);
    expect(state.className).toBeUndefined();
  });

  it("disables the key only while a submit is in flight, in both modes", () => {
    expect(keyFieldState("create", true).disabled).toBe(true);
    expect(keyFieldState("edit", true).disabled).toBe(true);
    // …and the edit key is still marked read-only while pending, so the state is not lost on settle.
    expect(keyFieldState("edit", true).readOnly).toBe(true);
  });
});

/**
 * Wave B. The actions editor's words.
 *
 * An administrator configuring a macro's side effects checks their work by reading these sentences,
 * so "does it say what it will do" is the assertion that matters — the same list is rendered in the
 * editor's preview and on the macro's row in `/admin/macros`, which is why there is one function.
 */
describe("describeMacroActions", () => {
  it("says nothing for a macro that inserts its body and changes no field", () => {
    expect(describeMacroActions(null)).toEqual([]);
    expect(describeMacroActions({})).toEqual([]);
  });

  it("uses the human labels, never the enum values", () => {
    const lines = describeMacroActions({ status: "PENDING_CLIENT", priority: "URGENT", queueKey: "CLIENT_SERVICE" });
    expect(lines.join(" ")).not.toContain("PENDING_CLIENT");
    expect(lines.join(" ")).not.toContain("CLIENT_SERVICE");
    expect(lines[0]).toContain("Pending client");
    expect(lines[1]).toContain("Urgent");
    expect(lines[2]).toContain("Client Service");
  });

  it("warns that the priority change moves the SLA clock, which is the surprising half", () => {
    expect(describeMacroActions({ priority: "LOW" })[0]).toContain("SLA");
  });

  it("says the status is subject to the state machine rather than promising it", () => {
    expect(describeMacroActions({ status: "CLOSED" })[0]).toContain("when the state machine allows it");
  });

  it("distinguishes the three assignee forms", () => {
    expect(describeMacroActions({ assignee: "me" })[0]).toContain("whoever sends the macro");
    expect(describeMacroActions({ assignee: null })[0]).toContain("Clear the assignee");
    expect(describeMacroActions({ assignee: "cm1abc" })[0]).toContain("one named person");
  });

  it("orders the sentences the way the editor's fields are ordered", () => {
    const lines = describeMacroActions({
      escalationTarget: "NONE",
      followUpInDays: 2,
      assignee: "me",
      queueKey: "OPERATIONS",
      priority: "LOW",
      status: "OPEN",
    });
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("status");
    expect(lines[5]).toContain("escalation");
  });
});

describe("followUpSentence", () => {
  it("leaves the follow-up alone when the field is untouched", () => {
    expect(followUpSentence(undefined)).toBeNull();
  });

  it("reads 0 as a clear, not as 'today'", () => {
    expect(followUpSentence(0)).toBe("Clear the follow-up date");
  });

  it("names the firm hour and the zone, because a follow-up date is read by a person in one office", () => {
    expect(followUpSentence(1)).toContain("tomorrow");
    expect(followUpSentence(3)).toContain(`${String(MACRO_FOLLOW_UP_HOUR).padStart(2, "0")}:00 ET`);
  });
});

describe("assigneeChoiceOf", () => {
  it("separates 'not set' from 'set to null'", () => {
    expect(assigneeChoiceOf(undefined)).toBe("unchanged");
    expect(assigneeChoiceOf(null)).toBe("clear");
  });

  it("recognises the submitter and a stored id", () => {
    expect(assigneeChoiceOf("me")).toBe("me");
    expect(assigneeChoiceOf("cm1abc")).toBe("user");
  });
});
