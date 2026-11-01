import { useState, useCallback } from "react";
import {
  DASHBOARD_TILES,
  TileLayout,
  getDefaultLayout,
} from "@/lib/dashboard-tiles";

// Bumping the version segment forces a one-time reset for users with stale
// layouts. Bump again whenever a new dashboard rebuild changes tile ids/sizes
// in a way that wouldn't migrate cleanly.
const STORAGE_KEY = "dashboard-layout-v4";
const LEGACY_STORAGE_KEYS = [
  "dashboard-layout",
  "dashboard-layout-v2",
  "dashboard-layout-v3",
];

function clearLegacyKeys() {
  if (typeof window === "undefined") return;
  for (const k of LEGACY_STORAGE_KEYS) {
    try {
      localStorage.removeItem(k);
    } catch {
      // ignore
    }
  }
}

function loadLayout(): TileLayout[] {
  if (typeof window === "undefined") return getDefaultLayout();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      clearLegacyKeys();
      return getDefaultLayout();
    }

    const saved: TileLayout[] = JSON.parse(raw);
    return mergeWithRegistry(saved);
  } catch {
    return getDefaultLayout();
  }
}

/**
 * Merge a saved layout with the current tile registry so that
 * newly-added tiles appear (at the end) and removed tiles are dropped.
 */
function mergeWithRegistry(saved: TileLayout[]): TileLayout[] {
  const knownIds = new Set(DASHBOARD_TILES.map((t) => t.id));
  const existing = saved.filter((s) => knownIds.has(s.id));
  const existingIds = new Set(existing.map((s) => s.id));

  const maxOrder =
    existing.length > 0 ? Math.max(...existing.map((s) => s.order)) : -1;

  const added = DASHBOARD_TILES.filter((t) => !existingIds.has(t.id)).map(
    (t, i) => ({
      id: t.id,
      visible: t.defaultVisible,
      order: maxOrder + 1 + i,
    })
  );

  return [...existing, ...added].sort((a, b) => a.order - b.order);
}

function persist(tiles: TileLayout[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tiles));
  } catch {
    // quota exceeded — silently ignore
  }
}

export function useDashboardLayout() {
  const [tiles, setTiles] = useState<TileLayout[]>(loadLayout);

  const reorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      setTiles((prev) => {
        const next = [...prev];
        const [moved] = next.splice(fromIndex, 1);
        next.splice(toIndex, 0, moved);
        const reordered = next.map((t, i) => ({ ...t, order: i }));
        persist(reordered);
        return reordered;
      });
    },
    []
  );

  const toggleVisibility = useCallback((id: string) => {
    setTiles((prev) => {
      const next = prev.map((t) =>
        t.id === id ? { ...t, visible: !t.visible } : t
      );
      persist(next);
      return next;
    });
  }, []);

  const setColSpan = useCallback((id: string, colSpan: number) => {
    const clamped = Math.max(1, Math.min(12, Math.round(colSpan)));
    setTiles((prev) => {
      const next = prev.map((t) =>
        t.id === id ? { ...t, colSpan: clamped } : t
      );
      persist(next);
      return next;
    });
  }, []);

  const setRange = useCallback((id: string, rangeDays: number) => {
    setTiles((prev) => {
      const next = prev.map((t) =>
        t.id === id ? { ...t, rangeDays } : t
      );
      persist(next);
      return next;
    });
  }, []);

  const resetToDefault = useCallback(() => {
    const defaults = getDefaultLayout();
    persist(defaults);
    setTiles(defaults);
  }, []);

  return {
    tiles,
    reorder,
    toggleVisibility,
    setColSpan,
    setRange,
    resetToDefault,
  };
}

export { mergeWithRegistry, loadLayout, persist, STORAGE_KEY };
