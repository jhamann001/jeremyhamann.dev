import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountTypeOptions,
  householdAdvisorOptions,
  householdStageKey,
  householdStatusOptions,
  isClosedAccount,
  matchesAccountStatus,
  matchesHouseholdStage,
} from "@/components/households/filters-helpers";
import type { HouseholdListRow } from "@/lib/data/types";

const rows: HouseholdListRow[] = [
  {
    sf_id: "hh-1",
    name: "Alpha Household",
    status: "Active",
    stage: "Client",
    aum: 100,
    lead_advisor_email: "one@example.com",
    household_kind: "CLIENT",
    member_count: 2,
    advisor_name: "Advisor One",
    aum_source: "apex",
    employeeStatus: null,
  },
  {
    sf_id: "hh-2",
    name: "Beta Household",
    status: "Onboarding",
    stage: "Prospect",
    aum: null,
    lead_advisor_email: "two@example.com",
    household_kind: "CLIENT",
    member_count: 1,
    advisor_name: null,
    aum_source: null,
    employeeStatus: null,
  },
  {
    sf_id: "hh-3",
    name: "Gamma Household",
    status: " active ",
    stage: "Lost Prospect",
    aum: 0,
    lead_advisor_email: "one@example.com",
    household_kind: "CLIENT",
    member_count: 1,
    advisor_name: "Advisor One",
    aum_source: "apex",
    employeeStatus: null,
  },
];

describe("household directory filters", () => {
  it("keeps prospect stages in All while exposing only the retained quick filters", () => {
    expect(householdStageKey(" Lost  Prospect ")).toBe("lost_prospect");
    expect(matchesHouseholdStage("Prospect", "all")).toBe(true);
    expect(matchesHouseholdStage("Prospect", "client")).toBe(false);
  });

  it("builds de-duplicated advisor and status options from real row fields", () => {
    expect(householdAdvisorOptions(rows)).toEqual([
      { value: "one@example.com", label: "Advisor One" },
      { value: "two@example.com", label: "two@example.com" },
    ]);
    expect(householdStatusOptions(rows)).toEqual(["Active", "Onboarding"]);
  });
});

describe("combined-account filters", () => {
  const account = (row: { owner: string; type: string; num: string; status: string | null; value: number }) => ({
    ...row, cash: row.value, securities: 0, balanceAsOf: "2026-08-21",
    balanceCurrent: row.status !== "CLOSED", closeDate: row.status === "CLOSED" ? "2026-04-14" : null,
    closeDateSource: row.status === "CLOSED" ? "APEX" as const : null,
  });
  const accounts = [
    account({ owner: "A", type: "Roth IRA", num: "1", status: "OPEN", value: 100 }),
    account({ owner: "B", type: " roth  ira ", num: "2", status: "CLOSED", value: 25 }),
    account({ owner: "B", type: "Individual", num: "3", status: null, value: 50 }),
  ];

  it("uses a strict closed bucket and treats other/unknown statuses as current", () => {
    expect(isClosedAccount(" closed ")).toBe(true);
    expect(matchesAccountStatus("CLOSED", "open")).toBe(false);
    expect(matchesAccountStatus("CLOSED", "closed")).toBe(true);
    expect(matchesAccountStatus(null, "open")).toBe(true);
    expect(matchesAccountStatus("RESTRICTED", "all")).toBe(true);
  });

  it("builds normalized, de-duplicated account-type choices", () => {
    expect(accountTypeOptions(accounts)).toEqual(["Individual", "Roth IRA"]);
  });

  it("renders the filtered balance in the visible-total row", () => {
    const overview = readFileSync(
      resolve(process.cwd(), "components/households/HouseholdOverview.tsx"),
      "utf8",
    );

    expect(overview).toContain(
      'visibleTotal.available ? usd(visibleTotal.value) : "—"',
    );
  });
});
