"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { parseMethodRequested, stringifyMethodRequested } from "@/lib/types";

interface MultiCheckSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  autoFocus?: boolean;
  /** "inline" (default) for inline-edit usage; "form" for modal/form usage that matches .form-input. */
  variant?: "inline" | "form";
}

export default function MultiCheckSelect({
  value,
  onChange,
  options,
  placeholder = "Select...",
  autoFocus,
  variant = "inline",
}: MultiCheckSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const selected = parseMethodRequested(value);
  const selectedSet = new Set(selected);

  useEffect(() => {
    if (autoFocus) triggerRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const toggle = (opt: string) => {
    const next = selectedSet.has(opt)
      ? selected.filter((m) => m !== opt)
      : [...selected, opt];
    onChange(stringifyMethodRequested(next));
  };

  return (
    <div ref={wrapperRef} className="relative flex-1">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          variant === "form"
            ? "form-input flex items-center justify-between gap-2 text-left"
            : "flex w-full items-center justify-between gap-2 rounded-md border border-accent bg-[var(--bg-card)] px-3 py-1.5 text-left text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-accent/30"
        }
      >
        <span className={selected.length === 0 ? "text-muted-faint" : ""}>
          {selected.length === 0
            ? placeholder
            : selected.length <= 2
              ? selected.join(", ")
              : `${selected.length} selected`}
        </span>
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border border-card-border bg-[var(--bg-card)] shadow-lg">
          <ul className="max-h-60 overflow-y-auto py-1">
            {options.map((opt) => {
              const isSelected = selectedSet.has(opt);
              return (
                <li key={opt}>
                  <button
                    type="button"
                    onClick={() => toggle(opt)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-[var(--bg-hover)]"
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        isSelected
                          ? "border-accent bg-accent text-[var(--invert-text)]"
                          : "border-card-border bg-[var(--bg-card)]"
                      }`}
                    >
                      {isSelected && <Check size={11} strokeWidth={3} />}
                    </span>
                    {opt}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
