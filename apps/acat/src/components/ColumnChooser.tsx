"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Columns3, RotateCcw } from "lucide-react";
import {
  RECORD_FIELDS,
  RecordFieldKey,
  defaultColumnOrder,
  defaultVisibleColumns,
  normalizeColumnOrder,
} from "@/lib/record-fields";

interface ColumnChooserProps {
  visible: Set<RecordFieldKey>;
  onChange: (next: Set<RecordFieldKey>) => void;
  /**
   * Optional hook so the "Reset" button also restores the user's
   * drag-reordered column order back to the schema default. When omitted
   * the chooser only resets visibility (backwards-compatible).
   */
  onResetOrder?: () => void;
}

/**
 * Popover with a search input + a checkbox per filterable record field. The
 * `Reset to defaults` link clears the user's overrides back to the
 * `visibleByDefault` set defined in `record-fields.ts`.
 */
export default function ColumnChooser({
  visible,
  onChange,
  onResetOrder,
}: ColumnChooserProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const fields = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return RECORD_FIELDS;
    return RECORD_FIELDS.filter((f) => f.label.toLowerCase().includes(q));
  }, [search]);

  const toggle = (key: RecordFieldKey) => {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  const reset = () => {
    onChange(defaultVisibleColumns());
    onResetOrder?.();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-card-border bg-[var(--bg-card)] px-3 py-1.5 text-[11px] font-medium text-foreground transition hover:bg-[var(--bg-hover)]"
      >
        <Columns3 size={12} />
        Columns
        <span className="rounded bg-[var(--bg-hover)] px-1 font-mono text-[10px] text-muted">
          {visible.size}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-card-border bg-[var(--bg-card)] shadow-lg">
          <div className="flex items-center gap-2 border-b border-card-border p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search columns…"
              className="flex-1 rounded border border-card-border bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground"
              autoFocus
            />
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted hover:text-foreground"
              title="Reset to default columns"
            >
              <RotateCcw size={11} />
              Reset
            </button>
          </div>
          <div className="max-h-64 overflow-auto py-1">
            {fields.length === 0 ? (
              <p className="px-3 py-2 text-xs italic text-muted">
                No matching columns.
              </p>
            ) : (
              fields.map((field) => {
                const id = `column-toggle-${field.key}`;
                return (
                  <label
                    key={field.key}
                    htmlFor={id}
                    className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--bg-hover)]"
                  >
                    <input
                      id={id}
                      type="checkbox"
                      checked={visible.has(field.key)}
                      onChange={() => toggle(field.key)}
                    />
                    <span className="flex-1 text-foreground">
                      {field.label}
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-muted">
                      {field.type}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const COLUMNS_STORAGE_KEY = "records-view-columns";

export function loadVisibleColumns(): Set<RecordFieldKey> {
  if (typeof window === "undefined") return defaultVisibleColumns();
  try {
    const raw = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) return defaultVisibleColumns();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultVisibleColumns();
    return new Set(parsed as RecordFieldKey[]);
  } catch {
    return defaultVisibleColumns();
  }
}

export function saveVisibleColumns(visible: Set<RecordFieldKey>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      COLUMNS_STORAGE_KEY,
      JSON.stringify(Array.from(visible))
    );
  } catch {
    // localStorage unavailable; ignore.
  }
}

const COLUMN_ORDER_STORAGE_KEY = "records-view-column-order";

/**
 * Load the user's drag-reordered column order from localStorage, falling
 * back to the schema-default order. Always returned via
 * `normalizeColumnOrder` so stale keys are dropped and newly added fields
 * are appended at the end (preventing them from being permanently hidden
 * for users who saved an order before the new field shipped).
 */
export function loadColumnOrder(): RecordFieldKey[] {
  if (typeof window === "undefined") return defaultColumnOrder();
  try {
    const raw = window.localStorage.getItem(COLUMN_ORDER_STORAGE_KEY);
    if (!raw) return defaultColumnOrder();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultColumnOrder();
    return normalizeColumnOrder(parsed as RecordFieldKey[]);
  } catch {
    return defaultColumnOrder();
  }
}

export function saveColumnOrder(order: readonly RecordFieldKey[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      COLUMN_ORDER_STORAGE_KEY,
      JSON.stringify(Array.from(order))
    );
  } catch {
    // localStorage unavailable; ignore.
  }
}
