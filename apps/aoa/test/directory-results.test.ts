import { describe, expect, it } from "vitest";
import {
  householdDirectoryResult,
  type HouseholdDirectoryFilters,
} from "@/components/households/directory-results";
import {
  clientDirectoryResult,
  type ClientDirectoryFilters,
} from "@/components/client-portrait/directory-results";
import type { ClientListRow, HouseholdListRow } from "@/lib/data/types";

function household(
  id: number,
  overrides: Partial<HouseholdListRow> = {},
): HouseholdListRow {
  return {
    sf_id: `hh-${id}`,
    name: `Household ${String(id).padStart(3, "0")}`,
    status: id % 2 === 0 ? "Active" : "Onboarding",
    stage: "Client",
    aum: id,
    lead_advisor_email: id % 2 === 0 ? "even@example.com" : "odd@example.com",
    household_kind: "CLIENT",
    member_count: 1,
    advisor_name: id % 2 === 0 ? "Even Advisor" : "Odd Advisor",
    aum_source: "apex",
    employeeStatus: null,
    ...overrides,
  };
}

function client(id: number, overrides: Partial<ClientListRow> = {}): ClientListRow {
  return {
    sf_id: `client-${id}`,
    name: `Client ${String(id).padStart(3, "0")}`,
    household_id: `hh-${id}`,
    household_name: `Household ${String(id).padStart(3, "0")}`,
    household_stage: "Client",
    lead_advisor_email: "advisor@example.com",
    advisor_name: "Advisor",
    employeeStatus: null,
    ...overrides,
  };
}

describe("bounded household directory results", () => {
  const filters: HouseholdDirectoryFilters = {
    query: "",
    stage: "client",
    advisor: "",
    status: "",
    sortKey: "name",
    sortDir: "asc",
  };

  it("sends only the requested page while keeping full counts and filter options", () => {
    const rows = [
      ...Array.from({ length: 205 }, (_, index) => household(index + 1)),
      household(999, { stage: "Lost Client" }),
    ];
    const result = householdDirectoryResult(rows, filters, 2, 100);

    expect(result.rows).toHaveLength(100);
    expect(result.rows[0]?.name).toBe("Household 101");
    expect(result.total).toBe(205);
    expect(result.pageCount).toBe(3);
    expect(result.counts).toEqual({ all: 206, client: 205, lost_client: 1 });
    expect(result.advisorOptions).toHaveLength(2);
    expect(result.statusOptions).toEqual(["Active", "Onboarding"]);
  });

  it("applies search and filters before pagination and clamps invalid pages", () => {
    const rows = [
      household(1, { name: "Alpha", status: "Active" }),
      household(2, { name: "Beta", status: "Active" }),
      household(3, { name: "Gamma", status: "Onboarding" }),
    ];
    const result = householdDirectoryResult(
      rows,
      { ...filters, query: "a", status: "active", sortDir: "desc" },
      99,
      1,
    );

    expect(result.total).toBe(2);
    expect(result.page).toBe(2);
    expect(result.rows.map((row) => row.name)).toEqual(["Alpha"]);
  });
});

describe("bounded client directory results", () => {
  const filters: ClientDirectoryFilters = {
    query: "",
    stage: "client",
    sortKey: "name",
    sortDir: "asc",
  };

  it("paginates the active client book without losing lifecycle counts", () => {
    const rows = [
      ...Array.from({ length: 150 }, (_, index) => client(index + 1)),
      client(999, { household_stage: "Prospect" }),
      client(1000, { household_stage: "Lost Client" }),
    ];
    const result = clientDirectoryResult(rows, filters, 2, 100);

    expect(result.rows).toHaveLength(50);
    expect(result.total).toBe(150);
    expect(result.pageCount).toBe(2);
    expect(result.counts).toEqual({
      all: 152,
      client: 150,
      prospect: 1,
      lost_prospect: 0,
      lost_client: 1,
    });
  });

  it("searches household and advisor context before sorting", () => {
    const rows = [
      client(1, { name: "Zeta", household_name: "Stone Household" }),
      client(2, { name: "Alpha", advisor_name: "Stone Advisor" }),
      client(3, { name: "Other", household_stage: "Prospect" }),
    ];
    const result = clientDirectoryResult(
      rows,
      { ...filters, query: "stone" },
      1,
      100,
    );

    expect(result.rows.map((row) => row.name)).toEqual(["Alpha", "Zeta"]);
  });
});
