"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, Loader2, Plus } from "lucide-react";
import { normalizeContra, ALIAS } from "@/lib/contra-normalize";

export interface ContraOption {
  id: string;
  name: string;
}

interface ContraComboboxProps {
  value: string;
  onChange: (name: string) => void;
  options: ContraOption[];
  canCreate?: boolean;
  onCreate?: (name: string) => Promise<void> | void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

export default function ContraCombobox({
  value,
  onChange,
  options,
  canCreate = false,
  onCreate,
  placeholder = "Select contra...",
  className,
  disabled,
  autoFocus,
}: ContraComboboxProps) {
  const [query, setQuery] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [creating, setCreating] = useState(false);
  // Persistent "no match" notice shown AFTER blur. The in-dropdown hint
  // vanishes when the dropdown closes, so non-admins were left with no idea
  // why their typed contra silently reverted. Cleared when the query changes
  // or a valid option is chosen.
  const [noMatchMessage, setNoMatchMessage] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Resync local query when the parent-controlled value changes.
  // Render-phase state update pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  if (value !== prevValue) {
    setPrevValue(value);
    setQuery(value);
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, query]);

  const trimmedQuery = query.trim();
  const hasExactMatch = useMemo(
    () =>
      options.some(
        (o) => o.name.toLowerCase() === trimmedQuery.toLowerCase()
      ),
    [options, trimmedQuery]
  );

  const showAddRow = canCreate && trimmedQuery.length > 0 && !hasExactMatch;
  const totalItems = filtered.length + (showAddRow ? 1 : 0);

  // Clamp highlight in-place when the filtered list shrinks below it.
  const clampedHighlight = Math.min(highlight, Math.max(0, totalItems - 1));
  if (clampedHighlight !== highlight) {
    setHighlight(clampedHighlight);
  }

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery(value);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open, value]);

  const selectOption = useCallback(
    (opt: ContraOption) => {
      onChange(opt.name);
      setQuery(opt.name);
      setOpen(false);
      setNoMatchMessage(null);
    },
    [onChange]
  );

  const handleCreate = useCallback(async () => {
    if (!onCreate || !trimmedQuery || creating) return;
    setCreating(true);
    try {
      await onCreate(trimmedQuery);
      setOpen(false);
      setNoMatchMessage(null);
    } finally {
      setCreating(false);
    }
  }, [onCreate, trimmedQuery, creating]);

  // Snap the current query onto an EXISTING option when it matches by
  // normalized form or a known alias. Returns the canonical option name, or
  // null when nothing matches (in which case free text is never committed —
  // a genuinely-new name must go through the admin "Add" row). Imports the
  // pure `contra-normalize` module so this stays client-safe.
  const resolveToOption = useCallback((): string | null => {
    const norm = normalizeContra(trimmedQuery);
    if (!norm) return null;
    const direct = options.find((o) => normalizeContra(o.name) === norm);
    if (direct) return direct.name;
    const aliasTarget = ALIAS[norm];
    if (aliasTarget) {
      const aliasNorm = normalizeContra(aliasTarget);
      const aliased = options.find((o) => normalizeContra(o.name) === aliasNorm);
      if (aliased) return aliased.name;
    }
    return null;
  }, [options, trimmedQuery]);

  const commitHighlighted = useCallback(() => {
    if (filtered.length > 0 && highlight < filtered.length) {
      selectOption(filtered[highlight]);
      return;
    }
    if (showAddRow && highlight === filtered.length) {
      void handleCreate();
      return;
    }
    // No option highlighted and no Add row available. Never commit raw free
    // text: snap to a known option if the query normalizes/aliases to one;
    // otherwise leave the field + "no match" hint visible so the operator
    // uses the admin "Add" action to introduce a genuinely-new name.
    if (trimmedQuery) {
      const snap = resolveToOption();
      if (snap) {
        onChange(snap);
        setQuery(snap);
        setOpen(false);
        setNoMatchMessage(null);
      }
    }
  }, [
    filtered,
    highlight,
    showAddRow,
    handleCreate,
    trimmedQuery,
    resolveToOption,
    onChange,
    selectOption,
  ]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(totalItems - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      commitHighlighted();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setQuery(value);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className={`relative ${className ?? ""}`}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="contra-listbox"
          aria-autocomplete="list"
          value={query}
          disabled={disabled}
          autoFocus={autoFocus}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(0);
            setNoMatchMessage(null);
          }}
          onBlur={() => {
            // Never commit raw free text on blur. If the query snaps to a
            // known option (normalized/alias), commit that canonical name;
            // otherwise discard the stray text back to the committed value.
            const snap = resolveToOption();
            if (snap) {
              if (snap !== value) onChange(snap);
              setNoMatchMessage(null);
            } else {
              // Genuinely-unmatched typed text. Leave a persistent notice so
              // the operator knows why it reverted — the in-dropdown hint is
              // gone once the dropdown closes.
              if (trimmedQuery) {
                setNoMatchMessage(
                  canCreate
                    ? "No match — use Add to create"
                    : "No match — ask an admin to add this contra"
                );
              } else {
                setNoMatchMessage(null);
              }
              if (trimmedQuery !== value) setQuery(value);
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="form-input pr-9"
        />
        <ChevronDown
          size={14}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
        />
      </div>

      {open && (
        <ul
          id="contra-listbox"
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-card-border bg-[var(--bg-card)] py-1 shadow-lg"
        >
          {filtered.length === 0 && !showAddRow && (
            <li className="px-3 py-2 text-xs italic text-muted">
              {trimmedQuery ? "No match — use Add to create" : "No contras match"}
            </li>
          )}
          {filtered.map((opt, i) => {
            const active = i === highlight;
            const isSelected =
              opt.name.toLowerCase() === value.toLowerCase();
            return (
              <li
                key={opt.id}
                role="option"
                aria-selected={isSelected}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectOption(opt);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={`cursor-pointer px-3 py-1.5 text-sm ${
                  active
                    ? "bg-accent/10 text-foreground"
                    : "text-foreground hover:bg-[var(--bg-hover)]"
                } ${isSelected ? "font-semibold" : ""}`}
              >
                {opt.name}
              </li>
            );
          })}
          {showAddRow && (
            <li
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                void handleCreate();
              }}
              onMouseEnter={() => setHighlight(filtered.length)}
              className={`sticky bottom-0 flex cursor-pointer items-center gap-2 border-t border-card-border bg-[var(--bg-card)] px-3 py-2 text-sm font-medium text-accent ${
                highlight === filtered.length ? "bg-accent/10" : "hover:bg-accent/5"
              }`}
            >
              {creating ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Plus size={13} />
              )}
              Add &quot;{trimmedQuery}&quot; as a new contra
            </li>
          )}
        </ul>
      )}

      {!open && noMatchMessage && (
        <p className="mt-1 text-xs italic text-muted" role="status">
          {noMatchMessage}
        </p>
      )}
    </div>
  );
}
