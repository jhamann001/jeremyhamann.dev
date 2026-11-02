import { describe, expect, it } from "vitest";
import {
  MAX_SAVED_REPORT_VIEWS,
  normalizeSavedReportViewHref,
  normalizeSavedReportViewName,
  parseSavedReportViews,
} from "@/lib/crm/reporting-saved-views";

const view = (overrides: Record<string, unknown> = {}) => ({
  id: "view-1",
  name: "Stale client follow-up",
  href: "/reporting?dataset=client_engagement&interactionAge=older90",
  dataset: "client_engagement",
  createdAt: "2026-08-31T18:00:00.000Z",
  ...overrides,
});

describe("CRM reporting saved-view storage", () => {
  it("normalizes names and enforces the display-length boundary", () => {
    expect(normalizeSavedReportViewName("  My   operating   view  ")).toBe("My operating view");
    expect(normalizeSavedReportViewName("x".repeat(80))).toHaveLength(60);
  });

  it("accepts a well-formed reporting view", () => {
    expect(parseSavedReportViews(JSON.stringify([view()]))).toEqual([view()]);
  });

  it("accepts only same-origin relative Reporting links", () => {
    expect(normalizeSavedReportViewHref("/reporting?dataset=deal_pipeline")).toBe(
      "/reporting?dataset=deal_pipeline",
    );
    expect(normalizeSavedReportViewHref("https://attacker.example/reporting")).toBeNull();
    expect(normalizeSavedReportViewHref("/admin?dataset=deal_pipeline")).toBeNull();
    expect(parseSavedReportViews(JSON.stringify([
      view({ href: "https://attacker.example/reporting" }),
      view({ id: "view-2", href: "/admin" }),
    ]))).toEqual([]);
  });

  it("fails closed for malformed storage and skips malformed rows", () => {
    expect(parseSavedReportViews("not-json")).toEqual([]);
    expect(parseSavedReportViews(JSON.stringify({ view: view() }))).toEqual([]);
    expect(parseSavedReportViews(JSON.stringify([
      view({ dataset: "performance" }),
      view({ id: "", name: "No ID" }),
      view({ id: "view-2", createdAt: "not-a-date" }),
    ]))).toEqual([]);
  });

  it("deduplicates IDs and caps browser storage at the supported view limit", () => {
    const candidates = Array.from({ length: MAX_SAVED_REPORT_VIEWS + 5 }, (_, index) => view({
      id: `view-${index}`,
      name: `View ${index}`,
    }));
    candidates.splice(1, 0, view({ name: "Duplicate ID" }));
    const parsed = parseSavedReportViews(JSON.stringify(candidates));
    expect(parsed).toHaveLength(MAX_SAVED_REPORT_VIEWS);
    expect(new Set(parsed.map((item) => item.id)).size).toBe(MAX_SAVED_REPORT_VIEWS);
  });
});
