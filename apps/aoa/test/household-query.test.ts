import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS,
  householdDirectoryPageUrl,
  householdDirectoryQueryKey,
  householdDirectorySearchParams,
  parseHouseholdDirectoryPageNumber,
  parseHouseholdDirectoryQuery,
} from "@/lib/navigation/household-query";

const VERSION = "a".repeat(32);

describe("Households progressive query contract", () => {
  it.each([[undefined, 1], [null, 1], ["1", 1], ["25", 25], ["1000000", 1000000]])(
    "parses bounded SSR/API page input %s as %i", (input, expected) => {
      expect(parseHouseholdDirectoryPageNumber(input)).toBe(expected);
    },
  );

  it.each(["", "0", "-1", "01", "1.5", "1e2", "1x", " 2", "2 ", "2\n", "1000001",
    "99999999999999999999999", 1, Infinity, NaN, ["1", "2"], {}])(
    "rejects invalid or ambiguous SSR page input %s", (input) => {
      expect(() => parseHouseholdDirectoryPageNumber(input)).toThrow("invalid_household_query");
    },
  );
  it("defaults to the compact 100-row Client directory", () => {
    expect(parseHouseholdDirectoryQuery(new URLSearchParams())).toEqual({
      filters: DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS,
      page: 1, pageSize: 100, snapshot: null, queryKey: "",
    });
  });

  it("normalizes filter values and produces stable keys independent of page/version/order", () => {
    const first = parseHouseholdDirectoryQuery(new URLSearchParams(
      "q=%20Synthetic%20&advisor=%20ONE%40example.test%20&status=%20On%20%20Hold%20&stage=all&sort=aum&dir=desc",
    ));
    const next = parseHouseholdDirectoryQuery(new URLSearchParams(
      `dir=desc&sort=aum&stage=all&status=on+hold&advisor=one%40example.test&q=Synthetic&page=2&snapshot=${VERSION}`,
    ));
    expect(first.queryKey).toBe(next.queryKey);
    expect(first.filters).toMatchObject({ query: "Synthetic", advisor: "one@example.test", status: "on hold" });
    expect(first.queryKey).not.toContain(VERSION);
    expect(first.queryKey).not.toContain("page=");
  });

  it("serializes filters without leaking them into unsafe URL fragments", () => {
    const filters = { ...DEFAULT_HOUSEHOLD_DIRECTORY_FILTERS, query: "A & B / ? #", stage: "all" as const };
    const url = new URL(householdDirectoryPageUrl(filters, 2, VERSION, 200), "https://example.test");
    expect(url.pathname).toBe("/api/households");
    expect(url.hash).toBe("");
    expect(parseHouseholdDirectoryQuery(url.searchParams)).toMatchObject({
      filters, page: 2, pageSize: 200, snapshot: VERSION,
      queryKey: householdDirectoryQueryKey(filters, 200),
    });
    expect(householdDirectorySearchParams(filters).get("q")).toBe(filters.query);
  });

  it.each([
    "page=0", "page=-1", "page=1.5", "page=1e2", "page=01", "page=1x", "page=", "page=1000001",
    "pageSize=0", "pageSize=99", "pageSize=201", "pageSize=100.5", "pageSize=", "pageSize=1000000",
    "stage=prospect", "stage=", "sort=account", "sort=", "dir=up", "dir=",
    "snapshot=", "snapshot=abc", `snapshot=${"A".repeat(32)}`, `snapshot=${VERSION}%0A`,
    "page=2", "q=one&q=two", "page=1&page=1", "unknown=1", "role=ADMIN", "email=other%40example.test",
    "q=%00", "q=%0A", "advisor=%0D", "status=%7F",
    `q=${"x".repeat(257)}`, `advisor=${"x".repeat(255)}`, `status=${"x".repeat(101)}`,
  ])("rejects malformed/ambiguous/unbounded query %s", (raw) => {
    expect(() => parseHouseholdDirectoryQuery(new URLSearchParams(raw))).toThrow("invalid_household_query");
  });

  it.each([100, 150, 200])("accepts a bounded page size of %i", (size) => {
    expect(parseHouseholdDirectoryQuery(new URLSearchParams(`pageSize=${size}`)).pageSize).toBe(size);
  });
});
