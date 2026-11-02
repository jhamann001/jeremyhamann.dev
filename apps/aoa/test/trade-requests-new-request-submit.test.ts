import { describe, expect, it } from "vitest";
import {
  clientsById,
  initialNewRequestDraft,
  newRequestSubmitLabel,
  type HouseholdResolveResult,
  type NewRequestClient,
  type NewRequestDraft,
} from "@/lib/trade-requests/new-request";
import {
  SUBMIT_COPY,
  buildNewRequestPayload,
  canCloneToNewRequest,
  canEditAndResubmit,
  cloneRequestRoute,
  draftFromRequest,
  editRequestRoute,
  householdTagForSubmit,
  idempotencyStorageKey,
  newRequestFormTitle,
  submitFailureMessage,
} from "@/lib/trade-requests/new-request-submit";
import { manageAccountRestrictionsShown, manageExclusionsEnabled, manageExclusionsTitle } from "@/lib/trade-requests/new-request-exclusions";
import type { TradeRequest } from "@/lib/trade-requests/request-types";

// ticket: what Submit sends (AC-126, AC-152), the edit and clone prefill
// (AC-18, AC-91), titles and labels, failure text (AC-144), and who is
// offered Edit & Resubmit and Clone (AC-46, AC-47). Synthetic data.

const ULID_A = "01JSYNTHACCT000000000000AA";
const ULID_B = "01JSYNTHACCT000000000000BB";
const ULID_C = "01JSYNTHACCT000000000000CC";
const CLIENTS: NewRequestClient[] = [
  { id: "c-alex", name: "Maeve Brennan", accounts: [
    { id: ULID_A, accountNumber: "SYN00001", accountType: "Taxable", balance: 1_500 },
    { id: ULID_B, accountNumber: "SYN00002", accountType: "Roth IRA", balance: 2_500 }] },
  { id: "c-blair", name: "Lucille Howell", accounts: [{ id: ULID_C, accountNumber: "SYN00003", accountType: "Traditional IRA", balance: 4_000 }] },
];
const byId = clientsById(CLIENTS);
const ctx = (draft: Partial<NewRequestDraft>) => ({ draft: { ...initialNewRequestDraft(), ...draft }, clientsById: byId });
const household = (id: number, accounts: string[]): HouseholdResolveResult["households"][number] => ({
  householdId: id, householdName: `Synthetic Household ${id}`, selectedAccountIds: [], clientIds: [],
  accounts: accounts.map((accountId) => ({ accountId, accountNumber: null, accountTitle: "", clientId: null })),
});

function source(over: Partial<TradeRequest> = {}): TradeRequest {
  return {
    id: "REQ-SYN9", clientId: "c-alex", clientName: "Maeve Brennan & Lucille Howell", clientIds: ["c-alex", "c-blair"],
    clientNames: ["Maeve Brennan", "Lucille Howell"], advisor: "Avery Stone", submittedBy: "Avery Stone", tradeType: "Cash Deposit",
    tradeAmount: "25000", depositAccount: "SYN00001", rebalanceAll: true, status: "Needs Info", date: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-11T08:30:00.000Z", selectedAccounts: ["SYN00001", "SYN00003"], totalValue: 5_500, priority: "Urgent",
    advisorNotes: "Synthetic note", residence: "NY", liquidationApproval: "Yes",
    advisorExclusions: "TSLA (DNB - recorded)", clientExclusions: "AAPL (DNS)",
    esgFilters: { fossilFuels: true, tobacco: false, weapons: false, alcohol: false, gambling: false, other: true, otherDescription: "Palm oil", none: false },
    riskProfile: 12, baseAllocation: { equity: 61, fixed: 34.5, cash: 4.5 },
    equityStrategies: [{ id: 1, benchmark: "SPY", allocation: 60, rationale: "Core" }, { id: 2, benchmark: "EFA", allocation: 40, rationale: "Intl" }],
    raiseCashReason: "", liquidityDeadline: null, liquidateOption: "", liquidatePositions: "", assetLocationMode: "mirror", auditLog: [],
    ...over,
  };
}

describe("availability of Edit & Resubmit and Clone (AC-46, AC-47)", () => {
  it("Edit & Resubmit only for ADVISOR on Needs Info", () => {
    expect(canEditAndResubmit("ADVISOR", "Needs Info")).toBe(true);
    for (const role of ["ADMIN", "OPERATIONS", "CLIENT_SERVICE", "VIEWER"]) expect(canEditAndResubmit(role, "Needs Info")).toBe(false);
    for (const status of ["Pending Review", "Rejected", "Approved", "Completed", "Pending Current Asset Liquidation"]) {
      expect(canEditAndResubmit("ADVISOR", status)).toBe(false);
    }
  });

  it("Clone only for ADVISOR on Rejected", () => {
    expect(canCloneToNewRequest("ADVISOR", "Rejected")).toBe(true);
    for (const role of ["ADMIN", "OPERATIONS", "CLIENT_SERVICE", "VIEWER"]) expect(canCloneToNewRequest(role, "Rejected")).toBe(false);
    for (const status of ["Pending Review", "Needs Info", "Approved", "Completed", ""]) expect(canCloneToNewRequest("ADVISOR", status)).toBe(false);
  });

  it("routes sit under New Request and encode the id", () => {
    expect(editRequestRoute("REQ-1")).toBe("/trade-requests/new/edit/REQ-1");
    expect(cloneRequestRoute("REQ 1/x")).toBe("/trade-requests/new/clone/REQ%201%2Fx");
  });
});

describe("titles, labels and failure text (P2-170, P2-171, P2-243, AC-144)", () => {
  it("titles by mode", () => {
    expect(newRequestFormTitle("new", null, "New Trade Request")).toBe("New Trade Request");
    expect(newRequestFormTitle("edit", "REQ-1", "New Trade Request")).toBe("Resubmit: REQ-1");
    expect(newRequestFormTitle("clone", "REQ-1", "New Trade Request")).toBe("Clone from REQ-1");
  });

  it("submit labels", () => {
    const draft = initialNewRequestDraft();
    expect(newRequestSubmitLabel(draft)).toBe("Generate Plan & Submit");
    expect(newRequestSubmitLabel({ ...draft, tradeType: "Raise Cash" })).toBe("Submit Trade Request");
    expect(newRequestSubmitLabel({ ...draft, formMode: "edit" })).toBe("Resubmit to Trader");
    expect(newRequestSubmitLabel({ ...draft, formMode: "clone" })).toBe("Generate Plan & Submit");
    expect(newRequestSubmitLabel({ ...draft, formMode: "edit" }, true)).toBe("Submitting...");
  });

  it("the service text or failure description, else the default", () => {
    expect(submitFailureMessage("Validation failed: advisorNotes: String must contain at most 5000 character(s)"))
      .toBe("Validation failed: advisorNotes: String must contain at most 5000 character(s)");
    expect(submitFailureMessage("timeout of 120000ms exceeded")).toBe("timeout of 120000ms exceeded");
    expect(submitFailureMessage("")).toBe(SUBMIT_COPY.failed);
    expect(submitFailureMessage("  ")).toBe("Failed to submit request. Please try again.");
    expect(submitFailureMessage(null)).toBe("Failed to submit request. Please try again.");
  });

  it("one pending idempotency key per new form and per clone source; none for an edit", () => {
    expect(idempotencyStorageKey("new", null)).toBe("trade-requests:idempotency:new");
    expect(idempotencyStorageKey("clone", "REQ-1")).toBe("trade-requests:idempotency:clone-REQ-1");
    expect(idempotencyStorageKey("edit", "REQ-1")).toBeNull();
  });
});

describe("prefill from the source request (AC-18, AC-91)", () => {
  it("clone carries every field of the source, including its recorded exclusions", () => {
    const draft = draftFromRequest(source({ status: "Rejected" }), "clone");
    expect(draft).toMatchObject({
      formMode: "clone", clientIds: ["c-alex", "c-blair"], selectedAccounts: ["SYN00001", "SYN00003"], manualMode: false,
      tradeType: "Cash Deposit", priority: "Urgent", tradeAmount: "25000", depositAccount: "SYN00001", rebalanceAll: true,
      residence: "NY", liquidationApproval: "Yes", advisorNotes: "Synthetic note", riskProfile: 12,
      advisorExclusions: "TSLA (DNB - recorded)", clientExclusions: "AAPL (DNS)",
      esgFilters: { fossilFuels: true, tobacco: false, weapons: false, alcohol: false, gambling: false, other: true, otherDescription: "Palm oil", none: false },
      equityStrategies: [{ id: 1, benchmark: "SPY", allocation: "60", rationale: "Core" }, { id: 2, benchmark: "EFA", allocation: "40", rationale: "Intl" }],
      usePreviousAllocation: null,
    });
  });

  it("Raise Cash and Liquidate fields, a single client and the date input form", () => {
    const raise = draftFromRequest(source({
      clientIds: [], clientNames: [], tradeType: "Raise Cash", raiseCashReason: "Tuition", liquidityDeadline: "2026-11-30T00:00:00.000Z",
    }), "edit");
    expect(raise).toMatchObject({ formMode: "edit", clientIds: ["c-alex"], tradeType: "Raise Cash", raiseCashReason: "Tuition", liquidityDeadline: "2026-11-30" });
    const liquidate = draftFromRequest(source({ tradeType: "Liquidate", liquidateOption: "Specific Positions", liquidatePositions: "AAPL" }), "edit");
    expect(liquidate).toMatchObject({ liquidateOption: "Specific Positions", liquidatePositions: "AAPL" });
  });

  it("stored values the form does not offer start unchosen", () => {
    const draft = draftFromRequest(source({
      tradeType: "Mystery", priority: "Someday", residence: "TX", liquidationApproval: "Maybe", riskProfile: 40, equityStrategies: [],
      esgFilters: undefined as unknown as TradeRequest["esgFilters"],
    }), "edit");
    expect(draft).toMatchObject({ tradeType: "Initial Funding", priority: "", residence: "Other", liquidationApproval: "", riskProfile: null });
    expect(draft.equityStrategies).toEqual([{ id: 1, benchmark: "SPY", allocation: "100", rationale: "" }]);
    expect(draft.esgFilters.none).toBe(true);
  });

  it("edit and clone never take the standing lists, and both Manage actions are off (AC-120, AC-143)", () => {
    for (const mode of ["edit", "clone"] as const) {
      const context = { draft: draftFromRequest(source(), mode), clientsById: byId };
      expect(manageExclusionsEnabled(context)).toBe(false);
      expect(manageExclusionsTitle(context)).toBe("Standing list is disabled in edit / clone mode");
      expect(manageAccountRestrictionsShown(context)).toBe(false);
    }
    const fresh = ctx({ clientIds: ["c-alex"], selectedAccounts: ["SYN00001"] });
    expect(manageExclusionsEnabled(fresh)).toBe(true);
    expect(manageAccountRestrictionsShown(fresh)).toBe(true);
    expect(manageExclusionsEnabled(ctx({}))).toBe(false);
    expect(manageExclusionsTitle(ctx({}))).toBe("Select a client first");
    expect(manageAccountRestrictionsShown(ctx({ manualMode: true }))).toBe(false);
  });
});

describe("household recorded on submit (AC-126)", () => {
  const selection = { clientIds: ["c-alex", "c-blair"], selectedAccounts: ["SYN00001", "SYN00003"] };

  it("every selected account in one household records it", () => {
    const resolution = { households: [household(7, [ULID_A, ULID_B, ULID_C])] };
    expect(householdTagForSubmit(ctx(selection), resolution)).toEqual({ householdId: 7, householdName: "Synthetic Household 7" });
  });

  it("two households, an unmapped account, nothing resolved, manual entry or an edit record none", () => {
    const none = { householdId: null, householdName: null };
    expect(householdTagForSubmit(ctx(selection), { households: [household(7, [ULID_A]), household(8, [ULID_C])] })).toEqual(none);
    expect(householdTagForSubmit(ctx(selection), { households: [household(7, [ULID_A])] })).toEqual(none);
    expect(householdTagForSubmit(ctx(selection), null)).toEqual(none);
    expect(householdTagForSubmit(ctx({ ...selection, manualMode: true }), { households: [household(7, [ULID_A, ULID_C])] })).toEqual(none);
    expect(householdTagForSubmit(ctx({ ...selection, formMode: "edit" }), { households: [household(7, [ULID_A, ULID_C])] })).toEqual(none);
    expect(householdTagForSubmit(ctx({ clientIds: ["c-alex"] }), { households: [household(7, [ULID_A])] })).toEqual(none);
  });
});

describe("payload (standalone AdvisorForm handleSubmit)", () => {
  const full: Partial<NewRequestDraft> = {
    clientIds: ["c-alex"], selectedAccounts: ["SYN00001", "SYN00002"], priority: "Standard", residence: "CA", liquidationApproval: "No",
    riskProfile: 25, equityStrategies: [{ id: 1, benchmark: "SPY", allocation: "100", rationale: "Why" }], advisorNotes: "n",
    advisorExclusions: "TSLA (DNB)", clientExclusions: "AAPL (DNS)",
  };

  it("Initial Funding: one client, listed account data, the full-form fields, rebalance all", () => {
    const payload = buildNewRequestPayload(ctx(full), { households: { households: [household(3, [ULID_A, ULID_B])] } });
    expect(payload).toEqual({
      clientId: "c-alex", clientName: "Maeve Brennan", tradeType: "Initial Funding", tradeAmount: "", depositAccount: "", rebalanceAll: true,
      selectedAccounts: ["SYN00001", "SYN00002"],
      accountsData: [
        { accountNumber: "SYN00001", accountType: "Taxable", balance: 1_500 },
        { accountNumber: "SYN00002", accountType: "Roth IRA", balance: 2_500 }],
      priority: "Standard", advisorNotes: "n", residence: "CA", liquidationApproval: "No",
      advisorExclusions: "TSLA (DNB)", clientExclusions: "AAPL (DNS)", esgFilters: initialNewRequestDraft().esgFilters,
      riskProfile: 25, equityStrategies: [{ id: 1, benchmark: "SPY", allocation: 100, rationale: "Why" }],
      raiseCashReason: "", liquidityDeadline: null, liquidateOption: "", liquidatePositions: "",
      existingId: null, isClone: false, assetLocationMode: "priority", householdId: 3, householdName: "Synthetic Household 3",
    });
  });

  it("Rebalance never sends the New Deposits values (AC-152)", () => {
    const payload = buildNewRequestPayload(ctx({ ...full, tradeType: "Rebalance", tradeAmount: "9000", depositAccount: "SYN00001" }), { households: null });
    expect(payload.tradeAmount).toBe("");
    expect(payload.depositAccount).toBe("");
    expect(payload.rebalanceAll).toBe(true);
  });

  it("Cash Deposit sends its amount, deposit account and option", () => {
    const payload = buildNewRequestPayload(ctx({ ...full, tradeType: "Cash Deposit", tradeAmount: "5000", depositAccount: "SYN00002", rebalanceAll: false }), { households: null });
    expect(payload).toMatchObject({ tradeAmount: "5000", depositAccount: "SYN00002", rebalanceAll: false });
  });

  it("Raise Cash and Liquidate default the hidden compliance fields and drop the allocation", () => {
    const raise = buildNewRequestPayload(ctx({
      ...full, tradeType: "Raise Cash", tradeAmount: "1000", raiseCashReason: "Fees", liquidityDeadline: "2026-12-01",
      esgFilters: { ...initialNewRequestDraft().esgFilters, tobacco: true, none: false }, liquidateOption: "Entire Account",
    }), { households: null });
    expect(raise).toMatchObject({
      tradeAmount: "1000", raiseCashReason: "Fees", liquidityDeadline: "2026-12-01", residence: "Other", liquidationApproval: "",
      advisorExclusions: "", clientExclusions: "", esgFilters: initialNewRequestDraft().esgFilters, riskProfile: null, equityStrategies: [],
      liquidateOption: "", depositAccount: "",
    });
    const liquidate = buildNewRequestPayload(ctx({ ...full, tradeType: "Liquidate", liquidateOption: "Specific Positions", liquidatePositions: "AAPL", raiseCashReason: "x" }), { households: null });
    expect(liquidate).toMatchObject({ tradeAmount: "", liquidateOption: "Specific Positions", liquidatePositions: "AAPL", raiseCashReason: "", liquidityDeadline: null, residence: "Other" });
  });

  it("several clients send aligned ids and names, joined for the client name", () => {
    const payload = buildNewRequestPayload(ctx({ ...full, clientIds: ["c-alex", "c-blair"], selectedAccounts: ["SYN00003"] }), { households: null });
    expect(payload).toMatchObject({
      clientId: "c-alex", clientName: "Maeve Brennan & Lucille Howell", clientIds: ["c-alex", "c-blair"], clientNames: ["Maeve Brennan", "Lucille Howell"],
      accountsData: [{ accountNumber: "SYN00003", accountType: "Traditional IRA", balance: 4_000 }],
    });
  });

  it("manual entry sends the typed client and accounts and no account data", () => {
    const payload = buildNewRequestPayload(ctx({
      ...full, clientIds: [], selectedAccounts: [], manualMode: true, manualClientName: "Casey Manual",
      manualAccounts: [{ id: "m1", accountNumber: "MAN-1", accountType: "Joint", balance: "$1,200" }, { id: "m2", accountNumber: "", accountType: "Taxable", balance: "5" }],
      manualSelectedIds: ["m1"],
    }), { households: { households: [household(1, [ULID_A])] }, now: 1_700_000_000_000 });
    expect(payload).toMatchObject({
      clientId: "manual-1700000000000", clientName: "Casey Manual", selectedAccounts: ["MAN-1"], manualEntry: true,
      manualAccounts: [{ accountNumber: "MAN-1", accountType: "Joint", balance: 1_200 }], householdId: null, householdName: null,
    });
    expect(payload).not.toHaveProperty("accountsData");
    expect(payload).not.toHaveProperty("clientIds");
  });

  it("edit carries the source id and asset-location mode and no household; clone marks itself", () => {
    const src = source();
    const edit = buildNewRequestPayload({ draft: draftFromRequest(src, "edit"), clientsById: byId }, {
      households: { households: [household(9, [ULID_A, ULID_C])] }, source: src,
    });
    expect(edit).toMatchObject({ existingId: "REQ-SYN9", isClone: false, assetLocationMode: "mirror", householdId: null, tradeAmount: "25000" });
    const clone = buildNewRequestPayload({ draft: draftFromRequest(src, "clone"), clientsById: byId }, {
      households: { households: [household(9, [ULID_A, ULID_C])] }, source: src,
    });
    expect(clone).toMatchObject({ existingId: null, isClone: true, householdId: 9, advisorExclusions: "TSLA (DNB - recorded)" });
  });

  it("a source client the list no longer has keeps its recorded name", () => {
    const src = source({ clientIds: ["c-gone", "c-alex"], clientNames: ["Gone Client", "Maeve Brennan"], clientId: "c-gone", clientName: "Gone Client & Maeve Brennan" });
    const payload = buildNewRequestPayload({ draft: draftFromRequest(src, "clone"), clientsById: byId }, { households: null, source: src });
    expect(payload).toMatchObject({ clientName: "Gone Client & Maeve Brennan", clientNames: ["Gone Client", "Maeve Brennan"] });
  });
});
