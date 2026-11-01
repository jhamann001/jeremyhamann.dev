/**
 * The macro-actions schema and its pure helpers.
 *
 * `applyMacroActions` itself needs a real ticket, a real transaction and the real policy modules, so
 * it is covered by `macros-apply.integration.test.ts`. What is asserted here is everything that
 * decides what a macro is ALLOWED to be before it ever meets a ticket.
 */
import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { firmWallClock } from "@/lib/firm-time";
import {
  MACRO_ACTION_KEYS,
  MACRO_FOLLOW_UP_HOUR,
  canonicalMacroActions,
  followUpInstant,
  isEmptyMacroActions,
  macroActionsAuditValue,
  macroActionsSchema,
  parseMacroActions,
  setMacroActionsSchema,
} from "@/server/macros-apply";

describe("macroActionsSchema", () => {
  it("accepts every field the domain type declares", () => {
    const parsed = macroActionsSchema.parse({
      // RESOLVED rather than PENDING_CLIENT because `resolution` is only coherent beside an ending
      // status, and this case exists to prove every key survives a parse together.
      status: "RESOLVED",
      resolution: "ANSWERED",
      priority: "HIGH",
      queueKey: "OPERATIONS",
      assignee: "me",
      followUpInDays: 3,
      escalationTarget: "NONE",
    });
    expect(Object.keys(parsed).sort()).toEqual([...MACRO_ACTION_KEYS].sort());
  });

  /**
   * Fix round 2. An outcome without an ending status is statically dead — it would save and then do
   * nothing for every ticket forever — so the schema refuses it on the save path AND on the parse of
   * the stored column, which is what keeps those two from disagreeing about the same row.
   */
  it("refuses an outcome that no status could ever apply", () => {
    expect(macroActionsSchema.safeParse({ resolution: "ANSWERED" }).success).toBe(false);
    expect(macroActionsSchema.safeParse({ status: "PENDING_CLIENT", resolution: "ANSWERED" }).success).toBe(false);
    for (const status of ["RESOLVED", "CLOSED"]) {
      expect(macroActionsSchema.safeParse({ status, resolution: "COMPLETED" }).success, status).toBe(true);
    }
  });

  it("accepts only the four operator outcomes — a merge and a void write their own", () => {
    for (const good of ["ANSWERED", "COMPLETED", "WITHDRAWN", "NO_RESPONSE"]) {
      expect(macroActionsSchema.safeParse({ status: "RESOLVED", resolution: good }).success, good).toBe(true);
    }
    for (const bad of ["DUPLICATE", "ENTERED_IN_ERROR", "NONE"]) {
      expect(macroActionsSchema.safeParse({ status: "RESOLVED", resolution: bad }).success, bad).toBe(false);
    }
  });

  it("REFUSES VOIDED — Decision #96 keeps voiding off the state machine entirely", () => {
    expect(macroActionsSchema.safeParse({ status: "VOIDED" }).success).toBe(false);
    // Every other status is fine.
    expect(macroActionsSchema.safeParse({ status: "CLOSED" }).success).toBe(true);
  });

  it("refuses an unknown key rather than silently dropping it", () => {
    expect(macroActionsSchema.safeParse({ status: "OPEN", tags: ["urgent"] }).success).toBe(false);
  });

  it("bounds followUpInDays to whole days within a year", () => {
    for (const bad of [-1, 366, 1.5, Number.NaN]) {
      expect(macroActionsSchema.safeParse({ followUpInDays: bad }).success, String(bad)).toBe(false);
    }
    for (const good of [0, 1, 365]) {
      expect(macroActionsSchema.safeParse({ followUpInDays: good }).success, String(good)).toBe(true);
    }
  });

  it("accepts the three assignee forms and refuses a malformed id", () => {
    for (const good of ["me", null, "cm1abc-XYZ_0"]) {
      expect(macroActionsSchema.safeParse({ assignee: good }).success, String(good)).toBe(true);
    }
    expect(macroActionsSchema.safeParse({ assignee: "not an id!" }).success).toBe(false);
  });

  it("accepts the empty object — a macro that inserts its body and nothing else", () => {
    expect(macroActionsSchema.parse({})).toEqual({});
  });
});

describe("parseMacroActions", () => {
  it("reads null and the empty object as 'no actions'", () => {
    expect(parseMacroActions(null, "k")).toBeNull();
    expect(parseMacroActions(undefined, "k")).toBeNull();
    expect(parseMacroActions({}, "k")).toBeNull();
  });

  it("THROWS on a blob it cannot understand rather than degrading to a plain body insert", () => {
    // The operator picked the macro for what it does; half of it going missing silently is the one
    // outcome this must not have.
    expect(() => parseMacroActions({ status: "NOT_A_STATUS" }, "wire-notice")).toThrow(ValidationError);
    expect(() => parseMacroActions({ status: "VOIDED" }, "wire-notice")).toThrow(/wire-notice/);
  });

  it("returns the parsed object when it is valid", () => {
    expect(parseMacroActions({ status: "PENDING_CLIENT" }, "k")).toEqual({ status: "PENDING_CLIENT" });
  });
});

describe("canonicalMacroActions / macroActionsAuditValue", () => {
  it("normalises an empty request to null so there is one representation of 'nothing'", () => {
    expect(canonicalMacroActions({})).toBeNull();
    expect(canonicalMacroActions(null)).toBeNull();
    expect(isEmptyMacroActions({})).toBe(true);
  });

  it("orders keys deterministically, so a change is a string comparison", () => {
    const a = canonicalMacroActions({ escalationTarget: "NONE", status: "OPEN", priority: "LOW" });
    const b = canonicalMacroActions({ priority: "LOW", status: "OPEN", escalationTarget: "NONE" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a ?? {})).toEqual(["status", "priority", "escalationTarget"]);
  });

  it("keeps an explicit null assignee — 'clear the assignee' is not 'leave it alone'", () => {
    expect(canonicalMacroActions({ assignee: null })).toEqual({ assignee: null });
    expect(macroActionsAuditValue({ assignee: null })).toBe('{"assignee":null}');
  });

  it("writes 'none' for no actions, so the audit row's value columns are readable", () => {
    expect(macroActionsAuditValue(null)).toBe("none");
    expect(macroActionsAuditValue({})).toBe("none");
  });
});

describe("followUpInstant", () => {
  const now = new Date("2026-09-20T18:30:00.000Z"); // a Sunday afternoon, 14:30 ET

  it("clears the follow-up on 0", () => {
    expect(followUpInstant(0, now)).toBeNull();
  });

  it("lands N FIRM days out at the firm follow-up hour, not now + N×24h", () => {
    const three = followUpInstant(3, now);
    expect(three).not.toBeNull();
    const wc = firmWallClock(three!);
    expect(wc?.day).toBe(23);
    expect(wc?.month).toBe(9);
    expect(wc?.hour).toBe(MACRO_FOLLOW_UP_HOUR);
    expect(wc?.minute).toBe(0);
  });

  it("rolls over a month end", () => {
    const wc = firmWallClock(followUpInstant(15, new Date("2026-09-20T18:30:00.000Z"))!);
    expect([wc?.month, wc?.day]).toEqual([10, 5]);
  });

  it("stays at the firm hour across the autumn DST change", () => {
    // 2026-10-30 ET + 5 days crosses the first Sunday in November (DST ends 2026-11-01).
    const wc = firmWallClock(followUpInstant(5, new Date("2026-10-30T16:00:00.000Z"))!);
    expect(wc?.hour).toBe(MACRO_FOLLOW_UP_HOUR);
    expect([wc?.month, wc?.day]).toEqual([11, 4]);
  });
});

describe("setMacroActionsSchema", () => {
  it("accepts an explicit null — the admin clearing a macro's actions", () => {
    expect(setMacroActionsSchema.parse({ macroId: "m1", actions: null })).toEqual({ macroId: "m1", actions: null });
  });

  it("refuses a macro id that is not an id", () => {
    expect(setMacroActionsSchema.safeParse({ macroId: "../../etc", actions: null }).success).toBe(false);
  });

  it("refuses an actions blob the applier could not apply", () => {
    expect(setMacroActionsSchema.safeParse({ macroId: "m1", actions: { status: "VOIDED" } }).success).toBe(false);
  });
});
