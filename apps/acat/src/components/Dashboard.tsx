"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowDownRight,
  ArrowRight,
  ArrowUp,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  DollarSign,
  GripVertical,
  Eye,
  EyeOff,
  Layers,
  Maximize2,
  Minimize2,
  Package,
  Plus,
  RotateCcw,
  Settings2,
  Timer,
  TrendingUp,
  X,
  Zap,
  BarChart3,
} from "lucide-react";
import {
  AcatRecord,
  AcatStatus,
  ACAT_STATUS_LABELS,
  ACAT_STATUSES,
  TERMINAL_STATUSES,
} from "@/lib/types";
import {
  formatCentsAsDollar,
  formatCentsExact,
  formatDateMMDDYYYY,
} from "@/lib/format";
import {
  getAssetCounts,
  getIssueCount,
  getDaysOpen,
  getAgingTier,
  getExpectedProcessingDays,
  isAging,
} from "@/lib/acat-derivations";
import { DASHBOARD_TILES, getTileMeta } from "@/lib/dashboard-tiles";
import {
  inflowMetric,
  outflowMetric,
  throughputMetric,
  avgDaysByWeek,
  avgDaysExResiduals,
  avgDaysAllIn,
  stalledSnapshot,
  stalledTrendApprox,
  cumulativeCompletedAum,
  directionMix,
  isResidual,
} from "@/lib/dashboard-analytics";
import { TileLayout } from "@/lib/dashboard-tiles";
import { useDashboardLayout } from "@/hooks/use-dashboard-layout";
import StatusBadge from "./StatusBadge";

const PAGE_LOAD_TIME = typeof window !== "undefined" ? Date.now() : 0;
const ACTION_ITEMS_ANCHOR = "dashboard-action-items";

interface DashboardProps {
  acats: AcatRecord[];
  onSelectRecord: (id: string) => void;
}

type Analytics = ReturnType<typeof useAnalytics>;

// Pipeline buckets — collapse the 14 statuses into the 4 stages an ops user
// actually thinks in. Detail is preserved in a disclosure on the tile.
const STATUS_BUCKETS: {
  id: "in-flight" | "at-contra" | "at-apex" | "terminal";
  label: string;
  sublabel: string;
  color: string;
  statuses: AcatStatus[];
}[] = [
  {
    id: "in-flight",
    label: "In Flight",
    sublabel: "Pre-submit · awaiting client",
    color: "var(--status-blue-dot)",
    statuses: [
      "WaitingForApex",
      "PendingAccountOpening",
      "WaitingOnClient",
      "WaitingForStatement",
      "AcatReceived",
      "ToCome",
    ],
  },
  {
    id: "at-contra",
    label: "At Contra",
    sublabel: "Pending contra response",
    color: "var(--status-violet-dot)",
    statuses: ["Submitted", "PendingReview", "PendingContraResponse"],
  },
  {
    id: "at-apex",
    label: "At Apex",
    sublabel: "Pending settlement / bookkeeping",
    color: "var(--status-amber-dot)",
    statuses: [
      "Accepted",
      "PendingSettlement",
      "PendingBookkeeping",
      "Matched",
      "Mismatch",
      "Pending",
    ],
  },
  {
    id: "terminal",
    label: "Terminal",
    sublabel: "Completed, rejected, canceled",
    color: "var(--status-green-dot)",
    statuses: ["Completed", "Rejected", "Purged", "Canceled", "Deferred"],
  },
];

function useAnalytics(acats: AcatRecord[]) {
  return useMemo(() => {
    const now = PAGE_LOAD_TIME;
    const total = acats.length;

    const statusCounts: Record<string, number> = {};
    for (const s of ACAT_STATUSES) statusCounts[s] = 0;
    for (const a of acats) statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;

    const completed = statusCounts.Completed ?? 0;
    const terminalCount = acats.filter((a) => TERMINAL_STATUSES.has(a.status)).length;
    const activeCount = total - terminalCount;

    // Range-bound metrics (inflow, throughput, avg-days trend, stalled trend,
    // AUM cumulative, composition) are computed inside each tile so users can
    // change the range per-tile without re-running everything.

    // Match rate (identical to the prior implementation — kept intact)
    const assetBuckets = acats.reduce(
      (acc, a) => {
        const counts = getAssetCounts(a);
        acc.matched += counts.matched;
        acc.pending += counts.pending;
        acc.mismatch += counts.mismatch;
        return acc;
      },
      { matched: 0, pending: 0, mismatch: 0 }
    );
    const reconDenominator = assetBuckets.matched + assetBuckets.mismatch;
    const reconRate =
      reconDenominator > 0
        ? Math.round((assetBuckets.matched / reconDenominator) * 100)
        : null;

    const direction = directionMix(acats);

    // ticket: "Requires Attention" is now whatever has overshot its
    // per-custodian SLA (warn or high tier) — no more flat 3-day threshold.
    // Records with active issues are included regardless of aging so a
    // mismatched record never falls off the radar just because it's fresh.
    const actionItems = acats.filter(
      (a) =>
        !TERMINAL_STATUSES.has(a.status) &&
        (isAging(a, now) || getIssueCount(a) > 0)
    );

    const recentActivity = [...acats]
      .sort(
        (a, b) =>
          new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
      )
      .slice(0, 8);

    const bucketCounts = STATUS_BUCKETS.map((b) => {
      const count = b.statuses.reduce(
        (sum, s) => sum + (statusCounts[s] ?? 0),
        0
      );
      return { ...b, count };
    });

    const statusColorMap: Record<string, string> = {
      WaitingForApex: "bg-[color:var(--status-slate-dot)]",
      PendingAccountOpening: "bg-[color:var(--status-blue-dot)]",
      WaitingOnClient: "bg-[color:var(--status-amber-dot)]",
      WaitingForStatement: "bg-[color:var(--status-amber-dot)]",
      AcatReceived: "bg-[color:var(--status-sky-dot)]",
      ToCome: "bg-[color:var(--status-indigo-dot)]",
      Submitted: "bg-[color:var(--status-violet-dot)]",
      PendingReview: "bg-[color:var(--status-cyan-dot)]",
      PendingContraResponse: "bg-[color:var(--status-teal-dot)]",
      Accepted: "bg-[color:var(--status-emerald-dot)]",
      PendingSettlement: "bg-[color:var(--status-lime-dot)]",
      PendingBookkeeping: "bg-[color:var(--status-purple-dot)]",
      Matched: "bg-[color:var(--status-green-dot)]",
      Mismatch: "bg-[color:var(--status-red-dot)]",
      Pending: "bg-[color:var(--status-amber-dot)]",
      Completed: "bg-[color:var(--status-green-dot)]",
      Rejected: "bg-[color:var(--status-red-dot)]",
      Purged: "bg-[color:var(--status-gray-dot)]",
      Canceled: "bg-[color:var(--status-orange-dot)]",
      Deferred: "bg-[color:var(--status-yellow-dot)]",
    };
    const statusDetail = ACAT_STATUSES
      .filter((s) => (statusCounts[s] ?? 0) > 0)
      .map((s) => ({
        status: s,
        label: ACAT_STATUS_LABELS[s],
        count: statusCounts[s] ?? 0,
        color: statusColorMap[s] ?? "bg-[color:var(--status-gray-dot)]",
      }));

    return {
      now,
      total,
      completed,
      activeCount,
      terminalCount,
      reconRate,
      matchedCount: assetBuckets.matched,
      pendingCount: assetBuckets.pending,
      mismatchCount: assetBuckets.mismatch,
      direction,
      actionItems,
      bucketCounts,
      statusDetail,
      recentActivity,
    };
  }, [acats]);
}

// ---------------------------------------------------------------------------
// Tile renderer registry
// ---------------------------------------------------------------------------

interface RenderTileProps {
  tile: TileLayout;
  acats: AcatRecord[];
  analytics: Analytics;
  onSelectRecord: (id: string) => void;
  onJumpToActionItems: () => void;
  onSetRange: (id: string, days: number) => void;
}

function renderTile({
  tile,
  acats,
  analytics,
  onSelectRecord,
  onJumpToActionItems,
  onSetRange,
}: RenderTileProps): React.ReactNode | null {
  const range = tile.rangeDays;
  const setRange = (days: number) => onSetRange(tile.id, days);

  switch (tile.id) {
    case "kpi-inflow":
      return (
        <KpiInflowTile
          acats={acats}
          now={analytics.now}
          range={range ?? 30}
          onRangeChange={setRange}
        />
      );
    case "kpi-outflow":
      return (
        <KpiOutflowTile
          acats={acats}
          now={analytics.now}
          range={range ?? 30}
          onRangeChange={setRange}
        />
      );
    case "kpi-throughput":
      return (
        <KpiThroughputTile
          acats={acats}
          now={analytics.now}
          range={range ?? 30}
          onRangeChange={setRange}
        />
      );
    case "kpi-avg-days":
      return (
        <KpiAvgDaysTile
          acats={acats}
          now={analytics.now}
          range={range ?? 84}
          onRangeChange={setRange}
        />
      );
    case "kpi-stalled":
      return (
        <KpiStalledTile
          acats={acats}
          now={analytics.now}
          range={range ?? 30}
          onRangeChange={setRange}
          onJump={onJumpToActionItems}
        />
      );
    case "aum-cumulative":
      return (
        <AumCumulativeTile
          acats={acats}
          now={analytics.now}
          range={range ?? 90}
          onRangeChange={setRange}
        />
      );
    case "recon-health":
      return <ReconHealthTile analytics={analytics} />;
    case "direction-mix":
      return <DirectionMixTile analytics={analytics} />;
    case "status-distribution":
      return <StatusDistributionTile analytics={analytics} />;
    case "action-items":
      return (
        <ActionItemsTile
          analytics={analytics}
          onSelectRecord={onSelectRecord}
        />
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Layout engine — pack tiles into rows by their colSpan in a 12-col grid
// ---------------------------------------------------------------------------

interface VisibleTile {
  id: string;
  visible: boolean;
  span: number;
  rangeDays?: number;
}

function packIntoRows(tiles: VisibleTile[]): VisibleTile[][] {
  const rows: VisibleTile[][] = [];
  let currentRow: VisibleTile[] = [];
  let currentSpan = 0;
  for (const tile of tiles) {
    const span = Math.max(1, Math.min(12, tile.span));
    if (currentSpan + span > 12 && currentRow.length > 0) {
      rows.push(currentRow);
      currentRow = [];
      currentSpan = 0;
    }
    currentRow.push({ ...tile, span });
    currentSpan += span;
  }
  if (currentRow.length > 0) rows.push(currentRow);
  return rows;
}

const COL_SPAN_CLASS: Record<number, string> = {
  1: "col-span-1",
  2: "col-span-2",
  3: "col-span-3",
  4: "col-span-4",
  5: "col-span-5",
  6: "col-span-6",
  7: "col-span-7",
  8: "col-span-8",
  9: "col-span-9",
  10: "col-span-10",
  11: "col-span-11",
  12: "col-span-12",
};

// ---------------------------------------------------------------------------
// Sortable tile wrapper (used in edit mode)
// ---------------------------------------------------------------------------

// Size presets a tile cycles through. The order matters — clicking the
// shrink/grow buttons walks this list in either direction.
const COL_SPAN_PRESETS = [3, 4, 6, 8, 9, 12] as const;

function nextColSpan(current: number, dir: 1 | -1): number {
  // Snap to the nearest preset, then advance.
  const presetsArray: number[] = [...COL_SPAN_PRESETS];
  let idx = presetsArray.indexOf(current);
  if (idx === -1) {
    // Custom value — round to closest preset
    idx = presetsArray.reduce(
      (best, v, i) =>
        Math.abs(v - current) < Math.abs(presetsArray[best] - current) ? i : best,
      0
    );
  }
  const target = Math.max(0, Math.min(presetsArray.length - 1, idx + dir));
  return presetsArray[target];
}

function SortableTile({
  id,
  editing,
  visible,
  label,
  span,
  onToggle,
  onResize,
  children,
}: {
  id: string;
  editing: boolean;
  visible: boolean;
  label: string;
  span: number;
  onToggle: () => void;
  onResize: (newSpan: number) => void;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !editing });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  if (!editing) return <>{children}</>;

  const presetsArray: number[] = [...COL_SPAN_PRESETS];
  const canShrink = span > presetsArray[0];
  const canGrow = span < presetsArray[presetsArray.length - 1];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group relative h-full rounded-xl ${
        visible
          ? "border-2 border-dashed border-accent/30"
          : "border-2 border-dashed border-card-border opacity-40"
      }`}
    >
      <div className="absolute -top-3 left-3 z-10 flex items-center gap-1.5 rounded-md border border-card-border bg-[var(--bg-card)] px-2 py-0.5 shadow-sm">
        <button
          className="cursor-grab touch-none text-muted hover:text-foreground"
          {...attributes}
          {...listeners}
          title="Drag to reorder"
        >
          <GripVertical size={14} />
        </button>
        <span className="text-[11px] font-medium text-muted">{label}</span>
        <button
          onClick={onToggle}
          className="ml-1 text-muted hover:text-foreground"
          title={visible ? "Hide tile" : "Show tile"}
        >
          {visible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      </div>

      <div className="absolute -top-3 right-3 z-10 flex items-center gap-1 rounded-md border border-card-border bg-[var(--bg-card)] px-1.5 py-0.5 shadow-sm">
        <button
          onClick={() => onResize(nextColSpan(span, -1))}
          className={`text-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Shrink tile"
          disabled={!canShrink}
        >
          <Minimize2 size={12} />
        </button>
        <span className="px-1 text-[10px] font-mono font-semibold text-muted">
          {span}/12
        </span>
        <button
          onClick={() => onResize(nextColSpan(span, 1))}
          className={`text-muted hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed`}
          title="Grow tile"
          disabled={!canGrow}
        >
          <Maximize2 size={12} />
        </button>
      </div>

      <div className={`h-full ${visible ? "" : "pointer-events-none select-none blur-[2px]"}`}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Dashboard component
// ---------------------------------------------------------------------------

export default function Dashboard({ acats, onSelectRecord }: DashboardProps) {
  const analytics = useAnalytics(acats);
  const {
    tiles,
    reorder,
    toggleVisibility,
    setColSpan,
    setRange,
    resetToDefault,
  } = useDashboardLayout();
  const [editing, setEditing] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIdx = tiles.findIndex((t) => t.id === active.id);
      const newIdx = tiles.findIndex((t) => t.id === over.id);
      if (oldIdx !== -1 && newIdx !== -1) {
        reorder(oldIdx, newIdx);
      }
    }
  }

  function jumpToActionItems() {
    const el = document.getElementById(ACTION_ITEMS_ANCHOR);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const visibleTiles: VisibleTile[] = (editing ? tiles : tiles.filter((t) => t.visible)).map(
    (t) => ({
      id: t.id,
      visible: t.visible,
      // User-set colSpan overrides the registry default
      span: t.colSpan ?? getTileMeta(t.id)?.defaultColSpan ?? 12,
      rangeDays: t.rangeDays,
    })
  );

  const rows = packIntoRows(visibleTiles);

  const hiddenCount = tiles.filter((t) => !t.visible).length;

  return (
    <div className="relative flex h-full flex-col overflow-hidden animate-fade-in">
      <div className="shrink-0 border-b border-card-border bg-[var(--bg-card)] px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-foreground">
              Dashboard
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              Transfer pipeline overview &middot; {formatDateMMDDYYYY(new Date())}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {editing && (
              <button
                onClick={resetToDefault}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
                title="Reset to default layout"
              >
                <RotateCcw size={13} />
                Reset
              </button>
            )}
            <div
              role="tablist"
              aria-label="Dashboard mode"
              className="flex items-center gap-1 rounded-lg border border-card-border bg-[var(--bg-card)] p-1"
            >
              <button
                role="tab"
                aria-selected={!editing}
                onClick={() => setEditing(false)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  !editing
                    ? "bg-[var(--invert-bg)] text-[var(--invert-text)]"
                    : "text-muted hover:bg-[var(--bg-hover)] hover:text-foreground"
                }`}
              >
                <Eye size={12} />
                View
              </button>
              <button
                role="tab"
                aria-selected={editing}
                onClick={() => setEditing(true)}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  editing
                    ? "bg-[var(--invert-bg)] text-[var(--invert-text)]"
                    : "text-muted hover:bg-[var(--bg-hover)] hover:text-foreground"
                }`}
              >
                <Settings2 size={12} />
                Edit
              </button>
            </div>
          </div>
        </div>
        {editing && hiddenCount > 0 && (
          <p className="mt-2 text-xs text-muted">
            {hiddenCount} hidden tile{hiddenCount !== 1 ? "s" : ""} &mdash; toggle the eye icon to show them
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto bg-surface px-8 py-6">
        {editing && (
          <TileLibrary
            tiles={tiles}
            onAdd={(id) => toggleVisibility(id)}
            onResetSize={(id) => setColSpan(id, getTileMeta(id)?.defaultColSpan ?? 12)}
          />
        )}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={visibleTiles.map((t) => t.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-5">
              {rows.map((row, rowIdx) => (
                <div key={`row-${rowIdx}`} className="grid grid-cols-12 gap-4">
                  {row.map((tile) => {
                    const meta = DASHBOARD_TILES.find((t) => t.id === tile.id);
                    const node = renderTile({
                      tile: {
                        id: tile.id,
                        visible: tile.visible,
                        order: 0, // not consumed by tile components
                        colSpan: tile.span,
                        rangeDays: tile.rangeDays,
                      },
                      acats,
                      analytics,
                      onSelectRecord,
                      onJumpToActionItems: jumpToActionItems,
                      onSetRange: setRange,
                    });
                    return (
                      <div
                        key={tile.id}
                        className={COL_SPAN_CLASS[tile.span] ?? "col-span-12"}
                      >
                        {editing ? (
                          <SortableTile
                            id={tile.id}
                            editing={editing}
                            visible={tile.visible}
                            label={meta?.label ?? tile.id}
                            span={tile.span}
                            onToggle={() => toggleVisibility(tile.id)}
                            onResize={(newSpan) => setColSpan(tile.id, newSpan)}
                          >
                            {node}
                          </SortableTile>
                        ) : (
                          node
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      <RecentActivityFab
        count={analytics.recentActivity.length}
        open={activityOpen}
        onToggle={() => setActivityOpen((v) => !v)}
      />
      <RecentActivityPanel
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        items={analytics.recentActivity}
        onSelectRecord={(id) => {
          setActivityOpen(false);
          onSelectRecord(id);
        }}
      />
    </div>
  );
}

// ===========================================================================
// Chart primitives — small inline SVGs sized to their container
// ===========================================================================

interface SparklineProps {
  values: number[];
  stroke: string;
  fill?: string;
  /** Pin the y-axis floor at zero so a flat-low series doesn't visually claim
   *  the whole panel. */
  zeroBaseline?: boolean;
  targetValue?: number;
  targetStroke?: string;
}

function Sparkline({
  values,
  stroke,
  fill,
  zeroBaseline = true,
  targetValue,
  targetStroke,
}: SparklineProps) {
  const w = 200;
  const h = 30;
  if (values.length === 0) {
    return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full" />;
  }
  const min = zeroBaseline ? 0 : Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = values.length > 1 ? w / (values.length - 1) : w;

  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return [x, y] as const;
  });

  const linePath = points
    .map(([x, y], i) => (i === 0 ? `M${x.toFixed(2)},${y.toFixed(2)}` : `L${x.toFixed(2)},${y.toFixed(2)}`))
    .join(" ");
  const areaPath = `${linePath} L${w.toFixed(2)},${h} L0,${h} Z`;
  const last = points[points.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full">
      {targetValue !== undefined && targetStroke && (
        <line
          x1={0}
          x2={w}
          y1={h - ((targetValue - min) / range) * (h - 2) - 1}
          y2={h - ((targetValue - min) / range) * (h - 2) - 1}
          stroke={targetStroke}
          strokeWidth={1}
          strokeDasharray="3,2"
          opacity={0.5}
        />
      )}
      {fill && <path d={areaPath} fill={fill} opacity={0.18} />}
      <path d={linePath} fill="none" stroke={stroke} strokeWidth={1.5} />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill={stroke} stroke="var(--bg-card)" strokeWidth={1.5} />
    </svg>
  );
}

interface AreaChartProps {
  values: number[];
  stroke: string;
  fillFrom: string;
  height?: number;
}

function AreaChart({ values, stroke, fillFrom, height = 130 }: AreaChartProps) {
  const w = 400;
  const h = height;
  if (values.length === 0) {
    return <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full" />;
  }
  const min = 0;
  const max = Math.max(...values, 1);
  const range = max - min || 1;
  const stepX = values.length > 1 ? w / (values.length - 1) : w;

  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = h - ((v - min) / range) * (h - 8) - 4;
    return [x, y] as const;
  });

  const linePath = points
    .map(([x, y], i) => (i === 0 ? `M${x.toFixed(2)},${y.toFixed(2)}` : `L${x.toFixed(2)},${y.toFixed(2)}`))
    .join(" ");
  const areaPath = `${linePath} L${w.toFixed(2)},${h} L0,${h} Z`;

  const gradientId = `area-grad-${fillFrom.replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-full w-full">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fillFrom} stopOpacity="0.45" />
          <stop offset="100%" stopColor={fillFrom} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g stroke="var(--card-border)" strokeWidth={0.5} opacity={0.4}>
        <line x1={0} y1={h * 0.25} x2={w} y2={h * 0.25} />
        <line x1={0} y1={h * 0.5} x2={w} y2={h * 0.5} />
        <line x1={0} y1={h * 0.75} x2={w} y2={h * 0.75} />
      </g>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path d={linePath} fill="none" stroke={stroke} strokeWidth={2} />
    </svg>
  );
}

interface DonutSegment {
  value: number;
  color: string;
  label: string;
}

function Donut({ segments, centerLabel, centerCaption }: {
  segments: DonutSegment[];
  centerLabel: string;
  centerCaption: string;
}) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((s, x) => s + x.value, 0);
  let offset = 0;

  return (
    <div className="relative flex h-24 w-24 shrink-0 items-center justify-center">
      <svg className="h-24 w-24 -rotate-90" viewBox="0 0 100 100">
        <circle cx={50} cy={50} r={r} fill="none" stroke="var(--fill-3)" strokeWidth={10} />
        {total > 0 &&
          segments.map((seg, i) => {
            const len = (seg.value / total) * c;
            const dasharray = `${len} ${c - len}`;
            const dashoffset = -offset;
            offset += len;
            return (
              <circle
                key={i}
                cx={50}
                cy={50}
                r={r}
                fill="none"
                stroke={seg.color}
                strokeWidth={10}
                strokeLinecap="butt"
                strokeDasharray={dasharray}
                strokeDashoffset={dashoffset}
                className="transition-all duration-700"
              />
            );
          })}
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-xl font-bold leading-none text-foreground">
          {centerLabel}
        </span>
        <span className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted">
          {centerCaption}
        </span>
      </div>
    </div>
  );
}

// ===========================================================================
// KPI tile primitive — stat + sparkline
// ===========================================================================

type KpiTone = "info" | "success" | "warning" | "danger" | "violet";

const TONE_BG: Record<KpiTone, string> = {
  info: "bg-[color:var(--status-blue-bg)] text-[color:var(--status-blue-dot)]",
  success: "bg-[color:var(--status-emerald-bg)] text-[color:var(--status-emerald-dot)]",
  danger: "bg-[color:var(--status-red-bg)] text-[color:var(--status-red-dot)]",
  warning: "bg-[color:var(--status-amber-bg)] text-[color:var(--status-amber-dot)]",
  violet: "bg-[color:var(--status-violet-bg)] text-[color:var(--status-violet-dot)]",
};

const TONE_VALUE: Record<KpiTone, string> = {
  info: "text-foreground",
  success: "text-[color:var(--status-emerald-fg)]",
  danger: "text-[color:var(--status-red-fg)]",
  warning: "text-[color:var(--status-amber-fg)]",
  violet: "text-foreground",
};

// Range selector — compact chip group rendered in a tile header
interface RangeOption {
  label: string;
  value: number;
}

const FLOW_RANGE_OPTIONS: RangeOption[] = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
];

const AVG_DAYS_RANGE_OPTIONS: RangeOption[] = [
  { label: "4w", value: 28 },
  { label: "12w", value: 84 },
  { label: "26w", value: 182 },
  { label: "52w", value: 364 },
];

const AUM_RANGE_OPTIONS: RangeOption[] = [
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "180d", value: 180 },
  { label: "1y", value: 365 },
];

function RangeSelector({
  options,
  value,
  onChange,
}: {
  options: RangeOption[];
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-md bg-[var(--bg-hover)] p-0.5">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={(e) => {
              e.stopPropagation();
              onChange(opt.value);
            }}
            className={`px-1.5 py-0.5 text-[10px] font-semibold rounded transition ${
              active
                ? "bg-[var(--bg-card)] text-foreground shadow-sm"
                : "text-muted hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  trend,
  sub,
  tone,
  sparkline,
  rangeSelector,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  trend?: { delta: string; direction: "good" | "bad" | "flat" };
  sub: React.ReactNode;
  tone: KpiTone;
  sparkline?: React.ReactNode;
  rangeSelector?: React.ReactNode;
  onClick?: () => void;
}) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      onClick={onClick}
      className={`flex h-full w-full flex-col rounded-xl border border-card-border bg-[var(--bg-card)] p-4 text-left transition ${
        onClick ? "cursor-pointer hover:-translate-y-px hover:border-[var(--fill-4)]" : ""
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${TONE_BG[tone]}`}>
            {icon}
          </div>
          <span className="truncate text-xs font-medium text-muted">{label}</span>
        </div>
        {rangeSelector && <div className="shrink-0">{rangeSelector}</div>}
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`text-2xl font-bold ${TONE_VALUE[tone]}`}>{value}</span>
        {trend && <TrendChip {...trend} />}
      </div>
      <p className="mt-1 text-[11px] text-muted">{sub}</p>
      {sparkline && <div className="mt-auto h-8 pt-2">{sparkline}</div>}
    </Wrapper>
  );
}

function TrendChip({ delta, direction }: { delta: string; direction: "good" | "bad" | "flat" }) {
  const cls =
    direction === "good"
      ? "bg-[color:var(--status-emerald-bg)] text-[color:var(--status-emerald-dot)]"
      : direction === "bad"
        ? "bg-[color:var(--status-red-bg)] text-[color:var(--status-red-dot)]"
        : "bg-[var(--bg-hover)] text-muted";
  // Arrow follows the actual sign of the change. Color (good/bad) is
  // independent — e.g. inflow ↓ is bad/red but the arrow still points down.
  const arrow =
    direction === "flat"
      ? <ArrowRight size={9} />
      : delta.startsWith("-")
        ? <ArrowDown size={9} />
        : <ArrowUp size={9} />;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>
      {arrow}
      {delta}
    </span>
  );
}

// ===========================================================================
// KPI tiles — flow-based with unambiguous direction
// ===========================================================================

interface RangedTileProps {
  acats: AcatRecord[];
  now: number;
  range: number;
  onRangeChange: (days: number) => void;
}

function rangeLabel(days: number): string {
  if (days % 7 === 0 && days >= 28) return `${days / 7}w`;
  if (days >= 365) return `${Math.round(days / 365)}y`;
  return `${days}d`;
}

function KpiInflowTile({ acats, now, range, onRangeChange }: RangedTileProps) {
  const inflow = useMemo(() => inflowMetric(acats, now, range), [acats, now, range]);
  const series = inflow.series.map((s) => s.count);
  const trend = formatTrend(inflow.countDeltaPct, "good");

  return (
    <StatTile
      icon={<ArrowUpRight size={14} />}
      label={`Inflow / ${rangeLabel(range)}`}
      value={String(inflow.count)}
      trend={trend}
      tone="violet"
      rangeSelector={
        <RangeSelector
          options={FLOW_RANGE_OPTIONS}
          value={range}
          onChange={onRangeChange}
        />
      }
      sub={
        <>
          <strong className="text-foreground">{formatCentsAsDollar(inflow.value)}</strong> in
          {inflow.valueDeltaPct !== null && (
            <> · vs prior {formatCentsAsDollar(inflow.valuePrior)}</>
          )}
        </>
      }
      sparkline={
        <Sparkline values={series} stroke="var(--status-violet-dot)" fill="var(--status-violet-dot)" />
      }
    />
  );
}

function KpiOutflowTile({ acats, now, range, onRangeChange }: RangedTileProps) {
  const outflow = useMemo(() => outflowMetric(acats, now, range), [acats, now, range]);
  const series = outflow.series.map((s) => s.count);
  // More money leaving is the unfavorable direction, so an increase reads "bad".
  const trend = formatTrend(outflow.countDeltaPct, "bad");

  return (
    <StatTile
      icon={<ArrowDownRight size={14} />}
      label={`Outflow / ${rangeLabel(range)}`}
      value={String(outflow.count)}
      trend={trend}
      tone="danger"
      rangeSelector={
        <RangeSelector
          options={FLOW_RANGE_OPTIONS}
          value={range}
          onChange={onRangeChange}
        />
      }
      sub={
        <>
          <strong className="text-foreground">{formatCentsAsDollar(outflow.value)}</strong> out
          {outflow.valueDeltaPct !== null && (
            <> · vs prior {formatCentsAsDollar(outflow.valuePrior)}</>
          )}
        </>
      }
      sparkline={
        <Sparkline values={series} stroke="var(--status-red-dot)" fill="var(--status-red-dot)" />
      }
    />
  );
}

function KpiThroughputTile({ acats, now, range, onRangeChange }: RangedTileProps) {
  const throughput = useMemo(
    () => throughputMetric(acats, now, range),
    [acats, now, range]
  );
  const series = throughput.series.map((s) => s.count);
  const trend = formatTrend(throughput.countDeltaPct, "good");

  return (
    <StatTile
      icon={<CheckCircle2 size={14} />}
      label={`Completed / ${rangeLabel(range)}`}
      value={String(throughput.count)}
      trend={trend}
      tone="success"
      rangeSelector={
        <RangeSelector
          options={FLOW_RANGE_OPTIONS}
          value={range}
          onChange={onRangeChange}
        />
      }
      sub={
        <>
          <strong className="text-foreground">{formatCentsAsDollar(throughput.value)}</strong> net landed
          {throughput.valueDeltaPct !== null && (
            <> · vs prior {formatCentsAsDollar(throughput.valuePrior)}</>
          )}
        </>
      }
      sparkline={
        <Sparkline values={series} stroke="var(--status-emerald-dot)" fill="var(--status-emerald-dot)" />
      }
    />
  );
}

function KpiAvgDaysTile({ acats, now, range, onRangeChange }: RangedTileProps) {
  const weeks = Math.max(1, Math.round(range / 7));
  const avgDaysWeekly = useMemo(
    () => avgDaysByWeek(acats, now, weeks),
    [acats, now, weeks]
  );
  const avgDaysEx = useMemo(() => avgDaysExResiduals(acats), [acats]);
  const avgDaysAll = useMemo(() => avgDaysAllIn(acats), [acats]);
  const residualCount = useMemo(() => acats.filter(isResidual).length, [acats]);

  const weekly = avgDaysWeekly.map((w) => w.avgDays).filter((v): v is number => v !== null);
  const headline = avgDaysEx.avg !== null ? `${avgDaysEx.avg.toFixed(1)}d` : "—";

  const firstWeek = avgDaysWeekly.find((w) => w.avgDays !== null)?.avgDays ?? null;
  const lastWeek = [...avgDaysWeekly].reverse().find((w) => w.avgDays !== null)?.avgDays ?? null;
  const trend =
    firstWeek !== null && lastWeek !== null && firstWeek !== 0
      ? formatTrend(Math.round(((lastWeek - firstWeek) / firstWeek) * 100), "bad")
      : undefined;

  return (
    <StatTile
      icon={<Timer size={14} />}
      label="Avg Days to Complete"
      value={headline}
      trend={trend}
      tone="warning"
      rangeSelector={
        <RangeSelector
          options={AVG_DAYS_RANGE_OPTIONS}
          value={range}
          onChange={onRangeChange}
        />
      }
      sub={
        <>
          {weeks}-week trend · ex. residuals
          {residualCount > 0 && avgDaysAll !== null && (
            <> · all-in {avgDaysAll.toFixed(1)}d</>
          )}
        </>
      }
      sparkline={
        weekly.length > 0 ? (
          <Sparkline values={weekly} stroke="var(--status-amber-dot)" fill="var(--status-amber-dot)" zeroBaseline={false} />
        ) : undefined
      }
    />
  );
}

function KpiStalledTile({
  acats,
  now,
  range,
  onRangeChange,
  onJump,
}: RangedTileProps & { onJump: () => void }) {
  const stalled = useMemo(
    () => stalledSnapshot(acats, now),
    [acats, now]
  );
  const stalledTrend = useMemo(
    () => stalledTrendApprox(acats, now, range),
    [acats, now, range]
  );
  const series = stalledTrend.map((s) => s.count);
  const firstHalf = series.slice(0, Math.floor(series.length / 2));
  const secondHalf = series.slice(Math.floor(series.length / 2));
  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / Math.max(1, firstHalf.length);
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / Math.max(1, secondHalf.length);
  const trend =
    avgFirst > 0 ? formatTrend(Math.round(((avgSecond - avgFirst) / avgFirst) * 100), "bad") : undefined;

  return (
    <StatTile
      icon={<AlertTriangle size={14} />}
      label="Aging beyond SLA"
      value={String(stalled.count)}
      trend={trend}
      tone="danger"
      rangeSelector={
        <RangeSelector
          options={FLOW_RANGE_OPTIONS}
          value={range}
          onChange={onRangeChange}
        />
      }
      sub={
        stalled.count > 0
          ? `${stalled.over10} far over SLA · click to triage`
          : "All transfers within SLA"
      }
      sparkline={
        <Sparkline values={series} stroke="var(--status-red-dot)" fill="var(--status-red-dot)" />
      }
      onClick={stalled.count > 0 ? onJump : undefined}
    />
  );
}

function formatTrend(
  pct: number | null,
  betterDirection: "good" | "bad"
): { delta: string; direction: "good" | "bad" | "flat" } | undefined {
  if (pct === null) return undefined;
  if (pct === 0) return { delta: "0%", direction: "flat" };
  const sign = pct > 0 ? "+" : "";
  // For "good when up" metrics, +X% is good. For "good when down", +X% is bad.
  const direction: "good" | "bad" =
    pct > 0
      ? betterDirection === "good"
        ? "good"
        : "bad"
      : betterDirection === "good"
        ? "bad"
        : "good";
  return { delta: `${sign}${pct}%`, direction };
}

// ===========================================================================
// AUM Cumulative tile
// ===========================================================================

function AumCumulativeTile({ acats, now, range, onRangeChange }: RangedTileProps) {
  const aumSeries = useMemo(
    () => cumulativeCompletedAum(acats, now, range),
    [acats, now, range]
  );
  const aumYtd = aumSeries.length > 0 ? aumSeries[aumSeries.length - 1].total : 0;
  const aumPriorPoint =
    aumSeries.length >= 2 ? aumSeries[0].total : aumSeries[0]?.total ?? 0;
  const aumWindow = aumYtd - aumPriorPoint;
  const aumWeeklyAvg = range > 0 ? aumWindow / (range / 7) : 0;

  return (
    <div className="flex h-full flex-col rounded-xl border border-card-border bg-[var(--bg-card)] p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <DollarSign size={15} className="text-accent shrink-0" />
          <h3 className="truncate text-sm font-semibold text-foreground">
            AUM Completed — cumulative
          </h3>
        </div>
        <RangeSelector
          options={AUM_RANGE_OPTIONS}
          value={range}
          onChange={onRangeChange}
        />
      </div>

      <div className="mb-3 flex items-baseline gap-4 flex-wrap">
        <div>
          <p className="text-2xl font-bold leading-none tracking-tight text-[color:var(--status-emerald-fg)]">
            {formatCentsAsDollar(aumYtd)}
          </p>
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
            YTD into Apex
          </p>
        </div>
        <div className="text-xs text-muted">
          + <strong className="text-foreground">{formatCentsAsDollar(aumWindow)}</strong> last {rangeLabel(range)} ·{" "}
          <strong className="text-foreground">{formatCentsAsDollar(aumWeeklyAvg)}</strong> avg/wk
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <AreaChart
          values={aumSeries.map((s) => s.total)}
          stroke="var(--status-emerald-dot)"
          fillFrom="var(--status-emerald-dot)"
        />
      </div>
    </div>
  );
}

// ===========================================================================
// Reconciliation Health (donut)
// ===========================================================================

function ReconHealthTile({ analytics }: { analytics: Analytics }) {
  const rate = analytics.reconRate;
  const hasRate = rate !== null;
  const ringColor = !hasRate
    ? "var(--fill-3)"
    : rate >= 80
      ? "var(--success)"
      : rate >= 50
        ? "var(--accent)"
        : "var(--warning)";

  const total =
    analytics.matchedCount + analytics.pendingCount + analytics.mismatchCount;

  return (
    <div className="flex h-full flex-col rounded-xl border border-card-border bg-[var(--bg-card)] p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap size={15} className="text-accent" />
          <h3 className="text-sm font-semibold text-foreground">
            Reconciliation Health
          </h3>
        </div>
        <span className="text-xs text-muted">{total} positions</span>
      </div>

      <div className="flex flex-1 items-center gap-4">
        <div className="relative flex h-24 w-24 shrink-0 items-center justify-center">
          <svg className="h-24 w-24 -rotate-90" viewBox="0 0 100 100">
            <circle cx={50} cy={50} r={42} fill="none" stroke="var(--fill-3)" strokeWidth={10} />
            <circle
              cx={50}
              cy={50}
              r={42}
              fill="none"
              stroke={ringColor}
              strokeWidth={10}
              strokeLinecap="round"
              strokeDasharray={`${(hasRate ? rate : 0) * 2.64} 264`}
              className="transition-all duration-700"
            />
          </svg>
          <div className="absolute flex flex-col items-center">
            <span className="text-xl font-bold leading-none text-foreground">
              {hasRate ? `${rate}%` : "—"}
            </span>
            <span className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted">
              Match
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col">
          <ReconLegendRow color="var(--success)" label="Matched" count={analytics.matchedCount} />
          <ReconLegendRow color="var(--warning)" label="Pending" count={analytics.pendingCount} />
          <ReconLegendRow color="var(--danger)" label="Mismatch" count={analytics.mismatchCount} />
        </div>
      </div>
    </div>
  );
}

function ReconLegendRow({
  color,
  label,
  count,
}: {
  color: string;
  label: string;
  count: number;
}) {
  return (
    <div className="flex items-center justify-between border-b border-card-border py-1.5 last:border-b-0">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </div>
      <span className="text-sm font-bold text-foreground">{count}</span>
    </div>
  );
}

// ===========================================================================
// Direction Mix tile
// ===========================================================================

function DirectionMixTile({ analytics }: { analytics: Analytics }) {
  const { incoming, outgoing, unset } = analytics.direction;
  const total = incoming + outgoing;
  const inPct = total > 0 ? Math.round((incoming / total) * 100) : 0;
  const outPct = total > 0 ? 100 - inPct : 0;

  return (
    <div className="flex h-full flex-col rounded-xl border border-card-border bg-[var(--bg-card)] p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ArrowRight size={15} className="text-accent" />
          <h3 className="text-sm font-semibold text-foreground">Direction Mix</h3>
        </div>
        <span className="text-xs text-muted">{analytics.total} ACATs</span>
      </div>

      <div className="flex flex-1 items-center gap-4">
        <Donut
          segments={[
            { value: incoming, color: "var(--success)", label: "In" },
            { value: outgoing, color: "var(--danger)", label: "Out" },
          ]}
          centerLabel={total > 0 ? `${inPct}/${outPct}` : "—"}
          centerCaption="In/Out"
        />

        <div className="flex flex-1 flex-col text-xs">
          <div className="flex items-center justify-between border-b border-card-border py-1.5">
            <span className="flex items-center gap-2 text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--success)]" />
              Incoming
            </span>
            <span className="font-bold text-foreground">{incoming}</span>
          </div>
          <div className="flex items-center justify-between border-b border-card-border py-1.5">
            <span className="flex items-center gap-2 text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--danger)]" />
              Outgoing
            </span>
            <span className="font-bold text-foreground">{outgoing}</span>
          </div>
          {unset > 0 && (
            <div className="flex items-center justify-between py-1.5">
              <span className="flex items-center gap-2 text-muted">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--fill-3)]" />
                Unset
              </span>
              <span className="font-bold text-foreground">{unset}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Pipeline Status — horizontal 4-up bucketed strip
// ===========================================================================

function StatusDistributionTile({ analytics }: { analytics: Analytics }) {
  const [showDetail, setShowDetail] = useState(false);
  const total = analytics.total;

  return (
    <div className="rounded-xl border border-card-border bg-[var(--bg-card)] p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 size={15} className="text-accent" />
          <h3 className="text-sm font-semibold text-foreground">Pipeline Status</h3>
        </div>
        <span className="text-xs text-muted">{total} ACATs</span>
      </div>

      <div className="mb-4 flex h-2 overflow-hidden rounded-full bg-[var(--fill-1)]">
        {analytics.bucketCounts
          .filter((b) => b.count > 0)
          .map((b) => (
            <div
              key={b.id}
              className="transition-all duration-500"
              style={{
                width: `${(b.count / Math.max(1, total)) * 100}%`,
                backgroundColor: b.color,
              }}
              title={`${b.label}: ${b.count}`}
            />
          ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {analytics.bucketCounts.map((b) => {
          const pct = total > 0 ? Math.round((b.count / total) * 100) : 0;
          return (
            <div
              key={b.id}
              className="flex items-center gap-3 rounded-lg bg-[var(--fill-1)] px-3 py-3"
            >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: b.color }}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground">{b.label}</p>
                <p className="text-[11px] text-muted">{b.sublabel}</p>
              </div>
              <div className="text-right">
                <p className="text-base font-bold leading-none text-foreground">{b.count}</p>
                <p className="mt-0.5 text-[10px] text-muted">{pct}%</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 border-t border-dashed border-card-border pt-3">
        <button
          onClick={() => setShowDetail((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
        >
          <ChevronRight
            size={12}
            className={`transition-transform ${showDetail ? "rotate-90" : ""}`}
          />
          {showDetail ? "Hide" : "Show"} all {analytics.statusDetail.length} statuses
        </button>

        {showDetail && (
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 lg:grid-cols-4">
            {analytics.statusDetail.map((s) => (
              <div
                key={s.status}
                className="flex items-center justify-between text-xs"
              >
                <div className="flex items-center gap-2 text-muted">
                  <span className={`h-1.5 w-1.5 rounded-full ${s.color}`} />
                  {s.label}
                </div>
                <span className="font-semibold text-foreground">{s.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Requires Attention — table
// ===========================================================================

function ActionItemsTile({
  analytics,
  onSelectRecord,
}: {
  analytics: Analytics;
  onSelectRecord: (id: string) => void;
}) {
  const { now } = analytics;
  const items = analytics.actionItems;

  if (items.length === 0) {
    return (
      <div
        id={ACTION_ITEMS_ANCHOR}
        className="rounded-xl border border-card-border bg-[var(--bg-card)] p-6 text-center"
      >
        <CheckCircle2
          size={20}
          className="mx-auto mb-2 text-[color:var(--success)]"
        />
        <p className="text-sm font-medium text-foreground">
          Nothing requires attention
        </p>
        <p className="text-xs text-muted">
          No ACATs are stale, mismatched, or unmapped.
        </p>
      </div>
    );
  }

  return (
    <div
      id={ACTION_ITEMS_ANCHOR}
      className="rounded-xl border border-card-border bg-[var(--bg-card)] overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-card-border bg-[color:var(--warning-bg)] px-5 py-3.5">
        <div className="flex items-center gap-2">
          <AlertTriangle size={15} className="text-[color:var(--warning)]" />
          <h3 className="text-sm font-semibold text-foreground">Requires Attention</h3>
          <span className="rounded-full bg-[color:var(--warning)] px-2 py-0.5 text-[11px] font-bold text-white">
            {items.length}
          </span>
        </div>
        <p className="text-xs text-muted">
          Aging beyond custodian SLA or with open recon issues
        </p>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="bg-[var(--bg-hover)] text-[10px] font-semibold uppercase tracking-wider text-muted">
            <th className="px-5 py-2.5 text-left">Client</th>
            <th className="px-5 py-2.5 text-left">Status</th>
            <th className="px-5 py-2.5 text-left">Contra</th>
            <th className="px-5 py-2.5 text-right">Issues</th>
            <th className="px-5 py-2.5 text-right">Days Open</th>
            <th className="px-5 py-2.5 text-right">Value</th>
            <th className="px-5 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((acat) => {
            const issueCount = getIssueCount(acat);
            const daysOpen = getDaysOpen(acat, now);
            // ticket: color the day-count by per-custodian aging tier so a
            // 9-day BNY transfer (SLA 8d → on-track) doesn't look as urgent
            // as a 9-day Fidelity one (SLA 5d → high).
            const tier = getAgingTier(acat, now);
            const dayClass =
              tier === "high"
                ? "text-[color:var(--danger)]"
                : tier === "warn"
                  ? "text-[color:var(--warning)]"
                  : "text-foreground";
            const expectedDays = getExpectedProcessingDays(acat);

            return (
              <tr
                key={acat.id}
                onClick={() => onSelectRecord(acat.id)}
                className="cursor-pointer border-t border-card-border transition hover:bg-[var(--bg-hover)]"
              >
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">
                      {acat.clientName}
                    </span>
                    {acat.direction && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                          acat.direction === "In"
                            ? "bg-[color:var(--success-bg)] text-[color:var(--success)]"
                            : "bg-[color:var(--danger-bg)] text-[color:var(--danger)]"
                        }`}
                      >
                        {acat.direction.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted">
                    {acat.controlNumber || acat.crmDealId || acat.id}
                    {acat.accountType && ` · ${acat.accountType}`}
                  </div>
                </td>
                <td className="px-5 py-3">
                  <StatusBadge status={acat.status} />
                </td>
                <td className="px-5 py-3 text-muted">
                  {acat.transferringContra || acat.custodianName || "—"}
                </td>
                <td className="px-5 py-3 text-right">
                  <span
                    className={`font-bold ${
                      issueCount > 0
                        ? "text-[color:var(--danger)]"
                        : "text-muted-faint"
                    }`}
                  >
                    {issueCount}
                  </span>
                </td>
                <td
                  className={`px-5 py-3 text-right font-bold ${dayClass}`}
                  title={`SLA: ${expectedDays}d`}
                >
                  {daysOpen}
                  <span className="ml-1 font-normal text-muted-faint">
                    / {expectedDays}d
                  </span>
                </td>
                <td className="px-5 py-3 text-right text-foreground">
                  {formatCentsExact(acat.statementAmount ?? 0)}
                </td>
                <td className="px-3 py-3 text-right">
                  <ArrowRight size={14} className="text-muted-faint" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ===========================================================================
// Recent Activity slideover
// ===========================================================================

// ===========================================================================
// Tile Library — visible only in edit mode; lets users add hidden tiles back
// ===========================================================================

function TileLibrary({
  tiles,
  onAdd,
  onResetSize,
}: {
  tiles: TileLayout[];
  onAdd: (id: string) => void;
  onResetSize: (id: string) => void;
}) {
  const visibleIds = new Set(tiles.filter((t) => t.visible).map((t) => t.id));
  const hidden = DASHBOARD_TILES.filter((t) => !visibleIds.has(t.id));

  if (hidden.length === 0) {
    return (
      <div className="mb-5 flex items-center gap-2 rounded-lg border border-card-border bg-[var(--bg-card)] px-4 py-3 text-xs text-muted">
        <Layers size={13} />
        <span>All tiles are on the dashboard. Toggle the eye icon on any tile to hide it.</span>
      </div>
    );
  }

  return (
    <div className="mb-5 rounded-lg border border-card-border bg-[var(--bg-card)] px-4 py-3">
      <div className="mb-2.5 flex items-center gap-2">
        <Layers size={13} className="text-accent" />
        <span className="text-xs font-semibold text-foreground">
          Add tile to dashboard
        </span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted">
          {hidden.length} hidden
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {hidden.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              onAdd(t.id);
              onResetSize(t.id);
            }}
            className="flex items-center gap-2 rounded-md border border-card-border bg-[var(--bg-hover)] px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-[var(--fill-4)] hover:bg-[var(--fill-2)]"
          >
            <Plus size={12} />
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RecentActivityFab({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label="Toggle recent activity"
      className="absolute bottom-5 right-5 z-20 flex items-center gap-2 rounded-full border border-card-border bg-[var(--bg-card)] px-4 py-2.5 text-xs font-semibold text-foreground shadow-lg transition hover:bg-[var(--bg-hover)]"
    >
      <span className="flex h-2 w-2 rounded-full bg-[color:var(--success)]" />
      <TrendingUp size={13} />
      Recent Activity
      {count > 0 && (
        <span className="rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] font-bold text-muted">
          {count}
        </span>
      )}
    </button>
  );
}

function RecentActivityPanel({
  open,
  onClose,
  items,
  onSelectRecord,
}: {
  open: boolean;
  onClose: () => void;
  items: AcatRecord[];
  onSelectRecord: (id: string) => void;
}) {
  return (
    <>
      <div
        onClick={onClose}
        className={`absolute inset-0 z-30 bg-black/30 transition-opacity ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        role="dialog"
        aria-label="Recent activity"
        aria-hidden={!open}
        className={`absolute right-0 top-0 z-40 flex h-full w-[380px] flex-col border-l border-card-border bg-[var(--bg-card)] shadow-2xl transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-card-border px-5 py-4">
          <div className="flex items-center gap-2">
            <TrendingUp size={15} className="text-accent" />
            <h3 className="text-sm font-semibold text-foreground">Recent Activity</h3>
            <span className="rounded-full bg-[var(--bg-hover)] px-2 py-0.5 text-[10px] font-bold text-muted">
              {items.length}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted hover:bg-[var(--bg-hover)] hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted">
              No recent activity.
            </p>
          ) : (
            items.map((acat) => (
              <button
                key={acat.id}
                onClick={() => onSelectRecord(acat.id)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-[var(--bg-hover)]"
              >
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    TERMINAL_STATUSES.has(acat.status)
                      ? acat.status === "Completed"
                        ? "bg-[color:var(--success-bg)] text-[color:var(--success)]"
                        : "bg-[var(--bg-hover)] text-muted"
                      : "bg-[color:var(--info-bg)] text-[color:var(--info)]"
                  }`}
                >
                  <Package size={14} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {acat.clientName}
                  </p>
                  <p className="truncate text-[11px] text-muted">
                    {acat.transferringContra || acat.custodianName || "—"}
                    {acat.direction && ` · ${acat.direction}`}
                    {` · ${acat.assets.length} positions`}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <StatusBadge status={acat.status} />
                  <p className="mt-1 text-[10px] text-muted">
                    {formatDateMMDDYYYY(acat.lastUpdated)}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>
    </>
  );
}
