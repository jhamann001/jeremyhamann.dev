"use client";

import {
  DEAL_STAGES,
  stageLabel,
  type DealStage,
} from "@/lib/data/deal-types";
import type { StageFilter } from "./deal-filter";
import styles from "./DealFilters.module.css";

// Controlled filter strip for the deals table (HouseholdsTable chip/search
// idiom): free-text search over client / household / deal name (owner left
// the search targets in D6, WO ticket), plus stage chips in pipeline order
// with per-stage counts. DealsTable owns the state; this component just
// renders it.
// D7 (WO ticket): an optional trailing "Removed" chip — rendered ONLY when
// the `removed` prop is passed (the page passes it for ADMIN + OPERATIONS
// only; other roles get the exact pre-D7 strip). Selecting it swaps the table
// to the archived list; selecting any stage chip returns to the pipeline.

const CHIPS: { key: StageFilter; label: string }[] = [
  { key: "all", label: "All" },
  ...DEAL_STAGES.map((s: DealStage) => ({
    key: s as StageFilter,
    label: stageLabel(s),
  })),
  { key: "no_statements", label: "Missing statements" },
];

export function DealFilters({
  query,
  stage,
  counts,
  onQueryChange,
  onStageChange,
  removed,
}: {
  query: string;
  stage: StageFilter;
  counts: Record<StageFilter, number>;
  onQueryChange: (q: string) => void;
  onStageChange: (s: StageFilter) => void;
  /** D7 Removed chip (ADMIN + OPERATIONS only — absent for everyone else). */
  removed?: { count: number; active: boolean; onSelect: () => void } | null;
}) {
  return (
    <>
      <input
        className={styles.search}
        type="search"
        maxLength={256}
        placeholder="Search client, household, firm or funding type…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        aria-label="Search deals"
      />
      <div className={styles.chips} role="group" aria-label="Filter by stage">
        {CHIPS.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={`${styles.chip} ${!removed?.active && stage === chip.key ? styles.chipActive : ""}`.trim()}
            onClick={() => onStageChange(chip.key)}
            aria-pressed={!removed?.active && stage === chip.key}
          >
            {chip.label}{" "}
            <span className={styles.chipCount}>{counts[chip.key]}</span>
          </button>
        ))}
        {removed && (
          <button
            type="button"
            className={`${styles.chip} ${removed.active ? styles.chipActive : ""}`.trim()}
            onClick={removed.onSelect}
            aria-pressed={removed.active}
          >
            Removed{" "}
            <span className={styles.chipCount}>{removed.count}</span>
          </button>
        )}
      </div>
    </>
  );
}
