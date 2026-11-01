/**
 * The audit badge's colour contract: **only a refusal or an undelivered client reply is alarming.**
 *
 * The badge component is JSX and is NOT imported here (same reason as `delivery-chip-label.test.ts`);
 * everything it renders — variant and extra classes — comes from the pure helpers pinned below.
 *
 * The rule these tests exist to protect: a compliance reviewer scanning a filtered ledger page reads
 * "red / bold" as "something was refused or never reached a client". Routine administration —
 * offboarding a leaver, turning a macro off — must not compete with that.
 */
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, type AuditAction } from "@/types/domain";
import { ACTION_LABELS } from "@/lib/format";
import {
  ALARM_ACTIONS,
  AUDIT_ACTION_CLASSES,
  auditActionVariant,
} from "@/components/audit/audit-action-style";

/** The badge composes `cn("font-normal", classes)`, so a bold action is one that says so here. */
function isBold(action: AuditAction): boolean {
  return /\bfont-semibold\b/.test(AUDIT_ACTION_CLASSES[action]);
}

describe("auditActionVariant", () => {
  it("covers every action in the catalog with a known variant", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(["destructive", "outline", "secondary"]).toContain(auditActionVariant(action));
    }
  });

  it("reserves the destructive variant for denials and delivery failures", () => {
    const destructive = AUDIT_ACTIONS.filter((a) => auditActionVariant(a) === "destructive");
    expect([...destructive].sort()).toEqual([...ALARM_ACTIONS].sort());
  });

  it("does not treat deactivating a user as an alarm", () => {
    expect(auditActionVariant("USER_DEACTIVATED")).toBe("secondary");
    expect(isBold("USER_DEACTIVATED")).toBe(false);
  });

  it("styles USER_DEACTIVATED exactly like the structurally identical MACRO_DEACTIVATED", () => {
    expect(auditActionVariant("USER_DEACTIVATED")).toBe(auditActionVariant("MACRO_DEACTIVATED"));
    expect(AUDIT_ACTION_CLASSES.USER_DEACTIVATED).toBe(AUDIT_ACTION_CLASSES.MACRO_DEACTIVATED);
  });

  it("keeps each on/off pair visually symmetric, so a reversal never looks calmer than the act", () => {
    const pairs: ReadonlyArray<readonly [AuditAction, AuditAction]> = [
      ["USER_DEACTIVATED", "USER_REACTIVATED"],
      ["MACRO_DEACTIVATED", "MACRO_REACTIVATED"],
    ];
    for (const [off, on] of pairs) {
      expect(auditActionVariant(off)).toBe(auditActionVariant(on));
      expect(AUDIT_ACTION_CLASSES[off]).toBe(AUDIT_ACTION_CLASSES[on]);
    }
  });
});

describe("AUDIT_ACTION_CLASSES", () => {
  it("has an entry for every action in the catalog", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(AUDIT_ACTION_CLASSES[action]).toBeTypeOf("string");
    }
    expect(Object.keys(AUDIT_ACTION_CLASSES).sort()).toEqual([...AUDIT_ACTIONS].sort());
  });

  it("bolds exactly the three alarm actions and nothing else", () => {
    expect(AUDIT_ACTIONS.filter(isBold).sort()).toEqual([...ALARM_ACTIONS].sort());
  });

  it("gives every action a human label, never a raw enum", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(ACTION_LABELS[action]).toBeTruthy();
      expect(ACTION_LABELS[action]).not.toBe(action);
    }
  });
});
