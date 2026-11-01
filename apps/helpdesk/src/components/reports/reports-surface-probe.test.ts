/**
 * Source guard for the `/reports` surface, in the shape `admin-surface-probe.test.ts` and
 * `ticket-list-probe.test.ts` established: the repo has no DOM test environment, so the properties
 * that a rendered page would show are asserted against the SOURCE.
 *
 * Every assertion below stands for a specific way this page could regress into a defect that a
 * typecheck cannot see:
 *
 *   - the foundation's RBAC gate is three statements, and a page that renders numbers before the
 *     denial row is written is the exact failure I5 exists to prevent;
 *   - a report is the app's most expensive read, so a router prefetch must not buy one;
 *   - the chart carries no <text>: it is drawn with `preserveAspectRatio="none"`, and a character in a
 *     stretched viewBox is a character nobody can read at 360 px;
 *   - the data table is the chart's accessible copy, so the chart needs `role="img"` and a real
 *     label, and the table has to exist at every width — as cards below `md` and as the one permitted
 *     element-level scroller above it;
 *   - components never reach a server module, and the page passes what they need as props.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), "utf8");

const PAGE = "src/app/(app)/reports/page.tsx";
const ROUTE = "src/app/api/reports/export/route.ts";
const FILES = {
  filters: "src/components/reports/report-filters.tsx",
  view: "src/components/reports/report-view.tsx",
  chart: "src/components/reports/report-chart.tsx",
  params: "src/components/reports/report-query-params.ts",
  meta: "src/components/reports/series-meta.ts",
  geometry: "src/components/reports/chart-geometry.ts",
  exportButton: "src/components/reports/report-export-button.tsx",
};

describe("/reports page", () => {
  const page = read(PAGE);

  it("keeps the foundation's gate verbatim, and writes the denial before it hides the page", () => {
    expect(page).toContain("const viewer = await requireUser();");
    expect(page).toContain("if (!canReadReports(viewer.groups)) {");
    expect(page).toContain('await recordDenied(actorFromViewer(viewer), ctx, "reports:read path:/reports");');
    expect(page).toContain("notFound();");
    expect(page.indexOf("recordDenied")).toBeLessThan(page.indexOf("notFound()"));
    // The gate runs before anything reads a number.
    expect(page.indexOf("canReadReports(viewer.groups)")).toBeLessThan(page.indexOf("await runExtendedReport"));
  });

  it("is force-dynamic and skips the aggregate on a router prefetch", () => {
    expect(page).toContain('export const dynamic = "force-dynamic";');
    expect(page).toContain("if (ctx.isPrefetch)");
    expect(page.indexOf("ctx.isPrefetch")).toBeLessThan(page.indexOf("await runExtendedReport"));
  });

  it("writes no audit row of its own: a report page is not a view (CONTRACT §3.3 rule 5)", () => {
    expect(page).not.toContain("recordView(");
    expect(page).not.toContain("recordMaterialRead(");
    expect(page).not.toContain("writeAudit(");
  });

  it("resolves the flags and labels server-side and passes them as props (G1)", () => {
    for (const prop of ["reports={", "queues={", "presets={", "granularities={", "activePreset={", "supportsGranularity={"]) {
      expect(page).toContain(prop);
    }
  });
});

describe("the export route", () => {
  const route = read(ROUTE);

  it("authenticates, records the denial, and answers no-store", () => {
    expect(route).toContain("requireViewerOrThrow(");
    expect(route).toContain("recordDenied(actor, ctx,");
    expect(route).toContain('"Cache-Control": "no-store"');
    expect(route).toContain('export const dynamic = "force-dynamic";');
    expect(route.indexOf("canReadReports(viewer.groups)")).toBeLessThan(route.indexOf("await reportCsvExtended"));
  });

  it("carries no scope parameter: a report has no record content to gate", () => {
    expect(route).not.toContain("canViewAudit");
    expect(route).not.toContain("scope=");
  });
});

describe("client boundaries", () => {
  it("only the two interactive components are client components", () => {
    expect(read(FILES.filters).startsWith('"use client";')).toBe(true);
    expect(read(FILES.view).startsWith('"use client";')).toBe(true);
    for (const rel of [FILES.chart, FILES.params, FILES.meta, FILES.geometry, FILES.exportButton]) {
      expect(read(rel)).not.toContain('"use client"');
    }
  });

  it("no component reaches a server module, @/lib/db, @/lib/env or @/auth (G1)", () => {
    for (const rel of Object.values(FILES)) {
      const src = read(rel);
      expect(src).not.toMatch(/from "@\/server\//);
      expect(src).not.toMatch(/from "@\/lib\/(db|env|audit|session|request-context)"/);
      expect(src).not.toMatch(/from "@\/auth"/);
    }
  });
});

describe("the chart", () => {
  const chart = read(FILES.chart);

  it("draws no text, because the viewBox is stretched", () => {
    expect(chart).toContain('preserveAspectRatio="none"');
    expect(chart).not.toContain("<text");
    expect(chart).not.toContain("<tspan");
  });

  it("keeps strokes true width under that stretch", () => {
    expect(chart).toContain('vectorEffect="non-scaling-stroke"');
  });

  it("is labelled for a screen reader and never mixes units on one axis", () => {
    expect(chart).toContain('role="img"');
    expect(chart).toContain("aria-label={summary}");
    expect(chart).toContain("chartableSeries");
    expect(chart).toContain("seriesUnit");
  });

  // The tokens themselves carry the dark palette (globals.css); their contrast is guarded by
  // src/app/theme-tokens.test.ts. This asserts only that the chart reaches for them and never a literal.
  it("colours from theme tokens rather than literals, and needs no `dark:` class of its own", () => {
    expect(chart).toMatch(/fill-primary|fill-chart-2|fill-destructive/);
    expect(chart).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // A `dark:` utility class, not the word in a comment.
    expect(chart).not.toMatch(/dark:[a-z]/);
  });
});

describe("the data table", () => {
  const view = read(FILES.view);

  it("is the chart's accessible copy, reachable at every width, with one md flip (R1, R7, R10)", () => {
    expect(view).toContain('aria-expanded={showData}');
    expect(view).toContain("aria-controls={`report-data-${result.key}`}");
    // Phone cards and the md+ table render from the SAME rows array.
    expect(view).toContain("md:hidden");
    expect(view).toContain("hidden w-full overflow-x-auto");
    expect(view).toContain("md:block");
    expect(view.match(/result\.rows\.map/g)?.length).toBe(2);
  });

  it("uses the one element-level horizontal scroller R2 allows, and never scrolls the page", () => {
    expect(view).toContain('data-slot="table-container"');
    expect(view).not.toContain("overflow-x-hidden");
  });

  it("prints every value as text rather than only as a shape (R10)", () => {
    expect(view).toContain("formatSeriesValue");
    expect(view).toContain("tabular-nums");
  });
});

describe("the filter bar", () => {
  const filters = read(FILES.filters);

  it("is a sheet on phones and an inline form at md+ (R1)", () => {
    expect(filters).toContain("FilterSheetTrigger");
    expect(filters).toContain("FilterSheet");
    expect(filters).toContain("ActiveFilterChips");
    expect(filters).toContain("md:hidden");
    expect(filters).toContain("hidden gap-3 rounded-lg border bg-card p-3 text-card-foreground md:grid");
  });

  it("marks the preset row as the element-level snap scroller the QA allowlist knows about", () => {
    expect(filters).toContain("data-snap-row");
    expect(filters).toContain("SNAP_ROW_CLASSES");
  });

  it("writes the URL through the shared serializer only (convention 12, G11)", () => {
    expect(filters).toContain("reportHref(pathname,");
    expect(filters).not.toContain("URLSearchParams(");
    expect(filters).not.toContain("[]=");
  });

  it("computes no dates of its own — the firm clock is the server's (hydration safety)", () => {
    expect(filters).not.toContain("new Date(");
    expect(filters).not.toContain("Date.now(");
  });
});
