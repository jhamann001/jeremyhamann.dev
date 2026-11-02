import { describe, expect, it } from "vitest";
import {
  acatLinkedFromIds,
  hardGateBlock,
  checklistGateBlock,
} from "@/lib/data/transfer-gate";
import type { FundingType, TransferStage } from "@/lib/data/transfer-types";

// Legacy readiness applies to both forward exits from Decision. The ACAT
// leg keys on the caller-supplied `acat_linked` boolean (a REAL linked tracker
// record — the #151 reconciliation), NEVER a raw acat_transfer_id string: no
// test here passes an id string, only the derived boolean.

// A transfer whose every hard-gate condition is satisfied (cash-in-flight path).
const ALL_MET = {
  accounts_opened_at_apex: true,
  funding_plan_complete: true,
  funding_initiated: true,
  cash_in_flight: true,
  funding_type: null as FundingType | null,
  acat_linked: false,
};

const ACAT_LEG_MESSAGE =
  "A real ACAT is linked (Funding Type = ACAT-Full/Partial + a linked tracker record) OR cash is in flight";

describe("hardGateBlock — DECISION→IN_TRANSFER", () => {
  it("accepts a confirmed manual securities transfer without claiming cash is in flight", () => {
    const manual = { ...ALL_MET, funding_type: "MANUAL" as const, acat_linked: false, cash_in_flight: false };
    expect(hardGateBlock(manual, "DECISION", "IN_TRANSFER")).toEqual({ blocked: false, unmet: [] });
    expect(hardGateBlock({ ...manual, funding_initiated: false }, "DECISION", "IN_TRANSFER"))
      .toEqual({ blocked: true, unmet: ["Funding Initiated", "Manual transfer initiation confirmed"] });
  });

  it("passes when every condition is met (cash-in-flight leg)", () => {
    expect(hardGateBlock(ALL_MET, "DECISION", "IN_TRANSFER")).toEqual({
      blocked: false,
      unmet: [],
    });
  });

  it("passes when the ACAT leg is satisfied (funding_type ACAT + acat_linked), no cash", () => {
    const t = {
      ...ALL_MET,
      cash_in_flight: false,
      funding_type: "ACAT_FULL" as FundingType,
      acat_linked: true,
    };
    expect(hardGateBlock(t, "DECISION", "IN_TRANSFER")).toEqual({
      blocked: false,
      unmet: [],
    });
  });

  it("blocks with 'Accounts opened at Apex' when that flag is false", () => {
    const r = hardGateBlock(
      { ...ALL_MET, accounts_opened_at_apex: false },
      "DECISION",
      "IN_TRANSFER",
    );
    expect(r.blocked).toBe(true);
    expect(r.unmet).toEqual(["Accounts opened at Apex"]);
  });

  it("blocks with 'Funding Plan Complete' when that flag is false", () => {
    const r = hardGateBlock(
      { ...ALL_MET, funding_plan_complete: false },
      "DECISION",
      "IN_TRANSFER",
    );
    expect(r.blocked).toBe(true);
    expect(r.unmet).toEqual(["Funding Plan Complete"]);
  });

  it("blocks with 'Funding Initiated' when that flag is false", () => {
    const r = hardGateBlock(
      { ...ALL_MET, funding_initiated: false },
      "DECISION",
      "IN_TRANSFER",
    );
    expect(r.blocked).toBe(true);
    expect(r.unmet).toEqual(["Funding Initiated"]);
  });

  it("blocks on the ACAT/cash leg when neither ACAT nor cash is satisfied", () => {
    const r = hardGateBlock(
      { ...ALL_MET, cash_in_flight: false, funding_type: null, acat_linked: false },
      "DECISION",
      "IN_TRANSFER",
    );
    expect(r.blocked).toBe(true);
    expect(r.unmet).toEqual([ACAT_LEG_MESSAGE]);
  });

  it("blocks on the ACAT leg when funding_type=ACAT but acat_linked=false (a placeholder id must NOT satisfy it)", () => {
    const r = hardGateBlock(
      {
        ...ALL_MET,
        cash_in_flight: false,
        funding_type: "ACAT_FULL",
        acat_linked: false,
      },
      "DECISION",
      "IN_TRANSFER",
    );
    expect(r.blocked).toBe(true);
    expect(r.unmet).toEqual([ACAT_LEG_MESSAGE]);
  });

  it("blocks on the ACAT leg when acat_linked=true but funding_type is not ACAT and no cash", () => {
    const r = hardGateBlock(
      {
        ...ALL_MET,
        cash_in_flight: false,
        funding_type: "CHECK",
        acat_linked: true,
      },
      "DECISION",
      "IN_TRANSFER",
    );
    expect(r.blocked).toBe(true);
    expect(r.unmet).toEqual([ACAT_LEG_MESSAGE]);
  });

  it("cash_in_flight satisfies the OR even without any Transfer linkage", () => {
    const r = hardGateBlock(
      {
        ...ALL_MET,
        cash_in_flight: true,
        funding_type: null,
        acat_linked: false,
      },
      "DECISION",
      "IN_TRANSFER",
    );
    expect(r.blocked).toBe(false);
    expect(r.unmet).toEqual([]);
  });

  it("accumulates EVERY unmet condition in order when nothing is met", () => {
    const r = hardGateBlock(
      {
        accounts_opened_at_apex: false,
        funding_plan_complete: false,
        funding_initiated: false,
        cash_in_flight: false,
        funding_type: null,
        acat_linked: false,
      },
      "DECISION",
      "IN_TRANSFER",
    );
    expect(r.blocked).toBe(true);
    expect(r.unmet).toEqual([
      "Accounts opened at Apex",
      "Funding Plan Complete",
      "Funding Initiated",
      ACAT_LEG_MESSAGE,
    ]);
  });
});

describe("acatLinkedFromIds — the gate's acat_linked derivation (record id primary, legacy UUID fallback)", () => {
  it("record id alone (uuid null) → linked — the ticket flag-flip caveat fix", () => {
    expect(acatLinkedFromIds(null, "rec-1")).toBe(true);
  });

  it("uuid alone (record id null) → linked — legacy rows unchanged", () => {
    expect(acatLinkedFromIds("ACT-abc123", null)).toBe(true);
  });

  it("both ids → linked", () => {
    expect(acatLinkedFromIds("ACT-abc123", "rec-1")).toBe(true);
  });

  it("both null → not linked", () => {
    expect(acatLinkedFromIds(null, null)).toBe(false);
  });

  it("composed: a record-id-only link + an ACAT rail satisfies the hard gate's ACAT leg", () => {
    const t = {
      ...ALL_MET,
      cash_in_flight: false,
      funding_type: "ACAT_FULL" as FundingType,
      acat_linked: acatLinkedFromIds(null, "rec-1"),
    };
    expect(hardGateBlock(t, "DECISION", "IN_TRANSFER")).toEqual({
      blocked: false,
      unmet: [],
    });
  });
});

describe("hardGateBlock — never blocks any other transition", () => {
  // Backward, no-op and later-stage moves do not use Decision readiness, even
  // when the transfer is completely unfunded.
  const UNFUNDED = {
    accounts_opened_at_apex: false,
    funding_plan_complete: false,
    funding_initiated: false,
    cash_in_flight: false,
    funding_type: null as FundingType | null,
    acat_linked: false,
  };

  const pairs: [TransferStage, TransferStage][] = [
    ["IN_TRANSFER", "FUNDED"], // forward, later stage — stays soft
    ["IN_TRANSFER", "DECISION"], // backward
    ["FUNDED", "IN_TRANSFER"], // backward
    ["FUNDED", "DECISION"], // backward
    ["IN_TRANSFER", "IN_TRANSFER"], // no-move
    ["DECISION", "DECISION"], // no-move
  ];

  for (const [from, to] of pairs) {
    it(`${from}→${to} never blocks`, () => {
      expect(hardGateBlock(UNFUNDED, from, to)).toEqual({
        blocked: false,
        unmet: [],
      });
    });
  }
});

describe("hardGateBlock — skipped Decision exit", () => {
  it("requires the same readiness for Decision → Funded as Decision → In transfer", () => {
    const incomplete = { ...ALL_MET, accounts_opened_at_apex: false, funding_initiated: false, cash_in_flight: false };
    expect(hardGateBlock(incomplete, "DECISION", "FUNDED")).toEqual({
      blocked: true,
      unmet: ["Accounts opened at Apex", "Funding Initiated", ACAT_LEG_MESSAGE],
    });
    expect(hardGateBlock(ALL_MET, "DECISION", "FUNDED")).toEqual({ blocked: false, unmet: [] });
  });
});

describe("checklistGateBlock — the CHECKLIST_STAGE_GATE predicate (all forward moves)", () => {
  const open = (title: string) => ({ title, done: false });
  const done = (title: string) => ({ title, done: true });

  it("blocks a forward move when any visible task is open — unmet = the open titles, in order", () => {
    const r = checklistGateBlock("DECISION", "IN_TRANSFER", [
      done("Collect statements"),
      open("Run asset mapper"),
      open("Open receiving accounts"),
    ]);
    expect(r.blocked).toBe(true);
    expect(r.unmet).toEqual(["Run asset mapper", "Open receiving accounts"]);
  });

  it("allows a forward move when every visible task is done", () => {
    const r = checklistGateBlock("DECISION", "IN_TRANSFER", [
      done("Collect statements"),
      done("Run asset mapper"),
    ]);
    expect(r).toEqual({ blocked: false, unmet: [] });
  });

  it("is vacuously satisfied when the stage has no visible tasks (never hard-block a checklist-less transfer)", () => {
    expect(checklistGateBlock("DECISION", "IN_TRANSFER", [])).toEqual({
      blocked: false,
      unmet: [],
    });
  });

  it("gates the SECOND forward hop too (IN_TRANSFER→FUNDED) — proves all-forward-moves", () => {
    const r = checklistGateBlock("IN_TRANSFER", "FUNDED", [
      open("ACAT submitted to Apex"),
    ]);
    expect(r.blocked).toBe(true);
    expect(r.unmet).toEqual(["ACAT submitted to Apex"]);
  });

  it("never blocks a backward or same-stage move, regardless of open tasks", () => {
    const openTasks = [open("x"), open("y")];
    expect(checklistGateBlock("IN_TRANSFER", "DECISION", openTasks)).toEqual({
      blocked: false,
      unmet: [],
    });
    expect(checklistGateBlock("FUNDED", "IN_TRANSFER", openTasks)).toEqual({
      blocked: false,
      unmet: [],
    });
    expect(checklistGateBlock("DECISION", "DECISION", openTasks)).toEqual({
      blocked: false,
      unmet: [],
    });
  });

  it("blocks a non-adjacent forward skip (DECISION→FUNDED) on open tasks", () => {
    const r = checklistGateBlock("DECISION", "FUNDED", [open("Collect statements")]);
    expect(r.blocked).toBe(true);
    expect(r.unmet).toEqual(["Collect statements"]);
  });
});
