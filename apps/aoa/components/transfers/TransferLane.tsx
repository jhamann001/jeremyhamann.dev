"use client";

import { useState } from "react";
import type { TransferBoardClientRow } from "@/lib/data/transfer-board-client";
import type { AcatChipMap } from "@/lib/data/acat-lane";
import {
  STAGE_GATES,
  stageLabel,
  compareByClientName,
  type SortDir,
  type TransferStage,
} from "@/lib/data/transfer-types";
import { TransferCard } from "./TransferCard";
import styles from "./TransferLane.module.css";

// One lifecycle lane (mockup `.lane`): header = stage label + its SOFT gate
// caption (STAGE_GATES — display-only here; ADR-2's audited transitions live
// on T3's detail route) + count chip (= rows in stage); body = cards, or the
// empty line (so a fresh DB still shows all three lanes with their gates).
//
// `chips` (transfer-centric board, step 1): an OPTIONAL link-id → chip map,
// keyed by BOTH tracker identities (record id + real UUID — see
// buildAcatChipMap). When present, a card whose transfer links a live-status
// ACAT by EITHER column gets a compact status chip — record id first (the
// primary link key), legacy UUID fallback, mirroring the detail page's read
// priority. Absent (the Suspense fallback / tracker-down path) → no chips, the
// lane renders identically to before.
export function TransferLane({
  stage,
  rows,
  chips,
  total,
  sortDirection,
  onSort,
  onRecordNavigate,
}: {
  stage: TransferStage;
  rows: TransferBoardClientRow[];
  chips?: AcatChipMap;
  total?: number;
  sortDirection?: SortDir | null;
  onSort?: (direction: SortDir) => void;
  onRecordNavigate?: (href: string) => void;
}) {
  // Per-lane, independent client-name sort (ticket). null = default board
  // order; first click → asc, click again flips to desc. Copy before sorting so
  // the `rows` prop is never mutated. The count/empty-state stay on `rows`
  // (sort reorders, never filters).
  const [localSortDir, setSortDir] = useState<SortDir | null>(null);
  const sortDir = sortDirection === undefined ? localSortDir : sortDirection;
  const sorted = sortDirection !== undefined ? rows : sortDir
    ? [...rows].sort(
        (a, b) => (sortDir === "asc" ? 1 : -1) * compareByClientName(a, b),
      )
    : rows;
  return (
    <section className={styles.lane} aria-label={`${stageLabel(stage)} lane`}>
      <div className={styles.head}>
        <div>
          <button
            type="button"
            className={`${styles.title} ${styles.sortBtn}`}
            aria-label={`Sort ${stageLabel(stage)} by client name${
              sortDir === "asc"
                ? ", ascending"
                : sortDir === "desc"
                  ? ", descending"
                  : ""
            }`}
            onClick={() =>
              onSort ? onSort(sortDir === "asc" ? "desc" : "asc") : setSortDir((d) => (d === "asc" ? "desc" : "asc"))
            }
          >
            {stageLabel(stage)}
            {sortDir === "asc" ? " ↑" : sortDir === "desc" ? " ↓" : ""}
          </button>
          <div className={styles.gate}>gate: {STAGE_GATES[stage]}</div>
        </div>
        <div className={styles.count}>{total ?? rows.length}</div>
      </div>
      {rows.length === 0 ? (
        <div className={styles.empty}>{total ? "This stage has more transfers to load." : "No transfers in this stage."}</div>
      ) : (
        sorted.map((row) => (
          <TransferCard
            key={row.id}
            row={row}
            onNavigate={onRecordNavigate}
            chip={
              (row.acat_record_id ? chips?.[row.acat_record_id] : undefined) ??
              (row.acat_transfer_id
                ? chips?.[row.acat_transfer_id]
                : undefined)
            }
          />
        ))
      )}
      {total !== undefined && rows.length > 0 ? <p style={{ fontSize: 12, color: "var(--muted)", padding: 8 }}>{rows.length} of {total} loaded</p> : null}
    </section>
  );
}
