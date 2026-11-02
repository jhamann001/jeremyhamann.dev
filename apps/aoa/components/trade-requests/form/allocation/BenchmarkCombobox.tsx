"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ALLOCATION_COPY, PRESET_BENCHMARKS } from "@/lib/trade-requests/new-request-allocation";
import styles from "./Allocation.module.css";

/** Preset benchmarks or any typed ticker, as in the standalone form. */
export function BenchmarkCombobox({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(-1);
  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listboxId = `${id}-listbox`;
  const term = search.toLowerCase();
  const options = PRESET_BENCHMARKS.filter((b) => b.value.toLowerCase().includes(term) || b.label.toLowerCase().includes(term));

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, []);

  const choose = useCallback((next: string) => {
    onChange(next);
    setSearch("");
    setOpen(false);
    input.current?.blur();
  }, [onChange]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        setOpen(true);
        event.preventDefault();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, options.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active >= 0 && options[active]) choose(options[active].value);
    } else if (event.key === "Escape") {
      setOpen(false);
      setSearch("");
    }
  };

  const activeId = active >= 0 && options[active] ? `${listboxId}-${options[active].value}` : undefined;
  return (
    <div ref={wrapper} className={styles.combobox}>
      <input
        ref={input} id={id} type="text" role="combobox" aria-expanded={open} aria-controls={listboxId}
        aria-activedescendant={activeId} aria-autocomplete="list" autoComplete="off" placeholder={ALLOCATION_COPY.benchmarkPlaceholder}
        value={open ? search || value : value}
        onChange={(event) => {
          setSearch(event.target.value);
          setActive(-1);
          onChange(event.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setSearch("");
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id={listboxId} role="listbox" className={styles.listbox}>
          {options.map((option, index) => (
            <li
              key={option.value} id={`${listboxId}-${option.value}`} role="option" aria-selected={option.value === value}
              className={`${styles.option} ${index === active || option.value === value ? styles.optionActive : ""}`}
              onMouseDown={(event) => event.preventDefault()} onClick={() => choose(option.value)}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
