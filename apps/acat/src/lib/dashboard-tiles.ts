export interface DashboardTile {
  id: string;
  label: string;
  defaultVisible: boolean;
  defaultOrder: number;
  /**
   * Default column span out of a 12-column grid. The Dashboard layout engine
   * packs tiles row-by-row, breaking to a new row when adding the next tile
   * would overflow 12.
   */
  defaultColSpan: number;
}

export const DASHBOARD_TILES: DashboardTile[] = [
  { id: "kpi-inflow", label: "Inflow / 30d", defaultVisible: true, defaultOrder: 0, defaultColSpan: 3 },
  { id: "kpi-outflow", label: "Outflow / 30d", defaultVisible: true, defaultOrder: 1, defaultColSpan: 3 },
  { id: "kpi-throughput", label: "Completed / 30d", defaultVisible: true, defaultOrder: 2, defaultColSpan: 3 },
  { id: "kpi-avg-days", label: "Avg Days to Complete", defaultVisible: true, defaultOrder: 3, defaultColSpan: 3 },
  { id: "kpi-stalled", label: "Stalled > 5 days", defaultVisible: true, defaultOrder: 4, defaultColSpan: 3 },
  { id: "aum-cumulative", label: "AUM Completed (Cumulative)", defaultVisible: true, defaultOrder: 5, defaultColSpan: 6 },
  { id: "recon-health", label: "Reconciliation Health", defaultVisible: true, defaultOrder: 6, defaultColSpan: 3 },
  { id: "direction-mix", label: "Direction Mix", defaultVisible: true, defaultOrder: 7, defaultColSpan: 3 },
  { id: "status-distribution", label: "Pipeline Status", defaultVisible: true, defaultOrder: 8, defaultColSpan: 12 },
  { id: "action-items", label: "Requires Attention", defaultVisible: true, defaultOrder: 9, defaultColSpan: 12 },
];

export function getDefaultLayout(): TileLayout[] {
  return DASHBOARD_TILES.map((t) => ({
    id: t.id,
    visible: t.defaultVisible,
    order: t.defaultOrder,
  }));
}

export interface TileLayout {
  id: string;
  visible: boolean;
  order: number;
  /** User-overridden col-span. When undefined, the tile's defaultColSpan is used. */
  colSpan?: number;
  /** User-overridden time range, in days. Tile components decide what to do
   * with this — most KPI/chart tiles use it as the metric window. */
  rangeDays?: number;
}

export function getTileMeta(id: string): DashboardTile | undefined {
  return DASHBOARD_TILES.find((t) => t.id === id);
}
