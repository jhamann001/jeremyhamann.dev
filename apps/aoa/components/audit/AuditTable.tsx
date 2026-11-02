"use client";

import { useState } from "react";
import { Pill, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import type { AuditLogRow } from "@/lib/data/audit-log";
import { actionTone, ingestActionLabel } from "./audit-tone";
import { formatDetail } from "./audit-detail";
import { fmtDateOnly, fmtWhen, relTime } from "./audit-time";
import styles from "./AuditTable.module.css";

// The Events view collapses every ingest run of a type into ONE daily summary
// row (kind === "ingest_day"); those render as a friendly labelled line with
// row/run counts instead of a raw single event. Everything else (kind ===
// "event") renders exactly as before.
function IngestDayRow({ row }: { row: AuditLogRow }) {
  const rows = row.upserted.toLocaleString();
  const runs = `${row.runCount.toLocaleString()} ${row.runCount === 1 ? "run" : "runs"}`;
  return (
    <TR data-list-row-id={row.id}>
      <TD className={styles.nowrap}>
        <div className={styles.strong}>{fmtWhen(row.at)}</div>
        <div className={styles.sub}>Daily rollup</div>
      </TD>
      <TD>
        <div className={styles.strong}>{row.actorEmail ?? "system"}</div>
        <div className={styles.sub}>{row.actorRole ?? "—"}</div>
      </TD>
      <TD className={styles.nowrap}>
        <Pill tone="gold" dot>
          {ingestActionLabel(row.action)}
        </Pill>
        <span className={styles.rollup} title="One row per ingest type per day">
          rollup
        </span>
      </TD>
      <TD>
        <div className={styles.strong}>{row.entityType ?? "—"}</div>
      </TD>
      <TD className={styles.detailCell}>
        <span className={styles.summary}>
          {rows} rows<span className={styles.summaryMuted}> · {runs}</span>
          {row.rejected > 0 && (
            <span className={styles.summaryMuted}>
              {" "}
              · {row.rejected.toLocaleString()} rejected
            </span>
          )}
          {row.sourceAsOfMax && (
            <span className={styles.summaryMuted}>
              {" "}
              · source through {fmtDateOnly(row.sourceAsOfMax)}
            </span>
          )}
        </span>
      </TD>
    </TR>
  );
}

// The Activity-audit table (WO ticket) — REAL rows from audit."AuditLog",
// mockup §5 columns (When / User / Action / Entity / Detail). Client component
// only for the row-local detail expand; rows arrive fully serialized from the
// seam (id string, at ISO). The relative-time sub-line is wall-clock dependent,
// so it carries suppressHydrationWarning — SSR and hydration run milliseconds
// apart and may disagree on "just now" vs "1m ago".

export function AuditTable({ rows, expandedIds, onToggle }: {
  rows: AuditLogRow[]; expandedIds?: string[]; onToggle?: (id: string) => void;
}) {
  const [localExpanded, setExpanded] = useState<Set<string>>(new Set());
  const expanded = expandedIds ? new Set(expandedIds) : localExpanded;

  const toggle = (id: string) => onToggle ? onToggle(id) :
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={styles.scroll}>
      <Table>
        <THead>
          <TR>
            <TH>When</TH>
            <TH>User</TH>
            <TH>Action</TH>
            <TH>Entity</TH>
            <TH>Detail</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => {
            if (row.kind === "ingest_day") {
              return <IngestDayRow key={row.id} row={row} />;
            }
            const detail = formatDetail(row.detail);
            const open = expanded.has(row.id);
            return (
              <TR key={row.id} data-list-row-id={row.id}>
                <TD className={styles.nowrap}>
                  <div className={styles.strong}>{fmtWhen(row.at)}</div>
                  <div className={styles.sub} suppressHydrationWarning>
                    {relTime(row.at)}
                  </div>
                </TD>
                <TD>
                  <div className={styles.strong}>{row.actorEmail ?? "system"}</div>
                  <div className={styles.sub}>{row.actorRole ?? "—"}</div>
                </TD>
                <TD className={styles.nowrap}>
                  <Pill tone={actionTone(row.action)} dot>
                    {row.action}
                  </Pill>
                </TD>
                <TD>
                  <div className={styles.strong}>{row.entityType ?? "—"}</div>
                  {row.entityId && <div className={styles.sub}>{row.entityId}</div>}
                </TD>
                <TD className={styles.detailCell}>
                  <div className={styles.detailRow}>
                    <span className={styles.detailText}>{detail.preview}</span>
                    {detail.expandable && (
                      <button
                        type="button"
                        className={styles.expand}
                        onClick={() => toggle(row.id)}
                        aria-expanded={open}
                        aria-label={`${open ? "Collapse" : "Expand"} detail for event ${row.id}`}
                      >
                        {open ? "Collapse" : "Expand"}
                      </button>
                    )}
                  </div>
                  {open && detail.full && <pre className={styles.pre}>{detail.full}</pre>}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
