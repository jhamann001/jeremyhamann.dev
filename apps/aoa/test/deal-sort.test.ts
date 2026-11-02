import { describe, expect, it } from "vitest";
import { nextSort, sortDeals } from "../components/deals/deal-sort";

// D8 sortable headers (WO ticket): pure client-side sort over the fetched
// rows — amount numerically, dates by time with nulls last in either
// direction, text case-insensitively. All data invented.

type Row = Parameters<typeof sortDeals>[0][number];

const row = (over: Partial<Row> = {}): Row => ({
  client_first_name: "Jordan",
  client_last_name: "Sample",
  household_name: "Sample Household",
  amount: 100,
  stage: "POTENTIAL",
  account_type: "Roth IRA",
  account_last4: "1234",
  transferring_firm: "Fidelity",
  created_date: new Date("2026-01-01T00:00:00.000Z"),
  close_date: new Date("2026-06-01T00:00:00.000Z"),
  ...over,
});

describe("nextSort", () => {
  it("starts ascending on a new key and flips on the same key", () => {
    const first = nextSort(null, "amount");
    expect(first).toEqual({ key: "amount", dir: 1 });
    expect(nextSort(first, "amount")).toEqual({ key: "amount", dir: -1 });
    expect(nextSort({ key: "amount", dir: -1 }, "client")).toEqual({
      key: "client",
      dir: 1,
    });
  });
});

describe("sortDeals", () => {
  it("returns the rows untouched (copy) with no sort", () => {
    const rows = [row({ amount: 2 }), row({ amount: 1 })];
    const out = sortDeals(rows, null);
    expect(out.map((r) => r.amount)).toEqual([2, 1]);
    expect(out).not.toBe(rows);
  });

  it("sorts amount numerically (not lexically)", () => {
    const rows = [row({ amount: 90 }), row({ amount: 1000 }), row({ amount: 200 })];
    expect(
      sortDeals(rows, { key: "amount", dir: 1 }).map((r) => r.amount),
    ).toEqual([90, 200, 1000]);
    expect(
      sortDeals(rows, { key: "amount", dir: -1 }).map((r) => r.amount),
    ).toEqual([1000, 200, 90]);
  });

  it("sorts client case-insensitively by full name", () => {
    const rows = [
      row({ client_first_name: "zoe", client_last_name: "Ames" }),
      row({ client_first_name: "Ada", client_last_name: "Okafor" }),
    ];
    expect(
      sortDeals(rows, { key: "client", dir: 1 }).map((r) => r.client_first_name),
    ).toEqual(["Ada", "zoe"]);
  });

  it("null close dates sink to the bottom in BOTH directions", () => {
    const rows = [
      row({ close_date: null, amount: 1 }),
      row({ close_date: new Date("2026-08-01"), amount: 2 }),
      row({ close_date: new Date("2026-07-01"), amount: 3 }),
    ];
    expect(
      sortDeals(rows, { key: "close", dir: 1 }).map((r) => r.amount),
    ).toEqual([3, 2, 1]);
    expect(
      sortDeals(rows, { key: "close", dir: -1 }).map((r) => r.amount),
    ).toEqual([2, 3, 1]);
  });

  it("sorts the account column by its rendered composite", () => {
    const rows = [
      row({ account_type: "Trust", account_last4: null, transferring_firm: null, amount: 1 }),
      row({ account_type: "Cash", account_last4: null, transferring_firm: null, amount: 2 }),
      row({ account_type: null, account_last4: null, transferring_firm: null, amount: 3 }),
    ];
    expect(
      sortDeals(rows, { key: "account", dir: 1 }).map((r) => r.amount),
    ).toEqual([3, 2, 1]); // "" < "cash" < "trust"
  });
});
