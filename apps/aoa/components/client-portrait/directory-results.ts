import type { ClientListRow } from "@/lib/data/types";

export type ClientStageKey = "client" | "prospect" | "lost_prospect" | "lost_client";
export type ClientStageFilter = "all" | ClientStageKey;
export type ClientDirectorySortKey = "name" | "household";
export type DirectorySortDir = "asc" | "desc";

export type ClientDirectoryFilters = {
  query: string;
  stage: ClientStageFilter;
  sortKey: ClientDirectorySortKey;
  sortDir: DirectorySortDir;
};

export type ClientStageCounts = Record<ClientStageFilter, number>;

export const normalizedClientStage = (stage: string | null) =>
  (stage ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function clientStageKey(stage: string | null): ClientStageKey | null {
  switch (normalizedClientStage(stage)) {
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

export function clientDirectoryResult(
  rows: readonly ClientListRow[],
  filters: ClientDirectoryFilters,
  requestedPage: number,
  pageSize: number,
) {
  const counts: ClientStageCounts = {
    all: rows.length,
    client: 0,
    prospect: 0,
    lost_prospect: 0,
    lost_client: 0,
  };
  for (const row of rows) {
    const key = clientStageKey(row.household_stage);
    if (key) counts[key] += 1;
  }

  const query = filters.query.trim().toLowerCase();
  const matching = rows.filter((row) => {
    if (filters.stage !== "all" && clientStageKey(row.household_stage) !== filters.stage) {
      return false;
    }
    if (!query) return true;
    return (
      row.name.toLowerCase().includes(query) ||
      (row.household_name ?? "").toLowerCase().includes(query) ||
      (row.advisor_name ?? "").toLowerCase().includes(query) ||
      (row.lead_advisor_email ?? "").toLowerCase().includes(query)
    );
  });

  const direction = filters.sortDir === "asc" ? 1 : -1;
  matching.sort((a, b) => {
    if (filters.sortKey === "household") {
      const householdDifference = (a.household_name ?? "").localeCompare(
        b.household_name ?? "",
      );
      return (
        (householdDifference !== 0
          ? householdDifference
          : a.name.localeCompare(b.name)) * direction
      );
    }
    return a.name.localeCompare(b.name) * direction;
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
  };
}
