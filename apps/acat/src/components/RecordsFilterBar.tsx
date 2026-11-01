"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { RECORD_FIELDS, RecordField } from "@/lib/record-fields";
import {
  FilterRule,
  generateRuleId,
  defaultOperatorForType,
} from "@/lib/record-filters";
import FilterChip from "./FilterChip";

interface RecordsFilterBarProps {
  rules: FilterRule[];
  onChange: (rules: FilterRule[]) => void;
}

/**
 * Top-level filter builder. Renders one `FilterChip` per active rule plus
 * an `+ Add filter` button that opens a field-picker popover. The popover
 * lists every filterable field; picking one creates a new rule with the
 * default operator for that field's type and immediately opens its chip
 * editor so the user can fill in the operand without a second click.
 */
export default function RecordsFilterBar({
  rules,
  onChange,
}: RecordsFilterBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [freshlyAddedId, setFreshlyAddedId] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function handler(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  const filterableFields = useMemo(
    () => RECORD_FIELDS.filter((f) => f.filterable !== false),
    []
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return filterableFields;
    return filterableFields.filter((f) => f.label.toLowerCase().includes(q));
  }, [filterableFields, search]);

  const addRule = (field: RecordField) => {
    const rule: FilterRule = {
      id: generateRuleId(),
      field: field.key,
      operator: defaultOperatorForType(field.type),
    };
    onChange([...rules, rule]);
    setFreshlyAddedId(rule.id);
    setPickerOpen(false);
    setSearch("");
  };

  const updateRule = (next: FilterRule) =>
    onChange(rules.map((r) => (r.id === next.id ? next : r)));

  const removeRule = (id: string) => onChange(rules.filter((r) => r.id !== id));

  return (
    <div className="flex flex-wrap items-center gap-2">
      {rules.map((rule) => (
        <FilterChip
          key={rule.id}
          rule={rule}
          onChange={updateRule}
          onRemove={() => removeRule(rule.id)}
          defaultOpen={rule.id === freshlyAddedId}
        />
      ))}

      <div className="relative" ref={pickerRef}>
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-card-border bg-transparent px-2.5 py-1 text-xs font-medium text-muted transition hover:border-accent hover:text-accent"
        >
          <Plus size={12} />
          Add filter
        </button>

        {pickerOpen && (
          <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-lg border border-card-border bg-[var(--bg-card)] shadow-lg">
            <div className="border-b border-card-border p-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search fields…"
                className="w-full rounded border border-card-border bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground"
                autoFocus
              />
            </div>
            <div className="max-h-64 overflow-auto py-1">
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-xs italic text-muted">
                  No matching fields.
                </p>
              ) : (
                filtered.map((field) => (
                  <button
                    key={field.key}
                    type="button"
                    onClick={() => addRule(field)}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-[var(--bg-hover)]"
                  >
                    <span className="text-foreground">{field.label}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted">
                      {field.type}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {rules.length > 0 && (
        <button
          type="button"
          onClick={() => onChange([])}
          className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

const FILTER_RULES_STORAGE_KEY = "records-view-filters";

export function loadFilterRules(): FilterRule[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FILTER_RULES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as FilterRule[];
  } catch {
    return [];
  }
}

export function saveFilterRules(rules: FilterRule[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      FILTER_RULES_STORAGE_KEY,
      JSON.stringify(rules)
    );
  } catch {
    // localStorage unavailable; ignore.
  }
}
