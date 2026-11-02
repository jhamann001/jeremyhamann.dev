import type { HouseholdListRow } from "@/lib/data/types";
import type { CombinedAccount } from "./accounts-helpers";

export type HouseholdStageFilter = "all" | "client" | "lost_client";
export type AccountStatusFilter = "open" | "closed" | "all";

export function normalizedFilterValue(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function householdStageKey(stage: string | null): string | null {
  switch (normalizedFilterValue(stage)) {
    case "client":
      return "client";
    case "prospect":
      return "prospect";
    case "lost prospect":
      return "lost_prospect";
    case "lost client":
      return "lost_client";
    default:
      return null;
  }
}

export function matchesHouseholdStage(
  stage: string | null,
  filter: HouseholdStageFilter,
): boolean {
  return filter === "all" || householdStageKey(stage) === filter;
}

export function householdAdvisorOptions(
  rows: readonly HouseholdListRow[],
): { value: string; label: string }[] {
  const byEmail = new Map<string, string>();
  for (const row of rows) {
    const value = normalizedFilterValue(row.lead_advisor_email);
    if (!value) continue;
    byEmail.set(value, row.advisor_name?.trim() || row.lead_advisor_email);
  }
  return [...byEmail.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function householdStatusOptions(rows: readonly HouseholdListRow[]): string[] {
  const values = new Map<string, string>();
  for (const row of rows) {
    const key = normalizedFilterValue(row.status);
    if (key && !values.has(key)) values.set(key, row.status!.trim());
  }
  return [...values.values()].sort((a, b) => a.localeCompare(b));
}

export function accountTypeOptions(accounts: readonly CombinedAccount[]): string[] {
  const values = new Map<string, string>();
  for (const account of accounts) {
    const key = normalizedFilterValue(account.type);
    if (key && !values.has(key)) values.set(key, account.type.trim());
  }
  return [...values.values()].sort((a, b) => a.localeCompare(b));
}

export function isClosedAccount(status: string | null): boolean {
  return normalizedFilterValue(status) === "closed";
}

export function matchesAccountStatus(
  status: string | null,
  filter: AccountStatusFilter,
): boolean {
  if (filter === "all") return true;
  return filter === "closed" ? isClosedAccount(status) : !isClosedAccount(status);
}
