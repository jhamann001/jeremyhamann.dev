import { describe, expect, it } from "vitest";
import {
  NEW_REQUEST_COPY,
  NEW_REQUEST_SUBMIT_GATES,
  accountsForClients,
  clientsById,
  formatCurrency,
  householdLookupInput,
  householdResolutionKey,
  householdsWithUnselected,
  initialNewRequestDraft,
  listedTotal,
  manualAccountProvided,
  manualTotal,
  mergeHouseholdSelection,
  newRequestCapWarning,
  newRequestSubmitEnabled,
  newRequestSubmitLabel,
  selectedAccountUlids,
  withClients,
  withManualMode,
  type HouseholdResolveResult,
  type NewRequestClient,
  type NewRequestDraft,
} from "@/lib/trade-requests/new-request";

const ulid = (n: number) => `01TRW11SYNTHETIC${String(n).padStart(10, "0")}`;
const account = (n: number, balance = 1_000) => ({ id: ulid(n), accountNumber: `SYN${String(n).padStart(5, "0")}`, accountType: "Taxable", balance });
const ALEX: NewRequestClient = { id: "c-alex", name: "Maeve Brennan", accounts: [account(1, 1_500), account(2, 2_500)] };
const BLAIR: NewRequestClient = { id: "c-blair", name: "Lucille Howell", accounts: [account(3, 4_000)] };
const WIDE: NewRequestClient = { id: "c-wide", name: "Wide Portfolio Trust", accounts: Array.from({ length: 55 }, (_, i) => account(100 + i)) };
const FILLERS: NewRequestClient[] = Array.from({ length: 52 }, (_, i) => ({ id: `c-f${i}`, name: `Filler ${i}`, accounts: [account(300 + i)] }));
const CLIENTS = [ALEX, BLAIR, WIDE, ...FILLERS];
const byId = clientsById(CLIENTS);
// Allocation inputs that satisfy the Initial Funding gates, so these tests isolate the selection and cap gates.
const ALLOCATED = {
  liquidationApproval: "Yes" as const, riskProfile: 12, equityStrategies: [{ id: 1, benchmark: "SPY", allocation: "100", rationale: "Synthetic rationale" }],
};
const ctx = (patch: Partial<NewRequestDraft>) => ({ draft: { ...initialNewRequestDraft(), priority: "Standard" as const, ...ALLOCATED, ...patch }, clientsById: byId });

const BRENNAN: HouseholdResolveResult["households"][number] = {
  householdId: 7101, householdName: "Brennan Family Household", selectedAccountIds: [], clientIds: ["c-alex", "c-blair"],
  accounts: [
    { accountId: ulid(1), accountNumber: "SYN00001", accountTitle: "Maeve Brennan Individual", clientId: "c-alex" },
    { accountId: ulid(2), accountNumber: "SYN00002", accountTitle: "Maeve Brennan Roth", clientId: "c-alex" },
    { accountId: ulid(3), accountNumber: "SYN00003", accountTitle: "Lucille Howell IRA", clientId: "c-blair" },
  ],
};
const CARVER: HouseholdResolveResult["households"][number] = {
  householdId: 7102, householdName: "Carver Household", selectedAccountIds: [], clientIds: ["c-f0"],
  accounts: [{ accountId: ulid(300), accountNumber: "SYN00300", accountTitle: "Carver Joint", clientId: "c-f0" },
    { accountId: ulid(999), accountNumber: null, accountTitle: "Carver Trust", clientId: null }],
};

describe("selection (AC-39) and manual entry (AC-41)", () => {
  it("offers every account of every selected client, grouped in selection order", () => {
    const groups = accountsForClients(ctx({ clientIds: ["c-blair", "c-alex"] }));
    expect(groups.map((g) => g.client.name)).toEqual(["Lucille Howell", "Maeve Brennan"]);
    expect(groups.flatMap((g) => g.accounts.map((a) => a.accountNumber))).toEqual(["SYN00003", "SYN00001", "SYN00002"]);
  });

  it("clears the account selection when the clients change and totals the selected accounts", () => {
    const draft = withClients({ ...initialNewRequestDraft(), selectedAccounts: ["SYN00001"] }, ["c-alex"]);
    expect(draft.selectedAccounts).toEqual([]);
    expect(listedTotal(ctx({ clientIds: ["c-alex"], selectedAccounts: ["SYN00001", "SYN00002"] }))).toBe(4_000);
    expect(formatCurrency(4_000)).toBe("$4,000");
  });

  it("accepts a manual account only with a number and a balance above zero", () => {
    expect(manualAccountProvided({ id: "m1", accountNumber: "ABC1", accountType: "Taxable", balance: "$1,250" })).toBe(true);
    expect(manualAccountProvided({ id: "m1", accountNumber: "ABC1", accountType: "Taxable", balance: "0" })).toBe(false);
    expect(manualAccountProvided({ id: "m1", accountNumber: "  ", accountType: "Roth IRA", balance: "500" })).toBe(false);
    const draft = { ...initialNewRequestDraft(), priority: "Standard" as const, ...ALLOCATED, manualMode: true, manualClientName: "Sam Synthetic", manualSelectedIds: ["m1"],
      manualAccounts: [{ id: "m1", accountNumber: "ABC1", accountType: "Joint" as const, balance: "1250.50" }] };
    expect(manualTotal(draft)).toBe(1250.5);
    expect(newRequestSubmitEnabled({ draft, clientsById: byId })).toBe(true);
    expect(newRequestSubmitEnabled({ draft: { ...draft, manualAccounts: [{ ...draft.manualAccounts[0], balance: "" }] }, clientsById: byId })).toBe(false);
  });

  it("switching modes clears the other mode's values", () => {
    const listed = { ...initialNewRequestDraft(), clientIds: ["c-alex"], selectedAccounts: ["SYN00001"] };
    expect(withManualMode(listed, true)).toMatchObject({ manualMode: true, clientIds: [], selectedAccounts: [] });
    const manual = { ...initialNewRequestDraft(), manualMode: true, manualClientName: "X", manualSelectedIds: ["m"] };
    expect(withManualMode(manual, false)).toMatchObject({ manualMode: false, manualClientName: "", manualAccounts: [], manualSelectedIds: [] });
  });
});

describe("caps (AC-40, AC-109) and the Submit gate registry", () => {
  const fiftyOneClients = ["c-wide", ...FILLERS.slice(0, 50).map((c) => c.id)];
  const fiftyOneAccounts = WIDE.accounts.slice(0, 51).map((a) => a.accountNumber);

  it("shows the accounts message, which wins when both limits are exceeded", () => {
    const both = ctx({ clientIds: fiftyOneClients, selectedAccounts: fiftyOneAccounts });
    expect(newRequestCapWarning(both)).toBe("You have selected 51 accounts. Please reduce to 50 or fewer to submit.");
    expect(newRequestSubmitEnabled(both)).toBe(false);
  });

  it("shows the clients message when only the clients limit is exceeded", () => {
    const clients = ctx({ clientIds: fiftyOneClients, selectedAccounts: ["SYN00100"] });
    expect(newRequestCapWarning(clients)).toBe("You have selected 51 clients. Please reduce to 50 or fewer to submit.");
    expect(newRequestSubmitEnabled(clients)).toBe(false);
  });

  it("allows exactly 50 of each", () => {
    const fifty = ctx({ clientIds: fiftyOneClients.slice(0, 50), selectedAccounts: fiftyOneAccounts.slice(0, 50) });
    expect(newRequestCapWarning(fifty)).toBeNull();
    expect(newRequestSubmitEnabled(fifty)).toBe(true);
  });

  it("counts manual accounts and ignores the clients limit in manual mode", () => {
    const manualAccounts = Array.from({ length: 51 }, (_, i) => ({ id: `m${i}`, accountNumber: `M${i}`, accountType: "Taxable" as const, balance: "10" }));
    const manual = ctx({ manualMode: true, manualClientName: "Sam", manualAccounts, manualSelectedIds: manualAccounts.map((a) => a.id) });
    expect(newRequestCapWarning(manual)).toBe("You have selected 51 accounts. Please reduce to 50 or fewer to submit.");
  });

  it("requires every registered gate, so one unmet gate keeps Submit disabled", () => {
    expect(NEW_REQUEST_SUBMIT_GATES.map((g) => g.id)).toEqual([
      "selection", "caps", "priority", "raise-cash", "liquidate", "full-form-compliance", "risk-score", "strategies", "strategy-rationales", "cash-deposit",
    ]);
    const ready = ctx({ clientIds: ["c-alex"], selectedAccounts: ["SYN00001"] });
    expect(newRequestSubmitEnabled(ready)).toBe(true);
    expect(newRequestSubmitEnabled(ready, [...NEW_REQUEST_SUBMIT_GATES, { id: "later", owner: "TRW-13", holds: () => false }])).toBe(false);
    expect(newRequestSubmitEnabled(ctx({ clientIds: ["c-alex"] }))).toBe(false);
  });

  it("labels Submit for the default trade type", () => {
    expect(newRequestSubmitLabel(initialNewRequestDraft())).toBe(NEW_REQUEST_COPY.submitInitialFunding);
    expect(newRequestSubmitLabel({ ...initialNewRequestDraft(), tradeType: "Raise Cash" })).toBe(NEW_REQUEST_COPY.submitOther);
  });
});

describe("household helpers (AC-122 to AC-125, AC-142)", () => {
  it("asks with the selected clients and only account ids the household route accepts", () => {
    const local: NewRequestClient = { id: "local", name: "Local", accounts: [{ id: "uuid-1", accountNumber: "L1", accountType: "Taxable", balance: 1 }] };
    const context = { draft: { ...initialNewRequestDraft(), clientIds: ["c-alex", "local"], selectedAccounts: ["SYN00002", "L1"] }, clientsById: clientsById([ALEX, local]) };
    expect(selectedAccountUlids(context)).toEqual([ulid(2)]);
    expect(householdLookupInput(context)).toEqual({ clientIds: ["c-alex", "local"], accountIds: [ulid(2)] });
    expect(householdLookupInput(ctx({}))).toBeNull();
    expect(householdLookupInput(ctx({ manualMode: true, manualClientName: "X" }))).toBeNull();
  });

  it("finds households with unselected accounts: one (prompt), two (warning), none (nothing)", () => {
    const one = householdsWithUnselected({ households: [BRENNAN] }, [ulid(1), ulid(2)]);
    expect(one).toHaveLength(1);
    expect(one[0].missing.map((a) => a.accountTitle)).toEqual(["Lucille Howell IRA"]);
    expect(householdsWithUnselected({ households: [BRENNAN, CARVER] }, [ulid(1)])).toHaveLength(2);
    expect(householdsWithUnselected({ households: [BRENNAN] }, [ulid(1), ulid(2), ulid(3)])).toHaveLength(0);
  });

  it("include adds the accounts and their clients if not yet selected", () => {
    const draft = { ...initialNewRequestDraft(), clientIds: ["c-alex"], selectedAccounts: ["SYN00001", "SYN00002"] };
    const merged = mergeHouseholdSelection(draft, { households: [BRENNAN] }, [BRENNAN.accounts[2]]);
    expect(merged.clientIds).toEqual(["c-alex", "c-blair"]);
    expect(merged.selectedAccounts).toEqual(["SYN00001", "SYN00002", "SYN00003"]);
    const unmatched = mergeHouseholdSelection(draft, { households: [CARVER] }, [CARVER.accounts[1]]);
    expect(unmatched).toEqual(draft);
  });

  it("keys dismissal on the households and their accounts, not on the selection", () => {
    const key = householdResolutionKey({ households: [BRENNAN] });
    expect(householdResolutionKey({ households: [{ ...BRENNAN, selectedAccountIds: [ulid(1)] }] })).toBe(key);
    expect(householdResolutionKey({ households: [BRENNAN, CARVER] })).not.toBe(key);
    expect(householdResolutionKey({ households: [{ ...BRENNAN, accounts: BRENNAN.accounts.slice(0, 2) }] })).not.toBe(key);
    expect(householdResolutionKey(null)).toBeNull();
  });
});
