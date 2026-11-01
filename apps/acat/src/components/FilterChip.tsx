"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { RECORD_FIELDS_BY_KEY } from "@/lib/record-fields";
import {
  FilterRule,
  FilterOperator,
  defaultOperatorForType,
  operatorsForType,
  OperatorDef,
} from "@/lib/record-filters";

export interface FilterChipProps {
  rule: FilterRule;
  onChange: (rule: FilterRule) => void;
  onRemove: () => void;
  /** Keep popover open when the chip is freshly added so the user can
   *  immediately fill in the operand. */
  defaultOpen?: boolean;
}

/**
 * Pill-shaped representation of a single filter rule. Click opens a
 * popover for editing the field/operator/value; the X removes the rule.
 *
 * The pill text always summarizes the rule so the user can scan a row of
 * chips without expanding each one.
 */
export default function FilterChip({
  rule,
  onChange,
  onRemove,
  defaultOpen = false,
}: FilterChipProps) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  const field = RECORD_FIELDS_BY_KEY.get(rule.field);

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

  const operators = field ? operatorsForType(field.type) : [];
  const opDef = operators.find((o) => o.op === rule.operator);

  const summary = useMemo(() => formatRule(rule), [rule]);

  return (
    <div className="relative" ref={ref}>
      <div
        className="inline-flex items-center rounded-full border border-card-border bg-[var(--bg-card)] text-xs"
        data-testid={`filter-chip-${rule.field}`}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 rounded-l-full px-2.5 py-1 text-foreground transition hover:bg-[var(--bg-hover)]"
        >
          <span className="font-medium">{field?.label ?? rule.field}</span>
          <span className="text-muted">{opDef?.label ?? rule.operator}</span>
          {summary.operandLabel && (
            <span className="text-foreground">{summary.operandLabel}</span>
          )}
          <ChevronDown size={11} className="text-muted" />
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove filter"
          className="rounded-r-full px-1.5 py-1 text-muted transition hover:bg-[var(--bg-hover)] hover:text-foreground"
        >
          <X size={12} />
        </button>
      </div>

      {open && field && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-card-border bg-[var(--bg-card)] p-3 shadow-lg">
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-muted">
            Operator
          </label>
          <select
            value={rule.operator}
            onChange={(e) => {
              const next = e.target.value as FilterOperator;
              onChange({ ...rule, operator: next, value: undefined, value2: undefined, values: [] });
            }}
            className="mb-3 w-full rounded border border-card-border bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground"
          >
            {operators.map((op) => (
              <option key={op.op} value={op.op}>
                {op.label}
              </option>
            ))}
          </select>

          {opDef && opDef.arity !== 0 && (
            <OperandEditor
              rule={rule}
              fieldType={field.type}
              options={field.options ?? []}
              opDef={opDef}
              onChange={onChange}
            />
          )}
        </div>
      )}
    </div>
  );
}

function OperandEditor({
  rule,
  fieldType,
  options,
  opDef,
  onChange,
}: {
  rule: FilterRule;
  fieldType: string;
  options: string[];
  opDef: OperatorDef;
  onChange: (r: FilterRule) => void;
}) {
  const inputType =
    fieldType === "date" ? "date" : fieldType === "number" ? "number" : "text";

  if (opDef.arity === "many") {
    const selected = new Set(rule.values ?? []);
    return (
      <div className="space-y-1 max-h-44 overflow-auto">
        {options.length === 0 ? (
          <p className="text-xs italic text-muted">No options.</p>
        ) : (
          options.map((opt) => (
            <label
              key={opt}
              className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-[var(--bg-hover)]"
            >
              <input
                type="checkbox"
                checked={selected.has(opt)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(opt);
                  else next.delete(opt);
                  onChange({ ...rule, values: Array.from(next) });
                }}
              />
              <span>{opt}</span>
            </label>
          ))
        )}
      </div>
    );
  }

  if (opDef.arity === 1) {
    if (fieldType === "enum" && options.length > 0) {
      return (
        <select
          value={rule.value ?? ""}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          className="w-full rounded border border-card-border bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground"
        >
          <option value="">—</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        type={inputType}
        value={rule.value ?? ""}
        onChange={(e) => onChange({ ...rule, value: e.target.value })}
        className="w-full rounded border border-card-border bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground"
        autoFocus
      />
    );
  }

  if (opDef.arity === 2) {
    return (
      <div className="flex items-center gap-2">
        <input
          type={inputType}
          value={rule.value ?? ""}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
          className="flex-1 rounded border border-card-border bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground"
          autoFocus
        />
        <span className="text-xs text-muted">and</span>
        <input
          type={inputType}
          value={rule.value2 ?? ""}
          onChange={(e) => onChange({ ...rule, value2: e.target.value })}
          className="flex-1 rounded border border-card-border bg-[var(--bg-card)] px-2 py-1 text-xs text-foreground"
        />
      </div>
    );
  }

  return null;
}

function formatRule(rule: FilterRule): { operandLabel: string } {
  if (rule.values?.length) {
    return {
      operandLabel: rule.values.length <= 2
        ? rule.values.join(", ")
        : `${rule.values.slice(0, 1).join(", ")} +${rule.values.length - 1}`,
    };
  }
  if (rule.value && rule.value2) return { operandLabel: `${rule.value}–${rule.value2}` };
  if (rule.value) return { operandLabel: rule.value };
  return { operandLabel: "" };
}

export { defaultOperatorForType };
