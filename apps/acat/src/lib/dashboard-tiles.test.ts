import { describe, it, expect } from "vitest";
import { DASHBOARD_TILES, getDefaultLayout, getTileMeta } from "./dashboard-tiles";

describe("DASHBOARD_TILES", () => {
  it("has at least 7 tiles", () => {
    expect(DASHBOARD_TILES.length).toBeGreaterThanOrEqual(7);
  });

  it("every tile has a unique id", () => {
    const ids = DASHBOARD_TILES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every tile has a non-empty label", () => {
    for (const t of DASHBOARD_TILES) {
      expect(t.label.length).toBeGreaterThan(0);
    }
  });

  it("defaultOrder values are sequential from 0", () => {
    const orders = DASHBOARD_TILES.map((t) => t.defaultOrder).sort(
      (a, b) => a - b
    );
    orders.forEach((o, i) => expect(o).toBe(i));
  });

  it("every tile has a defaultColSpan between 1 and 12", () => {
    for (const t of DASHBOARD_TILES) {
      expect(t.defaultColSpan).toBeGreaterThanOrEqual(1);
      expect(t.defaultColSpan).toBeLessThanOrEqual(12);
    }
  });

  it("includes the flow-based KPI tiles", () => {
    const kpiIds = [
      "kpi-inflow",
      "kpi-outflow",
      "kpi-throughput",
      "kpi-avg-days",
      "kpi-stalled",
    ];
    for (const id of kpiIds) {
      expect(DASHBOARD_TILES.find((t) => t.id === id)).toBeDefined();
    }
  });

  it("includes the analytical chart tiles", () => {
    expect(DASHBOARD_TILES.find((t) => t.id === "aum-cumulative")).toBeDefined();
    expect(DASHBOARD_TILES.find((t) => t.id === "direction-mix")).toBeDefined();
  });

  it("does not include deprecated tiles", () => {
    const deprecated = [
      "kpi-row",
      "transfer-breakdown",
      "recent-activity",
      "custodian-breakdown",
      "time-to-completion",
      "pipeline-composition",
    ];
    for (const id of deprecated) {
      expect(DASHBOARD_TILES.find((t) => t.id === id)).toBeUndefined();
    }
  });
});

describe("getDefaultLayout", () => {
  it("returns one entry per tile", () => {
    const layout = getDefaultLayout();
    expect(layout.length).toBe(DASHBOARD_TILES.length);
  });

  it("preserves default visibility", () => {
    const layout = getDefaultLayout();
    for (const entry of layout) {
      const tile = DASHBOARD_TILES.find((t) => t.id === entry.id);
      expect(tile).toBeDefined();
      expect(entry.visible).toBe(tile!.defaultVisible);
    }
  });

  it("preserves default order", () => {
    const layout = getDefaultLayout();
    for (const entry of layout) {
      const tile = DASHBOARD_TILES.find((t) => t.id === entry.id);
      expect(entry.order).toBe(tile!.defaultOrder);
    }
  });
});

describe("getTileMeta", () => {
  it("returns metadata for a known tile id", () => {
    const meta = getTileMeta("kpi-inflow");
    expect(meta).toBeDefined();
    expect(meta?.label).toBe("Inflow / 30d");
    expect(meta?.defaultColSpan).toBe(3);
  });

  it("returns undefined for an unknown id", () => {
    expect(getTileMeta("does-not-exist")).toBeUndefined();
  });
});
