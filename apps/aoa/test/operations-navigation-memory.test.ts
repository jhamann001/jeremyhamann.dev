import { describe, expect, it } from "vitest";
import { createListHistoryEntries, LIST_HISTORY_STATE_KEY } from "@/lib/navigation/history-entry";
import { createListNavigationMemory, currentListDetailHref, safeListDetailHref, safeListHref, safeHouseholdListHref } from "@/lib/navigation/list-memory";

const fees = "/operations/fee-requests";
const recon = "/operations/trade-reconciliation";
const scope = "synthetic-operations-scope";
const position = { firstPage: 1, lastPage: 3, anchorId: "synthetic-record", anchorOffset: 12, scrollTop: 450, expandedIds: ["synthetic-record"] };

describe("bounded Operations navigation metadata", () => {
  it("adds only exact fee/reconciliation routes without widening the household helper", () => {
    expect(safeListHref(`${fees}?tab=exceptions&status=PENDING&from=2026-09-01&sort=waiver&dir=asc`))
      .toBe(`${fees}?dir=asc&from=2026-09-01&sort=waiver&status=PENDING&tab=exceptions`);
    expect(safeListHref(`${recon}?tab=history&history=monthly&view=summary`))
      .toBe(`${recon}?history=monthly&tab=history&view=summary`);
    expect(safeHouseholdListHref(fees)).toBeNull();
    expect(safeListHref("/households?sort=aum")).toBe("/households?sort=aum");
  });

  it.each([
    "https://example.test/operations/fee-requests", "//example.test/operations/fee-requests",
    "/operations/fee-requests/", "/operations/fee-requests-extra", "/operations/fee-requests?status=PENDING&status=CREDITED",
    "/operations/fee-requests?returnTo=https://example.test", "/operations/fee-requests?tab=unknown",
    "/operations/fee-requests?from=2026-02-30", "/operations/fee-requests?type=FEE_CREDIT",
    "/operations/fee-requests?status=CLOSED", "/operations/fee-requests?q=%0Asecret",
    "/operations/fee-requests?page=1000001", "/operations/fee-requests#request",
    "/operations/trade-reconciliation?run=../../elsewhere", "/operations/trade-reconciliation?history=yearly",
    "/operations/trade-reconciliation?view=unknown", "/operations/trade-reconciliation?breaks=unknown",
  ])("rejects malformed or unapproved navigation metadata %s", (href) => {
    expect(safeListHref(href)).toBeNull();
  });

  it("keeps distinct same-route detail identities and rejects arbitrary params", () => {
    expect(safeListDetailHref(`${fees}?request=synthetic-request-01`)).toBe(`${fees}?request=synthetic-request-01`);
    expect(safeListDetailHref(`${fees}?request=short`)).toBeNull();
    expect(safeListDetailHref(`${fees}?request=synthetic-request-01&next=/households`)).toBeNull();
    expect(safeListDetailHref(`${fees}?request=synthetic-request-01&message=workflow-updated#request-synthetic-request-01`)).toBeNull();
    expect(currentListDetailHref(`${fees}?request=synthetic-request-01&message=workflow-updated#request-synthetic-request-01`)).toBe(`${fees}?request=synthetic-request-01`);
    expect(safeListDetailHref(`${fees}?request=synthetic-request-01#request-synthetic-request-02`)).toBeNull();
    expect(safeListDetailHref(`${fees}?request=synthetic-request-01&message=anything`)).toBeNull();
    expect(safeListDetailHref(`${recon}?run=synthetic-run`)).toBe(`${recon}?run=synthetic-run`);
  });

  it("retains household origins with detail filters and fee origins after action notices", () => {
    let location = "/households/synthetic-home?accountStatus=closed&accountType=IRA";
    let state: Record<string, unknown> = {};
    let sequence = 0;
    const history = createListHistoryEntries({
      readState: () => state, replaceState: (next) => { state = next; },
      pathname: () => location.split("?")[0], href: () => location,
      randomToken: () => (++sequence).toString(16).padStart(32, "0"),
    });
    history.setScope(scope);
    const origin = { href: "/households?sort=aum", entryId: "a".repeat(32) };
    expect(history.getDetailReturnTarget(scope, "/households/synthetic-home", origin)).toEqual(origin);
    const detailState = { ...state };
    history.recordTraversal(detailState, location); state = {};
    expect(history.getDetailReturnTarget(scope, "/households/synthetic-home", null)).toEqual(origin);
    location = `${fees}?message=workflow-updated&request=synthetic-request-01`; state = {};
    const feeOrigin = { href: `${fees}?tab=exceptions`, entryId: "b".repeat(32) };
    expect(history.getDetailReturnTarget(scope, `${fees}?request=synthetic-request-01`, feeOrigin)).toEqual(feeOrigin);
    history.recordTraversal(state, location); state = {};
    expect(history.getDetailReturnTarget(scope, `${fees}?request=synthetic-request-01`, null)).toEqual(feeOrigin);
  });

  it("retains positions beyond fifteen minutes without retaining row payloads", () => {
    let time = 100;
    const memory = createListNavigationMemory({ now: () => time });
    memory.setScope(scope);
    expect(memory.save(scope, `${fees}?tab=exceptions`, { ...position, clientName: "must-not-persist" } as typeof position)).toBe(true);
    time += 60 * 60_000;
    expect(memory.read(scope, `${fees}?tab=exceptions`)).toMatchObject(position);
    expect(JSON.stringify(memory.read(scope, `${fees}?tab=exceptions`))).not.toContain("must-not-persist");
    expect(memory.read(scope, fees)).toBeNull();
    memory.setScope("another-login");
    expect(memory.read(scope, `${fees}?tab=exceptions`)).toBeNull();
  });

  it("remembers exact request return origins, not the last other record", () => {
    const memory = createListNavigationMemory();
    memory.setScope(scope);
    memory.save(scope, fees, position);
    expect(memory.rememberReturn(scope, `${fees}?request=synthetic-request-01`, fees)).toBe(true);
    expect(memory.returnHref(scope, `${fees}?request=synthetic-request-01`)).toBe(fees);
    expect(memory.returnHref(scope, `${fees}?request=synthetic-request-02`)).toBeNull();
  });

  it("preserves separate route/history occurrences and framework state on return", () => {
    let location = `${fees}?tab=exceptions`;
    let state: Record<string, unknown> = { framework: "retained" };
    let sequence = 0;
    const history = createListHistoryEntries({
      readState: () => state, replaceState: (next) => { state = next; },
      pathname: () => location.split("?")[0], href: () => location,
      randomToken: () => (++sequence).toString(16).padStart(32, "0"),
    });
    history.setScope(scope);
    const id = history.getEntryId(scope, location)!;
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(state.framework).toBe("retained");
    const listState = { ...state };
    const origin = { href: location, entryId: id };
    location = `${fees}?request=synthetic-request-01`; state = {};
    expect(history.getDetailReturnTarget(scope, location, origin)).toEqual(origin);
    expect(history.getDetailReturnTarget(scope, `${fees}?request=synthetic-request-02`, origin)).toBeNull();
    location = origin.href;
    history.recordTraversal(listState, location);
    state = { framework: "restored" };
    expect(history.getEntryId(scope, location)).toBe(id);
    expect(state[LIST_HISTORY_STATE_KEY]).toBe(id);
    expect(state.framework).toBe("restored");
    location = `${recon}?tab=history`; state = { ...state };
    expect(history.getEntryId(scope, location)).not.toBe(id);
  });
});
