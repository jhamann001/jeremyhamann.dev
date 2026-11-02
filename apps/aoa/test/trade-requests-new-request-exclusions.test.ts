import { describe, expect, it } from "vitest";
import { clientsById, initialNewRequestDraft, type NewRequestClient, type NewRequestDraft } from "@/lib/trade-requests/new-request";
import {
  NO_PENDING,
  accountExclusionGroups,
  addedByText,
  applyEnabled,
  applyLabel,
  batchFromPending,
  discardMessage,
  effectiveSides,
  formatExclusionSide,
  formatRestrictionReason,
  formatStandingExclusions,
  manageAccountRestrictionsShown,
  manageExclusionsEnabled,
  manageExclusionsTitle,
  pendingCount,
  savedSummary,
  sideChangeText,
  sideLocked,
  stagedAdd,
  standingExclusionsFillKey,
  standingExclusionsText,
  withRemovalToggled,
  withSavedSideToggled,
  withStagedField,
  withStagedSide,
  withStandingExclusions,
  type PendingChanges,
  type StandingExclusion,
} from "@/lib/trade-requests/new-request-exclusions";

const row = (over: Partial<StandingExclusion>): StandingExclusion => ({
  id: "x", ticker: "TSLA", kind: "advisor", reason: "", noBuy: true, noSell: true, createdByName: "Avery Stone", createdAt: "2026-10-01T12:00:00Z", ...over,
});
const CLIENTS: NewRequestClient[] = [
  { id: "c-alex", name: "Maeve Brennan", accounts: [
    { id: "a1", accountNumber: "SYN00001", accountType: "Taxable", balance: 1 }, { id: "a2", accountNumber: "SYN00002", accountType: "Roth IRA", balance: 2 }] },
  { id: "c-blair", name: "Lucille Howell", accounts: [{ id: "a3", accountNumber: "SYN00003", accountType: "Joint", balance: 3 }] },
];
const context = (over: Partial<NewRequestDraft>) => ({ draft: { ...initialNewRequestDraft(), ...over }, clientsById: clientsById(CLIENTS) });
const BY_CLIENT = {
  "c-alex": [row({ id: "1", ticker: "TSLA", reason: "Concentration risk", noSell: false }), row({ id: "2", ticker: "AAPL", kind: "client", reason: "Employer stock" })],
  "c-blair": [row({ id: "3", ticker: "XOM", noBuy: false }), row({ id: "4", ticker: "META", kind: "client", reason: "", noSell: false })],
};

describe("standing-list text (AC-90)", () => {
  it("formats sides and one client's entries without attribution", () => {
    expect([formatExclusionSide(row({})), formatExclusionSide(row({ noSell: false })), formatExclusionSide(row({ noBuy: false }))]).toEqual(["DNB+DNS", "DNB", "DNS"]);
    const one = [{ id: "c-alex", name: "Maeve Brennan" }];
    expect(formatStandingExclusions(BY_CLIENT, one, "advisor")).toBe("TSLA (DNB - Concentration risk)");
    expect(formatStandingExclusions(BY_CLIENT, one, "client")).toBe("AAPL (DNB+DNS - Employer stock)");
  });

  it("attributes each entry to its client, in selection order, when several clients are selected", () => {
    const both = [{ id: "c-blair", name: "Lucille Howell" }, { id: "c-alex", name: "Maeve Brennan" }];
    expect(standingExclusionsText(BY_CLIENT, both)).toEqual({
      advisor: "XOM (DNS – Lucille Howell); TSLA (DNB - Concentration risk – Maeve Brennan)",
      client: "META (DNB – Lucille Howell); AAPL (DNB+DNS - Employer stock – Maeve Brennan)",
    });
    expect(formatStandingExclusions({}, both, "advisor")).toBe("");
  });

  it("shows one source tag for imported reasons", () => {
    expect(formatRestrictionReason("  Imported from /tmp/a.csv ")).toBe("Imported from Meridian restrictions file");
    expect(formatRestrictionReason("see restrictions.csv")).toBe("Imported from Meridian restrictions file");
    expect(formatRestrictionReason("Meridian sync")).toBe("Imported from Meridian restrictions file");
    expect(formatRestrictionReason(" Employer stock ")).toBe("Employer stock");
    expect(formatRestrictionReason("  ")).toBe("");
  });
});

describe("filling and replacing the fields (AC-90, AC-119)", () => {
  const first = { advisor: "TSLA (DNB)", client: "AAPL (DNS)" };
  const second = { advisor: "XOM (DNS)", client: "" };

  it("fills empty fields and refills fields still holding the last-written text", () => {
    const filled = withStandingExclusions(initialNewRequestDraft(), first, "fill");
    expect([filled.advisorExclusions, filled.clientExclusions]).toEqual(["TSLA (DNB)", "AAPL (DNS)"]);
    const refilled = withStandingExclusions(filled, second, "fill");
    expect([refilled.advisorExclusions, refilled.clientExclusions]).toEqual(["XOM (DNS)", ""]);
    expect(refilled.exclusionsFilledText).toEqual(second);
  });

  it("keeps a field the user has typed over, but still records the new text", () => {
    const typed = { ...withStandingExclusions(initialNewRequestDraft(), first, "fill"), advisorExclusions: "TSLA (DNB); NVDA (my note)" };
    const next = withStandingExclusions(typed, second, "fill");
    expect(next.advisorExclusions).toBe("TSLA (DNB); NVDA (my note)");
    expect(next.clientExclusions).toBe("");
    expect(next.exclusionsFilledText).toEqual(second);
  });

  it("replaces both fields after a dialog save, typed text included", () => {
    const typed = { ...withStandingExclusions(initialNewRequestDraft(), first, "fill"), advisorExclusions: "typed", clientExclusions: "typed" };
    const next = withStandingExclusions(typed, second, "replace");
    expect([next.advisorExclusions, next.clientExclusions]).toEqual(["XOM (DNS)", ""]);
  });

  it("fills only for a new request with listed clients selected", () => {
    expect(standingExclusionsFillKey(context({}))).toBeNull();
    expect(JSON.parse(standingExclusionsFillKey(context({ clientIds: ["c-blair", "c-alex"] }))!)).toEqual([
      { id: "c-blair", name: "Lucille Howell" }, { id: "c-alex", name: "Maeve Brennan" }]);
    expect(standingExclusionsFillKey(context({ clientIds: ["c-alex"], formMode: "edit" }))).toBeNull();
    expect(standingExclusionsFillKey(context({ clientIds: ["c-alex"], formMode: "clone" }))).toBeNull();
    expect(standingExclusionsFillKey(context({ clientIds: ["c-alex"], manualMode: true }))).toBeNull();
    expect(standingExclusionsFillKey(context({ clientIds: ["unknown"] }))).toBeNull();
  });
});

describe("Manage actions (AC-118, AC-121; states of AC-120 and AC-143)", () => {
  it("enables Manage exclusions only for a new request with a listed client, with the standalone titles", () => {
    expect(manageExclusionsEnabled(context({}))).toBe(false);
    expect(manageExclusionsTitle(context({}))).toBe("Select a client first");
    expect(manageExclusionsEnabled(context({ clientIds: ["c-alex"] }))).toBe(true);
    expect(manageExclusionsTitle(context({ clientIds: ["c-alex"] }))).toBe("Add or remove standing exclusions for this client without submitting a trade request");
    expect(manageExclusionsTitle(context({ clientIds: ["c-alex", "c-blair"] })))
      .toBe("Add or remove standing exclusions for any client in this household — switch tabs inside the modal");
    for (const formMode of ["edit", "clone"] as const) {
      expect(manageExclusionsEnabled(context({ clientIds: ["c-alex"], formMode }))).toBe(false);
      expect(manageExclusionsTitle(context({ clientIds: ["c-alex"], formMode }))).toBe("Standing list is disabled in edit / clone mode");
    }
    expect(manageExclusionsEnabled(context({ manualMode: true, manualClientName: "Manual" }))).toBe(false);
  });

  it("groups the selected accounts by client and shows Manage Account Restrictions only with listed accounts on a new request", () => {
    const both = context({ clientIds: ["c-alex", "c-blair"], selectedAccounts: ["SYN00003", "SYN00001"] });
    expect(accountExclusionGroups(both)).toEqual([
      { accountId: "a1", accountNumber: "SYN00001", clientName: "Maeve Brennan" },
      { accountId: "a3", accountNumber: "SYN00003", clientName: "Lucille Howell" },
    ]);
    expect(manageAccountRestrictionsShown(both)).toBe(true);
    expect(manageAccountRestrictionsShown(context({ clientIds: ["c-alex"] }))).toBe(false);
    expect(manageAccountRestrictionsShown(context({ clientIds: ["c-alex"], selectedAccounts: ["SYN00001"], formMode: "clone" }))).toBe(false);
    expect(manageAccountRestrictionsShown(context({ manualMode: true, selectedAccounts: ["SYN00001"] }))).toBe(false);
  });
});

describe("dialog staging (AC-118)", () => {
  const saved = row({ id: "s1", ticker: "TSLA", noBuy: true, noSell: false });
  const both = row({ id: "s2", ticker: "AAPL", noBuy: true, noSell: true });

  it("stages an add with no side, upper-cases and limits the ticker, limits the reason and needs a side to apply", () => {
    let pending: PendingChanges = { ...NO_PENDING, adds: [stagedAdd("t1", "client")] };
    expect(applyEnabled(pending, false)).toBe(false);
    pending = withStagedField(pending, "t1", "ticker", "brk.b-very-long-ticker-name");
    pending = withStagedField(pending, "t1", "reason", "r".repeat(600));
    expect(pending.adds[0].ticker).toBe("BRK.B-VERY-LONG-TICK");
    expect(pending.adds[0].reason).toHaveLength(500);
    expect(applyEnabled(pending, false)).toBe(false);
    pending = withStagedSide(pending, "t1", "noSell");
    expect(applyEnabled(pending, false)).toBe(true);
    expect(applyEnabled(pending, true)).toBe(false);
    expect(applyEnabled({ ...pending, adds: [{ ...pending.adds[0], ticker: "  " }] }, false)).toBe(false);
    expect(batchFromPending(pending).add).toEqual([{ ticker: "BRK.B-VERY-LONG-TICK", kind: "client", reason: "r".repeat(500), noBuy: false, noSell: true }]);
  });

  it("changes sides, drops a change back to the saved sides and refuses clearing both", () => {
    expect(sideLocked(NO_PENDING, saved, "noBuy")).toBe(true);
    expect(withSavedSideToggled(NO_PENDING, saved, "noBuy")).toBe(NO_PENDING);
    let pending = withSavedSideToggled(NO_PENDING, saved, "noSell");
    expect(pending.edits).toEqual({ s1: { noBuy: true, noSell: true } });
    expect(sideChangeText(saved, effectiveSides(pending, saved))).toBe("Side change pending: DNB → DNB+DNS");
    pending = withSavedSideToggled(pending, saved, "noBuy");
    expect(pending.edits).toEqual({ s1: { noBuy: false, noSell: true } });
    pending = withSavedSideToggled(withSavedSideToggled(pending, saved, "noBuy"), saved, "noSell");
    expect(pending.edits).toEqual({});
    expect(pendingCount(pending)).toBe(0);
  });

  it("marks and unmarks removal, dropping any side change on that row", () => {
    let pending = withSavedSideToggled(NO_PENDING, both, "noSell");
    pending = withRemovalToggled(pending, "s2");
    expect(pending).toEqual({ adds: [], removeIds: ["s2"], edits: {} });
    expect(withSavedSideToggled(pending, both, "noBuy")).toBe(pending);
    expect(effectiveSides(pending, both)).toEqual({ noBuy: true, noSell: true });
    expect(withRemovalToggled(pending, "s2").removeIds).toEqual([]);
  });

  it("builds the batch, the Apply label, the saved summary and the discard message", () => {
    const pending: PendingChanges = {
      adds: [{ ...stagedAdd("t1", "advisor"), ticker: " nvda ", reason: " Note ", noBuy: true }],
      removeIds: ["s2"], edits: { s1: { noBuy: false, noSell: true } },
    };
    expect(batchFromPending(pending)).toEqual({
      add: [{ ticker: "NVDA", kind: "advisor", reason: "Note", noBuy: true, noSell: false }], remove: ["s2"], edit: [{ id: "s1", noBuy: false, noSell: true }],
    });
    expect(applyLabel(pending)).toBe("Apply 3 changes");
    expect(applyLabel({ ...NO_PENDING, removeIds: ["s2"] })).toBe("Apply 1 change");
    expect(applyLabel(NO_PENDING)).toBe("Apply changes");
    expect(savedSummary({ added: 1, removed: 0, edited: 2 })).toBe("Saved. Added 1. Updated 2.");
    const labels = new Map([["c-alex", "Maeve Brennan"], ["c-blair", "Lucille Howell"]]);
    expect(discardMessage({ "c-alex": pending }, labels)).toBe("Discard 3 unsaved changes for Maeve Brennan?");
    expect(discardMessage({ "c-alex": { ...NO_PENDING, removeIds: ["x"] }, "c-blair": pending }, labels))
      .toBe("Discard 1 unsaved change for Maeve Brennan and 3 unsaved changes for Lucille Howell?");
    expect(discardMessage({ "c-alex": NO_PENDING }, labels)).toBeNull();
    expect(addedByText(row({ createdAt: "not a date" }))).toBe("added by Avery Stone, not a date");
  });
});
