"use client";

import { csvCell } from "@/lib/csv-cell";
import { getLinkedClients } from "./client-identity-display";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  EyeOff,
  FileStack,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { useEffectiveRole } from "@/lib/use-effective-role";
import {
  AcatRecord,
  AcatStatus,
  ACAT_STATUSES,
  ACAT_STATUS_LABELS,
  TERMINAL_STATUSES,
} from "@/lib/types";
import { hasIssues, needsFeeSubmission, needsTradeInstructions } from "@/lib/acat-derivations";
import {
  RECORD_FIELDS,
  RecordFieldKey,
  defaultColumnOrder,
  formatFieldValue,
  moveColumn,
  orderedVisibleFields,
} from "@/lib/record-fields";
import { applyFilters, FilterRule } from "@/lib/record-filters";
import { getColumnWidthPx } from "@/lib/column-display";
import RecordGroup from "./RecordGroup";
import { RowDensity } from "./RecordRow";
import RecordsFilterBar, {
  loadFilterRules,
  saveFilterRules,
} from "./RecordsFilterBar";
import ColumnChooser, {
  loadColumnOrder,
  loadVisibleColumns,
  saveColumnOrder,
  saveVisibleColumns,
} from "./ColumnChooser";
import { useToast } from "./Toast";

const DENSITY_STORAGE_KEY = "records-view-density";
const COLLAPSED_STORAGE_KEY = "records-view-collapsed";

type QuickFilter = "All" | "Active" | "My Queue" | "Issues" | "Fee to Submit" | "Missing Trade Instructions";
type SortDirection = "asc" | "desc";


interface SortConfig {
  key: RecordFieldKey;
  direction: SortDirection;
}

interface RecordsViewProps {
  acats: AcatRecord[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onOpenRecord: (id: string) => void;
  onRefresh: () => void | Promise<void>;
  /**
   * Whether deleted records are currently being fetched/shown. When true,
   * deleted rows are rendered in a separate "Deleted" section with a
   * Restore action. Only meaningful for admins.
   */
  showDeleted?: boolean;
  /**
   * Callback to toggle showDeleted. Omit for non-admins to hide the toggle.
   */
  onToggleShowDeleted?: () => void;
}

export default function RecordsView({
  acats,
  loading,
  error,
  selectedId,
  onOpenRecord,
  onRefresh,
  showDeleted = false,
  onToggleShowDeleted,
}: RecordsViewProps) {
  const { data: session } = useSession();
  const { role } = useEffectiveRole();
  const { toast } = useToast();
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());
  const isAdmin = role === "ADMIN";
  const canToggleDeleted = isAdmin && typeof onToggleShowDeleted === "function";
  const [search, setSearch] = useState("");
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("All");
  const [sortConfig, setSortConfig] = useState<SortConfig | null>(null);
  const [density, setDensity] = useState<RowDensity>(() =>
    loadDensity()
  );
  const [collapsed, setCollapsed] = useState<Set<AcatStatus>>(() =>
    loadCollapsed()
  );
  const [filterRules, setFilterRules] = useState<FilterRule[]>(() =>
    loadFilterRules()
  );
  const [visibleColumns, setVisibleColumns] = useState<Set<RecordFieldKey>>(
    () => loadVisibleColumns()
  );
  const [columnOrder, setColumnOrder] = useState<RecordFieldKey[]>(() =>
    loadColumnOrder()
  );
  // Key currently being dragged from the header row. Tracked in state so the
  // drop targets can render a visual insertion line and so the drag image is
  // dimmed via aria-grabbed styling.
  const [draggingKey, setDraggingKey] = useState<RecordFieldKey | null>(null);
  // Index where the drop will land. Computed from `dragenter`/`dragover` on
  // the next column header and used purely for the visual marker; the actual
  // reorder happens in `handleDrop` using the same index.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Re-anchor "now" when the record list updates so day counters stay fresh.
  // Called through a ref so the impure Date.now() read stays out of render
  // and the effect body isn't flagged as synchronous setState.
  const rebaseNowRef = useRef(() => setNow(Date.now()));
  useEffect(() => {
    rebaseNowRef.current();
  }, [acats]);

  useEffect(() => {
    persistDensity(density);
  }, [density]);

  useEffect(() => {
    persistCollapsed(collapsed);
  }, [collapsed]);

  useEffect(() => {
    saveFilterRules(filterRules);
  }, [filterRules]);

  useEffect(() => {
    saveVisibleColumns(visibleColumns);
  }, [visibleColumns]);

  useEffect(() => {
    saveColumnOrder(columnOrder);
  }, [columnOrder]);

  const userName = session?.user?.name ?? session?.user?.email ?? "";

  const matchesSearch = useCallback(
    (a: AcatRecord, q: string) =>
      !q ||
      a.clientName.toLowerCase().includes(q) ||
      getLinkedClients(a).some((client) => client.cedarRidgeUserId.toLowerCase().includes(q) || client.displayName.toLowerCase().includes(q)) ||
      (a.controlNumber ?? "").toLowerCase().includes(q) ||
      (a.crmDealId ?? "").toLowerCase().includes(q) ||
      (a.apexAccountId ?? "").toLowerCase().includes(q) ||
      (a.transferringContra ?? "").toLowerCase().includes(q) ||
      (a.custodianName ?? "").toLowerCase().includes(q) ||
      (a.wealthAdvisor ?? "").toLowerCase().includes(q) ||
      (a.direction ?? "").toLowerCase().includes(q) ||
      a.status.toLowerCase().includes(q),
    []
  );

  // Separate live records (shown in status groups) from deleted ones
  // (shown in a dedicated section below, admin-only).
  const live = useMemo(() => acats.filter((a) => !a.deletedAt), [acats]);
  const deleted = useMemo(() => acats.filter((a) => !!a.deletedAt), [acats]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const quickFiltered = live.filter((a) => {
      // quick filters
      if (quickFilter === "Active" && TERMINAL_STATUSES.has(a.status)) return false;
      if (quickFilter === "Issues" && !hasIssues(a)) return false;
      if (quickFilter === "Fee to Submit" && !needsFeeSubmission(a)) return false;
      if (quickFilter === "Missing Trade Instructions" && !needsTradeInstructions(a)) return false;
      if (quickFilter === "My Queue") {
        const mine = a.wealthAdvisor ?? "";
        if (!userName || !mine.toLowerCase().includes(userName.toLowerCase())) return false;
      }
      return matchesSearch(a, q);
    });
    return applyFilters(quickFiltered, filterRules);
  }, [live, matchesSearch, quickFilter, search, userName, filterRules]);

  const filteredDeleted = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deleted
      .filter((a) => matchesSearch(a, q))
      .sort((a, b) => {
        const ad = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
        const bd = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
        return bd - ad;
      });
  }, [deleted, matchesSearch, search]);

  const grouped = useMemo(() => {
    const groups = new Map<AcatStatus, AcatRecord[]>();
    for (const r of filtered) {
      const list = groups.get(r.status) ?? [];
      list.push(r);
      groups.set(r.status, list);
    }

    const sortField = sortConfig
      ? RECORD_FIELDS.find((field) => field.key === sortConfig.key)
      : undefined;

    for (const list of groups.values()) {
      if (sortField && sortConfig) {
        list.sort((a, b) =>
          compareFieldValues(sortField.value(a), sortField.value(b), sortConfig.direction)
        );
      } else {
        // Default view remains newest first.
        list.sort(
          (a, b) => new Date(b.acatDate).getTime() - new Date(a.acatDate).getTime()
        );
      }
    }

    const visibleStatuses = ACAT_STATUSES.filter(
      (status) => (groups.get(status)?.length ?? 0) > 0
    );
    if (sortConfig?.key === "status") {
      visibleStatuses.sort((a, b) =>
        compareFieldValues(
          ACAT_STATUS_LABELS[a],
          ACAT_STATUS_LABELS[b],
          sortConfig.direction
        )
      );
    }

    return visibleStatuses.map((status) => ({
      status,
      records: groups.get(status)!,
    }));
  }, [filtered, sortConfig]);

  // Header + row renderers both read from this list. Honors the user's
  // drag-reordered column order; falls back to the schema-default order for
  // any newly-added field that hasn't been persisted yet.
  const visibleFields = useMemo(
    () => orderedVisibleFields(columnOrder, visibleColumns),
    [columnOrder, visibleColumns]
  );

  const counts = useMemo(() => {
    const active = live.filter((a) => !TERMINAL_STATUSES.has(a.status)).length;
    const issues = live.filter(hasIssues).length;
    const feeToSubmit = live.filter(needsFeeSubmission).length;
    const missingTradeInstructions = live.filter(needsTradeInstructions).length;
    const mine = userName
      ? live.filter((a) => {
          const who = a.wealthAdvisor ?? "";
          return who.toLowerCase().includes(userName.toLowerCase());
        }).length
      : 0;
    return { all: live.length, active, issues, feeToSubmit, missingTradeInstructions, mine };
  }, [live, userName]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  const handleRestore = useCallback(
    async (record: AcatRecord) => {
      if (restoringIds.has(record.id)) return;
      setRestoringIds((prev) => {
        const next = new Set(prev);
        next.add(record.id);
        return next;
      });
      try {
        const res = await fetch(`/api/acats/${record.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Restored via admin UI" }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(
            "error",
            "Restore failed",
            data?.error ?? `HTTP ${res.status}`
          );
          return;
        }
        toast(
          "success",
          "ACAT restored",
          `${record.clientName} is visible again`
        );
        await onRefresh();
      } catch (err) {
        toast(
          "error",
          "Restore failed",
          err instanceof Error ? err.message : "Network error"
        );
      } finally {
        setRestoringIds((prev) => {
          const next = new Set(prev);
          next.delete(record.id);
          return next;
        });
      }
    },
    [onRefresh, restoringIds, toast]
  );

  // ── Header drag-and-drop reorder ───────────────────────────────────────
  // Native HTML5 drag-and-drop on the column headers. The dragging cell
  // stamps its key into the dataTransfer payload; each header cell is also a
  // drop target. We compute the target slot from the cell the cursor is
  // currently over: if it's the left half of the cell we insert *before* it,
  // otherwise *after*. The `dropIndex` shown in the UI is the index in the
  // post-removal coordinate space — same as `moveColumn` expects — so the
  // visual indicator and the final reorder agree.
  const handleHeaderDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, key: RecordFieldKey) => {
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        // Some browsers refuse to start a drag without a payload.
        try {
          e.dataTransfer.setData("text/plain", String(key));
        } catch {
          // Safari in some sandboxes throws; safe to ignore.
        }
      }
      setDraggingKey(key);
      setDropIndex(null);
    },
    []
  );

  const computeDropIndex = useCallback(
    (e: React.DragEvent<HTMLDivElement>, hoverIndex: number): number => {
      const rect = e.currentTarget.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      // Coordinates are in pre-removal space here; `moveColumn` re-indexes
      // after removing the dragged key, which means dropping onto the right
      // half of the cell at index `i` should land at `i` (after `i-1`'s
      // removal). Left half lands at `i-1` for the same reason. Clamp to 0.
      return Math.max(0, before ? hoverIndex - 1 : hoverIndex);
    },
    []
  );

  const handleHeaderDragOver = useCallback(
    (
      e: React.DragEvent<HTMLDivElement>,
      hoverKey: RecordFieldKey,
      hoverIndex: number
    ) => {
      if (!draggingKey || draggingKey === hoverKey) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const next = computeDropIndex(e, hoverIndex);
      setDropIndex((prev) => (prev === next ? prev : next));
    },
    [computeDropIndex, draggingKey]
  );

  const handleHeaderDrop = useCallback(
    (
      e: React.DragEvent<HTMLDivElement>,
      hoverKey: RecordFieldKey,
      hoverIndex: number
    ) => {
      if (!draggingKey || draggingKey === hoverKey) {
        setDraggingKey(null);
        setDropIndex(null);
        return;
      }
      e.preventDefault();
      const target = computeDropIndex(e, hoverIndex);
      // `moveColumn` operates on the *full* (visible+hidden) order so hidden
      // columns retain their relative position. The visible-only header
      // index has to be translated back to the full-order index of the
      // header at the target slot, then `moveColumn` adjusts for removal.
      setColumnOrder((prev) => {
        const fullVisibleKeys = orderedVisibleFields(prev, visibleColumns).map(
          (f) => f.key
        );
        const targetKey =
          target >= 0 && target < fullVisibleKeys.length
            ? fullVisibleKeys[target]
            : null;
        const fullIndex =
          targetKey === null ? prev.length : prev.indexOf(targetKey);
        return moveColumn(prev, draggingKey, fullIndex);
      });
      setDraggingKey(null);
      setDropIndex(null);
    },
    [computeDropIndex, draggingKey, visibleColumns]
  );

  const handleHeaderDragEnd = useCallback(() => {
    setDraggingKey(null);
    setDropIndex(null);
  }, []);

  const resetColumnOrder = useCallback(() => {
    setColumnOrder(defaultColumnOrder());
  }, []);

  const handleSort = useCallback((key: RecordFieldKey) => {
    setSortConfig((current) => ({
      key,
      direction:
        current?.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  }, []);

  const toggleGroup = useCallback((status: AcatStatus) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  if (loading && acats.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--invert-bg)] text-[var(--invert-text)] shadow-lg animate-pulse-glow">
            <FileStack size={20} />
          </div>
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 size={14} className="animate-spin text-accent" />
            Loading records…
          </div>
        </div>
      </div>
    );
  }

  if (error && acats.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[color:var(--danger-bg)] text-[color:var(--danger)]">
            <WifiOff size={20} />
          </div>
          <p className="text-sm font-semibold text-foreground">
            Failed to load records
          </p>
          <p className="text-xs text-muted">{error}</p>
          <button
            onClick={handleRefresh}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--invert-bg)] px-4 py-2 text-sm font-semibold text-[var(--invert-text)] hover:opacity-90"
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface">
      {error && (
        <div className="flex items-center justify-center gap-3 border-b border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] px-4 py-1.5 text-xs text-[color:var(--danger)]">
          <WifiOff size={12} />
          <span>Showing cached data. {error}</span>
          <button
            onClick={handleRefresh}
            className="font-semibold underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      <header className="shrink-0 border-b border-card-border bg-[var(--bg-card)] px-6 py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              All Records
            </h1>
            <p className="mt-0.5 text-xs text-muted">
              {counts.active} active · {counts.all - counts.active} terminal · grouped by status
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-xs font-medium text-foreground transition hover:bg-[var(--bg-hover)] disabled:opacity-60"
            >
              <RefreshCw
                size={12}
                className={refreshing ? "animate-spin" : ""}
              />
              Refresh
            </button>
            {canToggleDeleted && (
              <button
                onClick={onToggleShowDeleted}
                aria-pressed={showDeleted}
                title={
                  showDeleted
                    ? "Hide soft-deleted records"
                    : "Show soft-deleted records"
                }
                className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                  showDeleted
                    ? "border-[color:var(--danger-border)] bg-[color:var(--danger-bg)] text-[color:var(--danger)]"
                    : "border-card-border bg-[var(--bg-card)] text-foreground hover:bg-[var(--bg-hover)]"
                }`}
              >
                {showDeleted ? <EyeOff size={12} /> : <Trash2 size={12} />}
                {showDeleted ? "Hide deleted" : "Show deleted"}
              </button>
            )}
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-2 text-xs font-medium text-foreground transition hover:bg-[var(--bg-hover)]"
              title="Export current view as CSV"
              onClick={() => exportCsv(filtered, columnOrder)}
            >
              <Download size={12} />
              Export CSV
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex max-w-sm flex-1 items-center gap-2 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-1.5 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/30">
            <Search size={13} className="text-muted" />
            <input
              type="text"
              placeholder="Search name, control #, deal, advisor…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-faint focus:outline-none"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="text-muted hover:text-foreground"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>

          <QuickChip
            label="All"
            count={counts.all}
            active={quickFilter === "All"}
            onClick={() => setQuickFilter("All")}
          />
          <QuickChip
            label="Active"
            count={counts.active}
            active={quickFilter === "Active"}
            onClick={() => setQuickFilter("Active")}
          />
          <QuickChip
            label="My Queue"
            count={counts.mine}
            active={quickFilter === "My Queue"}
            onClick={() => setQuickFilter("My Queue")}
          />
          <QuickChip
            label="Issues"
            count={counts.issues}
            active={quickFilter === "Issues"}
            onClick={() => setQuickFilter("Issues")}
          />
          <QuickChip
            label="Fee to Submit"
            count={counts.feeToSubmit}
            active={quickFilter === "Fee to Submit"}
            onClick={() => setQuickFilter("Fee to Submit")}
          />
          <QuickChip
            label="Missing Trade Instructions"
            count={counts.missingTradeInstructions}
            active={quickFilter === "Missing Trade Instructions"}
            onClick={() => setQuickFilter("Missing Trade Instructions")}
          />

          <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-card-border">
            {(["comfortable", "compact"] as RowDensity[]).map((d) => (
              <button
                key={d}
                onClick={() => setDensity(d)}
                className={`px-2.5 py-1.5 text-[11px] font-medium capitalize transition ${
                  density === d
                    ? "bg-[var(--invert-bg)] text-[var(--invert-text)]"
                    : "bg-[var(--bg-card)] text-muted hover:bg-[var(--bg-hover)]"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <RecordsFilterBar rules={filterRules} onChange={setFilterRules} />
          </div>
          <ColumnChooser
            visible={visibleColumns}
            onChange={setVisibleColumns}
            onResetOrder={resetColumnOrder}
          />
        </div>
      </header>

      {/* Horizontally scrollable wrapper so wide column selections don't squish */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto">
        <div className="min-w-max">
          {/* Column header (sits above the scrolling groups). Each cell is
              draggable so operators can reorder columns; the drop position
              is previewed with a thin accent-coloured insertion line on the
              left edge of the target cell. */}
          <div
            className="sticky top-0 z-[2] flex w-max min-w-full items-center gap-3 border-b border-card-border bg-surface px-6 py-2 text-[9px] font-semibold uppercase tracking-wider text-muted-faint"
            role="row"
            onDragEnd={handleHeaderDragEnd}
          >
            {visibleFields.map((field, idx) => {
              const width = getColumnWidthPx(field.key);
              const isNumeric =
                field.type === "number" ||
                field.key === "daysOpen" ||
                field.key === "assetCount" ||
                field.key === "issueCount";
              const isDragging = draggingKey === field.key;
              // Show the insertion marker on the cell whose left edge
              // matches the post-removal target slot. The drop target is
              // computed in post-removal space, so cell at visible-index N
              // shows the marker when dropIndex === N (after removal).
              const showMarker =
                draggingKey !== null &&
                dropIndex !== null &&
                field.key !== draggingKey &&
                ((dropIndex === 0 && idx === 0) ||
                  (dropIndex > 0 && idx === dropIndex));
              return (
                <div
                  key={field.key}
                  role="columnheader"
                  draggable
                  aria-grabbed={isDragging}
                  aria-sort={
                    sortConfig?.key === field.key
                      ? sortConfig.direction === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  data-column-key={field.key}
                  onDragStart={(e) => handleHeaderDragStart(e, field.key)}
                  onDragOver={(e) => handleHeaderDragOver(e, field.key, idx)}
                  onDragEnter={(e) => handleHeaderDragOver(e, field.key, idx)}
                  onDrop={(e) => handleHeaderDrop(e, field.key, idx)}
                  onDragEnd={handleHeaderDragEnd}
                  title={`Drag to reorder · ${field.label}`}
                  className={`relative cursor-grab select-none active:cursor-grabbing ${
                    isNumeric ? "text-right" : "text-left"
                  } ${isDragging ? "opacity-40" : ""}`}
                  style={{
                    width,
                    minWidth: width,
                    flex:
                      field.key === "clientName"
                        ? `1 1 ${width}px`
                        : `0 0 ${width}px`,
                  }}
                >
                  {showMarker && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -left-1.5 top-0 h-full w-0.5 rounded-full bg-accent"
                    />
                  )}
                  <button
                    type="button"
                    draggable={false}
                    onClick={() => handleSort(field.key)}
                    aria-label={`Sort by ${field.label}`}
                    title={
                      sortConfig?.key === field.key
                        ? `Sort ${sortConfig.direction === "asc" ? "descending" : "ascending"}`
                        : `Sort ${field.label} ascending`
                    }
                    className={`inline-flex w-full items-center gap-1 rounded-sm outline-none transition hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent/50 ${
                      isNumeric ? "justify-end" : "justify-start"
                    }`}
                  >
                    <span>{field.label}</span>
                    {sortConfig?.key === field.key ? (
                      sortConfig.direction === "asc" ? (
                        <ArrowUp size={10} aria-hidden />
                      ) : (
                        <ArrowDown size={10} aria-hidden />
                      )
                    ) : (
                      <ArrowUpDown
                        size={10}
                        aria-hidden
                        className="opacity-40"
                      />
                    )}
                  </button>
                </div>
              );
            })}
            <div className="w-[16px] shrink-0" aria-hidden />
          </div>

          {/* Groups */}
          {grouped.length === 0 && filteredDeleted.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <Search size={26} className="text-muted-faint" />
              <p className="text-sm font-medium text-muted">No records match</p>
              <p className="text-xs text-muted-faint">
                Try clearing the search or switching filters.
              </p>
            </div>
          ) : (
            <>
              {grouped.map(({ status, records }) => (
                <RecordGroup
                  key={status}
                  status={status}
                  records={records}
                  collapsed={collapsed.has(status)}
                  selectedId={selectedId}
                  density={density}
                  now={now}
                  visibleColumns={visibleColumns}
                  columnOrder={columnOrder}
                  onToggle={toggleGroup}
                  onOpenRecord={onOpenRecord}
                  onRecordMutate={onRefresh}
                />
              ))}
              {isAdmin && showDeleted && filteredDeleted.length > 0 && (
                <DeletedRecordsSection
                  records={filteredDeleted}
                  density={density}
                  restoringIds={restoringIds}
                  onRestore={handleRestore}
                  onOpenRecord={onOpenRecord}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DeletedRecordsSection({
  records,
  density,
  restoringIds,
  onRestore,
  onOpenRecord,
}: {
  records: AcatRecord[];
  density: RowDensity;
  restoringIds: Set<string>;
  onRestore: (record: AcatRecord) => void;
  onOpenRecord: (id: string) => void;
}) {
  const paddingClass = density === "compact" ? "py-1.5" : "py-3" ;
  const textClass = density === "compact" ? "text-[11px]" : "text-xs";

  return (
    <section className="border-b border-card-border" data-section="deleted">
      <header className="sticky top-0 z-[1] flex items-center gap-3 border-b border-card-border bg-[var(--bg-card)] px-6 py-2.5">
        <Trash2 size={14} className="text-[color:var(--danger)]" />
        <span className="text-sm font-semibold text-[color:var(--danger)]">
          Deleted
        </span>
        <span className="rounded-full bg-[var(--bg-hover)] px-2 py-0.5 font-mono text-[10px] font-bold text-muted">
          {records.length}
        </span>
        <span className="ml-2 text-[11px] text-muted">
          Soft-deleted records. Hidden from normal views.
        </span>
      </header>
      <div role="list">
        {records.map((r) => {
          const isRestoring = restoringIds.has(r.id);
          const deletedOn = r.deletedAt
            ? new Date(r.deletedAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })
            : null;
          return (
            <div
              key={r.id}
              role="listitem"
              data-record-id={r.id}
              data-deleted="true"
              className={`flex items-center gap-3 border-b border-card-border px-6 ${paddingClass} ${textClass} opacity-75`}
            >
              <button
                type="button"
                onClick={() => onOpenRecord(r.id)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate font-semibold text-foreground line-through decoration-[color:var(--danger)]/50">
                  {r.clientName}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
                  <span>{r.id}</span>
                  {deletedOn && (
                    <>
                      <span className="text-card-border">|</span>
                      <span>Deleted {deletedOn}</span>
                    </>
                  )}
                  {r.transferringContra && (
                    <>
                      <span className="text-card-border">|</span>
                      <span className="truncate">{r.transferringContra}</span>
                    </>
                  )}
                </div>
              </button>
              <button
                type="button"
                onClick={() => onRestore(r)}
                disabled={isRestoring}
                aria-label={`Restore ${r.clientName}`}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-card-border bg-[var(--bg-card)] px-2.5 py-1.5 text-[11px] font-semibold text-foreground transition hover:border-accent hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isRestoring ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RotateCcw size={11} />
                )}
                {isRestoring ? "Restoring..." : "Restore"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function compareFieldValues(
  a: string | number | boolean | null,
  b: string | number | boolean | null,
  direction: SortDirection
): number {
  const aMissing = a == null || a === "";
  const bMissing = b == null || b === "";
  // Keep blank values at the bottom in both directions.
  if (aMissing || bMissing) {
    if (aMissing && bMissing) return 0;
    return aMissing ? 1 : -1;
  }

  let result: number;
  if (typeof a === "number" && typeof b === "number") {
    result = a - b;
  } else if (typeof a === "boolean" && typeof b === "boolean") {
    result = Number(a) - Number(b);
  } else {
    result = String(a).localeCompare(String(b), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }
  return direction === "asc" ? result : -result;
}

function QuickChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition ${
        active
          ? "border-[var(--invert-bg)] bg-[var(--invert-bg)] text-[var(--invert-text)]"
          : "border-card-border bg-[var(--bg-card)] text-muted hover:bg-[var(--bg-hover)] hover:text-foreground"
      }`}
    >
      {label}
      <span
        className={`rounded-full px-1.5 py-0 font-mono text-[10px] font-bold ${
          active
            ? "bg-[color-mix(in_oklch,var(--invert-text),transparent_80%)] text-[var(--invert-text)]"
            : "bg-[var(--bg-hover)] text-muted"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function loadDensity(): RowDensity {
  if (typeof window === "undefined") return "comfortable";
  try {
    const v = window.localStorage.getItem(DENSITY_STORAGE_KEY);
    if (v === "compact" || v === "comfortable") return v;
    // Migrate legacy "default" → "comfortable"
    if (v === "default") return "comfortable";
  } catch {
    // ignore
  }
  return "comfortable";
}

function persistDensity(d: RowDensity) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, d);
  } catch {
    // ignore
  }
}

function loadCollapsed(): Set<AcatStatus> {
  if (typeof window === "undefined") return new Set(TERMINAL_STATUSES);
  try {
    const v = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!v) return new Set(TERMINAL_STATUSES);
    const arr = JSON.parse(v) as string[];
    return new Set(arr.filter((s): s is AcatStatus =>
      (ACAT_STATUSES as readonly string[]).includes(s)
    ));
  } catch {
    return new Set(TERMINAL_STATUSES);
  }
}

function persistCollapsed(s: Set<AcatStatus>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      COLLAPSED_STORAGE_KEY,
      JSON.stringify(Array.from(s))
    );
  } catch {
    // ignore
  }
}

function serializeAssets(r: AcatRecord): string {
  // Flatten the nested Asset[] into one cell so the CSV stays one row per
  // ACAT. Format: "AAPL 1000/1000 Mapped; TSLA 200/190 Mapped (Qty Mismatch
  // -10)". Pipes/semicolons are safe inside a CSV-escaped field.
  return r.assets
    .map((a) => {
      const qty = `${a.expectedQty}/${a.actualQty}`;
      const issue = a.issue ? ` (${a.issue})` : "";
      return `${a.symbol} ${qty} ${a.mapStatus}${issue}`;
    })
    .join("; ");
}

function exportCsv(
  records: AcatRecord[],
  columnOrder?: readonly RecordFieldKey[]
) {
  if (typeof document === "undefined") return;
  // Headers + values are derived from the central RECORD_FIELDS schema so
  // adding a column to the records UI also adds it to the CSV without
  // hand-maintaining a parallel list. The trailing "Assets" column flattens
  // the nested asset list into a single cell so the CSV stays one row per
  // ACAT (see serializeAssets below).
  //
  // When the caller passes the user's drag-reordered column order, the
  // export honours it so CSV columns match what the operator sees in the
  // table. Hidden columns are still exported (parity with the historical
  // behaviour) but placed at the end in their schema-natural order.
  const orderedFields = (() => {
    if (!columnOrder || columnOrder.length === 0) return RECORD_FIELDS;
    const byKey = new Map(RECORD_FIELDS.map((f) => [f.key, f] as const));
    const seen = new Set<RecordFieldKey>();
    const out: typeof RECORD_FIELDS = [];
    for (const key of columnOrder) {
      const field = byKey.get(key);
      if (!field || seen.has(key)) continue;
      seen.add(key);
      out.push(field);
    }
    for (const field of RECORD_FIELDS) {
      if (!seen.has(field.key)) {
        seen.add(field.key);
        out.push(field);
      }
    }
    return out;
  })();
  const header = [...orderedFields.map((f) => f.label), "Assets"];
  const rows = records.map((r) => [
    ...orderedFields.map((f) => formatFieldValue(f, r)),
    serializeAssets(r),
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `acat-records-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Formula-safe: notes and names in the export are typed by other people.
const csvEscape = csvCell;
