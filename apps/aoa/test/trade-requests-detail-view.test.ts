import { describe, expect, it } from "vitest";
import {
  activeEsgFilters, auditNewestFirst, householdLabel, isLoadableRequestId, pdfAccountExclusions, residenceLabel,
  resolveSelectedAccounts, strategyTotal, uniqueAccountIds,
} from "@/lib/trade-requests/detail-view";
import { tradeRequestDetailRoute } from "@/lib/trade-requests/routes";
import type { TradeRequest } from "@/lib/trade-requests/request-types";

// ticket: pure helpers behind the request detail (synthetic data).

const base = {
  id: "REQ-SYN1", clientId: "HH-1", clientName: "Synthetic One", clientIds: ["HH-1"], clientNames: ["Synthetic One"],
  selectedAccounts: ["SYN-1", "SYN-3"],
  accountMetadata: [
    { accountId: "ulid-1", accountNumber: "SYN-1", accountType: "Taxable", balance: 10 },
    { accountId: null, accountNumber: "SYN-3", accountType: "Roth IRA", balance: 30 },
    { accountId: "ulid-9", accountNumber: "SYN-9", accountType: "Taxable", balance: 90 },
  ],
} as unknown as TradeRequest;

describe("request detail helpers (ticket)", () => {
  it("orders audit entries newest first, keeping service order for equal times (AC-42)", () => {
    const entries = [
      { id: "old", date: "2026-10-01T00:00:00.000Z", user: "u", action: "Created", notes: "" },
      { id: "new", date: "2026-10-03T00:00:00.000Z", user: "u", action: "Approved", notes: "" },
      { id: "mid-a", date: "2026-10-02T00:00:00.000Z", user: "u", action: "A", notes: "" },
      { id: "mid-b", date: "2026-10-02T00:00:00.000Z", user: "u", action: "B", notes: "" },
    ];
    expect(auditNewestFirst(entries).map((entry) => entry.id)).toEqual(["new", "mid-a", "mid-b", "old"]);
    expect(auditNewestFirst(undefined)).toEqual([]);
  });

  it("places selected accounts from the client list first, else from the request's stored details", () => {
    const clients = [{ id: "HH-1", name: "Synthetic One", accounts: [
      { id: "live-1", clientId: "HH-1", accountNumber: "SYN-1", accountType: "Taxable", balance: 11 },
      { id: "live-2", clientId: "HH-1", accountNumber: "SYN-2", accountType: "Taxable", balance: 22 },
    ] }];
    expect(resolveSelectedAccounts(base, clients).map((a) => [a.id, a.balance])).toEqual([["live-1", 11]]);
    expect(resolveSelectedAccounts(base, null).map((a) => [a.id, a.accountNumber, a.balance])).toEqual([
      ["ulid-1", "SYN-1", 10], ["SYN-3", "SYN-3", 30],
    ]);
    expect(resolveSelectedAccounts(base, [{ id: "HH-other", name: "x", accounts: [] }])).toHaveLength(2);
  });

  it("maps the PDF's account exclusions by account id in selected-account order", () => {
    const accounts = resolveSelectedAccounts(base, null);
    expect(uniqueAccountIds(accounts)).toEqual(["ulid-1", "SYN-3"]);
    expect(pdfAccountExclusions(accounts, {
      "SYN-3": [{ id: "e2", accountId: "SYN-3", ticker: "SYNB", kind: "client", reason: "", noBuy: true, noSell: true }],
      "ulid-1": [{ id: "e1", accountId: "ulid-1", ticker: "SYNA", kind: "advisor", reason: "r", noBuy: true, noSell: false }],
    })).toEqual([
      { accountNumber: "SYN-1", kind: "advisor", ticker: "SYNA", reason: "r", noBuy: true, noSell: false },
      { accountNumber: "SYN-3", kind: "client", ticker: "SYNB", reason: "", noBuy: true, noSell: true },
    ]);
  });

  it("formats household, ESG, residence and strategy totals as the standalone detail does", () => {
    expect(householdLabel(base)).toBe("Synthetic One");
    expect(householdLabel({ clientName: "A", clientNames: ["A", "B"] })).toBe("A & B");
    expect(activeEsgFilters({ fossilFuels: true, tobacco: false, other: true, otherDescription: "Synthetic", none: false })).toEqual(["Fossil Fuels", "Other: Synthetic"]);
    expect(activeEsgFilters({ none: true })).toEqual([]);
    expect([residenceLabel("NY"), residenceLabel("CA"), residenceLabel("Other")]).toEqual([
      "New York (NY) - Muni Preference", "California (CA) - Muni Preference", "Other / Not Applicable",
    ]);
    expect(strategyTotal({ equityStrategies: [{ id: 1, benchmark: "a", allocation: 60, rationale: "" }, { id: 2, benchmark: "b", allocation: 30, rationale: "" }] })).toBe(90);
  });

  it("refuses dot-segment ids and workspace sub-routes, and builds the encoded direct link", () => {
    expect(["", ".", "..", "a..b"].map(isLoadableRequestId)).toEqual([false, false, false, false]);
    expect(isLoadableRequestId("REQ-2R5R5W85")).toBe(true);
    expect(["queue", "new", "Queue", "NEW"].map(isLoadableRequestId)).toEqual([false, false, false, false]);
    expect(isLoadableRequestId("queued")).toBe(true);
    expect(tradeRequestDetailRoute("REQ 1/2")).toBe("/trade-requests/REQ%201%2F2");
  });
});
