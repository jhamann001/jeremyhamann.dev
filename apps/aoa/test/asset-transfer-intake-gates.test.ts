import { describe, expect, it } from "vitest";
import { markCase } from "./acat-book-flywheel";
import {
  accountMatchBlocks,
  accountMatchGate,
  receivingStillOpening,
  statementBlocks,
  useReceivingAccountAsDestination,
} from "@/lib/transfers/intake-gates";

const SUITE = "asset-transfer-intake-gates";
const HARD_ROUTES = [
  "Full ACAT · app authorization · Apex API",
  "Full ACAT · signed paperwork · Apex API",
  "Partial ACAT · signed paperwork · Ascend entry",
];
const MANUAL = "Manual · custodian-library process";
const OTHER_ROUTES = [
  "DRS · Apex service request",
  "Rollover · physical check",
  "ACH · client self-service",
  "Wire · client instructions",
];

describe("asset transfer intake gates", () => {
  it("missing-statement-blocks", () => {
    expect(statementBlocks(true, null)).toBe(true);
    expect(statementBlocks(true, { accepted: false })).toBe(true);
    markCase(SUITE, "missing-statement-blocks");
  });

  it("accepted-does-not-block", () => {
    expect(statementBlocks(true, { accepted: true })).toBe(false);
    markCase(SUITE, "accepted-does-not-block");
  });

  it("acat-routes-hard-block", () => {
    for (const route of HARD_ROUTES) {
      expect(accountMatchBlocks(true, route, "Individual", "Joint", false)).toBe(true);
      expect(accountMatchBlocks(true, route, "Individual", "Joint", true)).toBe(true);
      expect(accountMatchGate(true, route, "Individual", "Joint", true)).toBe("hard_block");
      expect(accountMatchBlocks(true, route, "Roth IRA", "Roth IRA", false)).toBe(false);
    }
    markCase(SUITE, "acat-routes-hard-block");
  });

  it("manual-requires-titles", () => {
    expect(accountMatchGate(true, MANUAL, "Individual", "Trust", false)).toBe("titles_required");
    expect(accountMatchBlocks(true, MANUAL, "Individual", "Trust", false)).toBe(true);
    expect(accountMatchGate(true, MANUAL, "Individual", "Trust", true)).toBe("clear");
    expect(accountMatchBlocks(true, MANUAL, "Individual", "Trust", true)).toBe(false);
    markCase(SUITE, "manual-requires-titles");
  });

  it("other-routes-do-not-block", () => {
    for (const route of OTHER_ROUTES) {
      expect(accountMatchBlocks(true, route, "Individual", "Joint", false)).toBe(false);
      expect(accountMatchGate(true, route, "Individual", "Joint", false)).toBe("clear");
    }
    expect(accountMatchBlocks(true, "", "Individual", "Joint", false)).toBe(false);
    markCase(SUITE, "other-routes-do-not-block");
  });

  it("to-open", () => {
    expect(receivingStillOpening([{ status: "OPEN" }, { status: "TO_OPEN" }])).toBe(true);
    expect(receivingStillOpening([{ status: "OPEN" }])).toBe(false);
    expect(useReceivingAccountAsDestination("acct-1", "TO_OPEN")).toEqual({
      ok: false,
      accountId: "acct-1",
      message: "Choose this client’s opened receiving account in the selected household.",
    });
    expect(useReceivingAccountAsDestination("acct-2", "OPEN")).toEqual({ ok: true, accountId: "acct-2" });
    markCase(SUITE, "to-open");
  });

  it("flag-off", () => {
    expect(statementBlocks(false, null)).toBe(false);
    expect(accountMatchBlocks(false, HARD_ROUTES[0], "Individual", "Joint", false)).toBe(false);
    expect(accountMatchBlocks(false, MANUAL, "Individual", "Joint", false)).toBe(false);
    markCase(SUITE, "flag-off");
  });
});
