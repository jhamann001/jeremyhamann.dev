"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconSearch } from "@/components/icons";
import { globalSearchAction } from "@/app/(authenticated)/search-actions";
import {
  MIN_QUERY_LENGTH,
  type SearchResult,
  type SearchResultType,
} from "@/lib/data/search-types";
import styles from "./GlobalSearch.module.css";

// Live global search — replaces the Topbar's inert placeholder input (flag
// GLOBAL_SEARCH). Debounced (250ms) calls to the RLS-scoped globalSearchAction;
// results grouped by type so every option shows WHAT it is; ↑/↓/Enter/Esc
// keyboard nav; a seq race-guard so a slow stale response never overwrites a
// fresh one. Modeled on components/transfers/ClientSearch.tsx (blur-timeout,
// Escape, click-to-navigate) plus the pieces it lacks.

const DEBOUNCE_MS = 250;

// Fixed display order + the human type label ("show what each option is").
const TYPE_ORDER: SearchResultType[] = [
  "household",
  "client",
  "deal",
  "transfer",
];
const TYPE_LABEL: Record<SearchResultType, string> = {
  household: "Household",
  client: "Client",
  deal: "Deal",
  transfer: "Asset transfer",
};

export function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1); // flat index into `results`

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0); // race-guard: only the latest request may apply
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  // Keep the keyboard-highlighted option visible inside the scrollable dropdown.
  useEffect(() => {
    if (active >= 0) activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runSearch = useCallback((value: string) => {
    // Bump the sequence on EVERY call — including the short-query short-circuit
    // — so an in-flight response for a longer query is discarded once the user
    // narrows the box below MIN_QUERY_LENGTH (else a stale "sm" result could
    // repaint the dropdown after the input is back to "s").
    const mine = ++seq.current;
    const trimmed = value.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      setActive(-1);
      return;
    }
    setLoading(true);
    globalSearchAction(trimmed)
      .then((rows) => {
        if (mine !== seq.current) return; // a newer request superseded us
        setResults(rows);
        setActive(-1);
        setLoading(false);
      })
      .catch(() => {
        if (mine !== seq.current) return;
        setResults([]);
        setLoading(false);
      });
  }, []);

  function onChange(value: string) {
    setQ(value);
    setOpen(value.trim().length > 0);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => runSearch(value), DEBOUNCE_MS);
  }

  function go(r: SearchResult) {
    setOpen(false);
    setActive(-1);
    router.push(r.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const pick = active >= 0 ? results[active] : results[0];
      if (pick) {
        e.preventDefault();
        go(pick);
      }
    }
  }

  const trimmed = q.trim();
  const showKeepTyping = trimmed.length > 0 && trimmed.length < MIN_QUERY_LENGTH;

  return (
    <div className={styles.wrap}>
      <div className={styles.bar}>
        <IconSearch />
        <input
          className={styles.input}
          type="text"
          placeholder="Search…"
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="global-search-listbox"
          aria-autocomplete="list"
          aria-activedescendant={
            active >= 0 ? `global-search-opt-${active}` : undefined
          }
          aria-label="Search households, clients, deals and transfers"
          value={q}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setOpen(trimmed.length > 0)}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setOpen(false), 180);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      {open && (
        <div
          id="global-search-listbox"
          className={styles.results}
          role="listbox"
        >
          {loading && results.length === 0 ? (
            <div className={styles.note}>Searching…</div>
          ) : showKeepTyping ? (
            <div className={styles.note}>Keep typing…</div>
          ) : results.length === 0 ? (
            <div className={styles.note}>No matches</div>
          ) : (
            TYPE_ORDER.map((type) => {
              const group = results.filter((r) => r.type === type);
              if (group.length === 0) return null;
              return (
                <div key={type} className={styles.group}>
                  <div className={styles.groupHead}>{TYPE_LABEL[type]}</div>
                  {group.map((r) => {
                    const idx = results.indexOf(r);
                    return (
                      <button
                        key={`${r.type}:${r.id}`}
                        id={`global-search-opt-${idx}`}
                        ref={idx === active ? activeItemRef : undefined}
                        type="button"
                        role="option"
                        aria-selected={idx === active}
                        className={
                          idx === active
                            ? `${styles.item} ${styles.itemActive}`
                            : styles.item
                        }
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => go(r)}
                      >
                        <span className={styles.itemLabel}>{r.label}</span>
                        {r.sublabel && (
                          <span className={styles.itemSub}>{r.sublabel}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
