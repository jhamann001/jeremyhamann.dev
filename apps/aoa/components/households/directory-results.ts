import type { HouseholdListRow } from "@/lib/data/types";
import {
  householdAdvisorOptions,
  householdStageKey,
  householdStatusOptions,
  matchesHouseholdStage,
  normalizedFilterValue,
  type HouseholdStageFilter,
} from "./filters-helpers";

export type HouseholdDirectorySortKey = "name" | "stage" | "aum";
export type DirectorySortDir = "asc" | "desc";

export type HouseholdDirectoryFilters = {
  query: string;
  stage: HouseholdStageFilter;
  advisor: string;
  status: string;
  sortKey: HouseholdDirectorySortKey;
  sortDir: DirectorySortDir;
};

export type HouseholdStageCounts = Record<HouseholdStageFilter, number>;

const STAGE_RANK: Record<string, number> = {
  client: 0,
  prospect: 1,
  lost_prospect: 2,
  lost_client: 3,
};

export function householdDirectoryResult(
  rows: readonly HouseholdListRow[],
  filters: HouseholdDirectoryFilters,
  requestedPage: number,
  pageSize: number,
) {
  const counts: HouseholdStageCounts = {
    all: rows.length,
    client: 0,
    lost_client: 0,
  };
  for (const row of rows) {
    const key = householdStageKey(row.stage);
    if (key === "client" || key === "lost_client") counts[key] += 1;
  }

  const query = filters.query.trim().toLowerCase();
  const matching = rows.filter((row) => {
    if (!matchesHouseholdStage(row.stage, filters.stage)) return false;
    if (
      filters.advisor &&
      normalizedFilterValue(row.lead_advisor_email) !== filters.advisor
    ) return false;
    if (filters.status && normalizedFilterValue(row.status) !== filters.status) return false;
    if (!query) return true;
    return (
      row.name.toLowerCase().includes(query) ||
      row.lead_advisor_email.toLowerCase().includes(query) ||
      (row.advisor_name ?? "").toLowerCase().includes(query) ||
      (row.stage ?? "").toLowerCase().includes(query) ||
      (row.status ?? "").toLowerCase().includes(query)
    );
  });

  const direction = filters.sortDir === "asc" ? 1 : -1;
  matching.sort((a, b) => {
    if (filters.sortKey === "name") return a.name.localeCompare(b.name) * direction;
    if (filters.sortKey === "stage") {
      const stageDifference =
        (STAGE_RANK[householdStageKey(a.stage) ?? ""] ?? 99) -
        (STAGE_RANK[householdStageKey(b.stage) ?? ""] ?? 99);
      return stageDifference !== 0
        ? stageDifference * direction
        : a.name.localeCompare(b.name);
    }
    return (Number(a.aum ?? 0) - Number(b.aum ?? 0)) * direction;
  });

  const safePageSize = Math.max(1, Math.trunc(pageSize));
  const pageCount = Math.max(1, Math.ceil(matching.length / safePageSize));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pageCount);
  const start = (page - 1) * safePageSize;

  return {
    rows: matching.slice(start, start + safePageSize),
    total: matching.length,
    page,
    pageCount,
    pageSize: safePageSize,
    counts,
    advisorOptions: householdAdvisorOptions(rows),
    statusOptions: householdStatusOptions(rows),
  };
}
