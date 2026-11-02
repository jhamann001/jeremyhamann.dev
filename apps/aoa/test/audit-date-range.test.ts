import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditDateRange, validAuditDate } from "@/lib/navigation/audit-date-range";
import { parseAuditNavigationQuery } from "@/lib/navigation/audit-query";
import { parseAuditWindowQuery, parseAuditMetadataQuery } from "@/lib/navigation/audit-window-query";
import { listPageHref, safeListHref } from "@/lib/navigation/list-routes";

describe("recent Audit UTC date and compatibility contract", () => {
  it.each(["2024-02-29", "2026-09-17", "0001-01-01", "9999-12-31"])("accepts real ISO UTC date %s", value => {
    expect(validAuditDate(value)).toBe(true);
  });
  it.each(["2026-02-29", "2026-02-30", "2026-04-31", "0000-01-01", "2026-13-01", "2026-00-01", "2026-01-00", "2026-9-1", "2026-09-17T12:00:00Z", "tomorrow", ""])("rejects invalid date %s", value => {
    expect(validAuditDate(value)).toBe(false);
    expect(() => parseAuditWindowQuery(new URLSearchParams({ view: "changes", from: value }))).toThrow();
  });
  it("keeps inclusive open-ended ranges and their metadata-only navigation URLs", () => {
    expect(auditDateRange(undefined, undefined)).toEqual({ from: "", to: "" });
    const ranges: Array<Record<string, string>> = [{ from: "2025-01-01" }, { to: "2026-09-17" }, { from: "2026-09-17", to: "2026-09-17" }];
    for (const dates of ranges) {
      const params = new URLSearchParams({ view: "changes", ...dates });
      expect(parseAuditWindowQuery(params)).toMatchObject({ ...dates, pageSize: 100, loaded: 0 });
      expect(safeListHref(`/audit-log?${params}`)).not.toBeNull();
      expect(listPageHref(`/audit-log?${params}`, 2)).toContain("page=2");
    }
  });
  it("rejects inverted/duplicate ranges, dates on Events, and unsupported legacy contracts", () => {
    for (const query of ["view=changes&from=2026-09-18&to=2026-09-17", "view=changes&from=2025-01-01&from=2025-01-02", "view=events&from=2025-01-01"]) {
      const params = new URLSearchParams(query);
      expect(() => parseAuditNavigationQuery(params)).toThrow();
      expect(safeListHref(`/audit-log?${params}`)).toBeNull();
    }
    const params = new URLSearchParams("view=changes&from=2025-01-01");
    expect(() => parseAuditNavigationQuery(params, true)).toThrow();
    expect(() => parseAuditMetadataQuery(params)).toThrow();
    expect(parseAuditMetadataQuery(new URLSearchParams("view=changes&table=deal"))).toMatchObject({ table: "deal" });
  });
  it("has no automatic or explicit whole-history metadata request in the recent UI", () => {
    const source = readFileSync("components/audit/AuditFieldChangesDirectory.tsx", "utf8");
    expect(source).not.toMatch(/loadMetadata|\/metadata|fetch\(/);
    expect(source).toContain('totalState="not_requested"');
    expect(source).toContain("list.page.rows.map(row => row.table)");
    const filters = readFileSync("components/audit/RecentRowChangeFilters.tsx", "utf8");
    expect(filters).toContain("Suggestions come only from loaded rows");
    expect(filters).toContain("Both dates are inclusive in UTC");
  });
});
