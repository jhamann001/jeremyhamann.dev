import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mergeWithRegistry,
  STORAGE_KEY,
} from "./use-dashboard-layout";
import { DASHBOARD_TILES, getDefaultLayout, TileLayout } from "@/lib/dashboard-tiles";

const mockStorage: Record<string, string> = {};

beforeEach(() => {
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => mockStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      mockStorage[key] = value;
    },
    removeItem: (key: string) => {
      delete mockStorage[key];
    },
  });
});

describe("mergeWithRegistry", () => {
  it("returns defaults when saved is empty", () => {
    const result = mergeWithRegistry([]);
    expect(result.length).toBe(DASHBOARD_TILES.length);
    expect(result[0].id).toBe(DASHBOARD_TILES[0].id);
  });

  it("preserves saved order and visibility", () => {
    const saved: TileLayout[] = [
      { id: "action-items", visible: false, order: 0 },
      { id: "kpi-inflow", visible: true, order: 1 },
    ];
    const result = mergeWithRegistry(saved);
    expect(result[0].id).toBe("action-items");
    expect(result[0].visible).toBe(false);
    expect(result[1].id).toBe("kpi-inflow");
  });

  it("appends new tiles that are not in saved layout", () => {
    const partial: TileLayout[] = [
      { id: "kpi-inflow", visible: true, order: 0 },
    ];
    const result = mergeWithRegistry(partial);
    expect(result.length).toBe(DASHBOARD_TILES.length);
    expect(result[0].id).toBe("kpi-inflow");
    const addedIds = result.slice(1).map((t) => t.id);
    expect(addedIds).not.toContain("kpi-inflow");
  });

  it("drops tiles that no longer exist in registry", () => {
    const saved: TileLayout[] = [
      { id: "kpi-inflow", visible: true, order: 0 },
      { id: "deleted-tile", visible: true, order: 1 },
    ];
    const result = mergeWithRegistry(saved);
    expect(result.find((t) => t.id === "deleted-tile")).toBeUndefined();
  });

  it("new tiles get orders after existing max", () => {
    const saved: TileLayout[] = [
      { id: "kpi-inflow", visible: true, order: 50 },
    ];
    const result = mergeWithRegistry(saved);
    const addedTiles = result.filter((t) => t.id !== "kpi-inflow");
    for (const t of addedTiles) {
      expect(t.order).toBeGreaterThan(50);
    }
  });
});

describe("STORAGE_KEY", () => {
  it("is namespaced by version so stale layouts auto-reset", () => {
    expect(STORAGE_KEY).toBe("dashboard-layout-v4");
  });
});

describe("getDefaultLayout (order integrity)", () => {
  it("tiles are sorted by order ascending", () => {
    const layout = getDefaultLayout();
    for (let i = 1; i < layout.length; i++) {
      expect(layout[i].order).toBeGreaterThan(layout[i - 1].order);
    }
  });
});
