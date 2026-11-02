"use client";

import { useState } from "react";
import Link from "next/link";
import { Pill, Table, THead, TBody, TR, TH, TD } from "@/components/ui";
import type { RowChangeRow } from "@/lib/data/row-changes";
import { opTone } from "./audit-tone";
import { summarizeChange } from "./row-change-detail";
import { fmtWhen, relTime } from "./audit-time";
import styles from "./RowChangeTable.module.css";

// The Field-changes table (tkt-audit-row-change-ui) — REAL rows from the
// DB-trigger trail audit.row_change. Columns: Time / Actor / Table / Op /
// Record / Changes. Client component for the row-local snapshot expand; rows
// arrive fully serialized from the seam (id string, at ISO, changed a plain
// object). The relative-time sub-line is wall-clock dependent, so it carries
// suppressHydrationWarning — SSR and hydration run milliseconds apart and may
// disagree on "just now" vs "1m ago". Mirrors AuditTable.

export function RowChangeTable({ rows, expandedIds, onToggle, onRecordNavigate }: {
  rows: RowChangeRow[]; expandedIds?: string[]; onToggle?: (id: string) => void; onRecordNavigate?: (href: string) => void;
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
            <TH>Time</TH>
            <TH>Actor</TH>
            <TH>Table</TH>
            <TH>Op</TH>
            <TH>Record</TH>
            <TH>Changes</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((row) => {
            const summary = summarizeChange(row.op, row.changed);
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
                  <div className={styles.sub}>
                    <Pill tone="gray">{row.actorRole ?? row.dbRole}</Pill>
                  </div>
                </TD>
                <TD className={styles.nowrap}>{row.table}</TD>
                <TD className={styles.nowrap}>
                  <Pill tone={opTone(row.op)} dot>
                    {row.op}
                  </Pill>
                </TD>
                <TD className={styles.nowrap}>
                  {row.rowPk == null ? (
                    <span className={styles.recordText}>—</span>
                  ) : row.table === "deal" ? (
                    <Link href={`/deals/${row.rowPk}`} className={styles.recordLink} prefetch={false} onClick={() => onRecordNavigate?.(`/deals/${row.rowPk}`)}>
                      {row.rowPk}
                    </Link>
                  ) : (
                    <span className={styles.recordText}>{row.rowPk}</span>
                  )}
                </TD>
                <TD className={styles.changesCell}>
                  {summary.kind === "updated" ? (
                    summary.fields.length === 0 ? (
                      <span className={styles.empty}>No field changes</span>
                    ) : (
                      <div className={styles.diffList}>
                        {summary.fields.map((f) => (
                          <div key={f.field} className={styles.diffRow}>
                            <span className={styles.field}>{f.field}</span>
                            <span className={styles.from}>{f.from}</span>
                            <span className={styles.arrow} aria-label="changed to">
                              →
                            </span>
                            <span className={styles.to}>{f.to}</span>
                          </div>
                        ))}
                      </div>
                    )
                  ) : (
                    <>
                      <div className={styles.snapshotRow}>
                        <span className={styles.snapshotLabel}>
                          {summary.kind === "created" ? "Created" : "Deleted"}
                        </span>
                        <span className={styles.count}>
                          {summary.fields.length}{" "}
                          {summary.fields.length === 1 ? "field" : "fields"}
                        </span>
                        {summary.fields.length > 0 && (
                          <button
                            type="button"
                            className={styles.expand}
                            onClick={() => toggle(row.id)}
                            aria-expanded={open}
                            aria-label={`${open ? "Collapse" : "Expand"} snapshot for change ${row.id}`}
                          >
                            {open ? "Collapse" : "Expand"}
                          </button>
                        )}
                      </div>
                      {open && summary.fields.length > 0 && (
                        <div className={styles.snapshotList}>
                          {summary.fields.map((f) => (
                            <div key={f.field} className={styles.snapshotField}>
                              <span className={styles.field}>{f.field}</span>
                              <span className={styles.snapshotValue}>{f.value}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </TD>
              </TR>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}
