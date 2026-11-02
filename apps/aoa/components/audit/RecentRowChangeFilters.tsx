"use client";

import { useId, useState } from "react";
import { auditDateRange } from "@/lib/navigation/audit-date-range";
import styles from "./AuditFilters.module.css";

export type RecentRowChangeQuery = { table: string; op: string; actor: string; from: string; to: string };
const EMPTY: RecentRowChangeQuery = { table: "", op: "", actor: "", from: "", to: "" };

/** Exact filters, with optional suggestions from only the currently loaded rows. */
export function RecentRowChangeFilters({ initial, tables, actors, pending, onApply }: {
  initial: RecentRowChangeQuery;
  tables: string[];
  actors: string[];
  pending: boolean;
  onApply(filters: RecentRowChangeQuery): void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const change = (key: keyof RecentRowChangeQuery, value: string) => {
    setDraft(current => ({ ...current, [key]: value })); setError("");
  };
  return <form aria-label="Filter field changes" noValidate onSubmit={event => {
    event.preventDefault();
    try { auditDateRange(draft.from, draft.to); }
    catch { setError("Choose valid UTC dates with From on or before Through."); return; }
    onApply({ ...draft, table: draft.table.trim(), actor: draft.actor.trim() });
  }}>
    <div className={styles.row}>
      <label className={styles.field}><span className={styles.label}>Table</span>
        <input className={styles.exactInput} aria-label="Filter by table" aria-describedby={`${id}-suggestions`}
          list={`${id}-tables`} maxLength={128} value={draft.table} placeholder="All tables"
          onChange={event => change("table", event.target.value)} />
        <datalist id={`${id}-tables`}>{tables.map(value => <option key={value} value={value} />)}</datalist>
      </label>
      <label className={styles.field}><span className={styles.label}>Operation</span>
        <select className={styles.exactInput} aria-label="Filter by operation" value={draft.op}
          onChange={event => change("op", event.target.value)}>
          <option value="">All operations</option>
          {["INSERT", "UPDATE", "DELETE"].map(value => <option key={value}>{value}</option>)}
        </select>
      </label>
      <label className={styles.field}><span className={styles.label}>Actor</span>
        <input className={styles.exactInput} aria-label="Filter by actor email" aria-describedby={`${id}-suggestions`}
          list={`${id}-actors`} maxLength={254} value={draft.actor} placeholder="All actors"
          onChange={event => change("actor", event.target.value)} />
        <datalist id={`${id}-actors`}>{actors.map(value => <option key={value} value={value} />)}</datalist>
      </label>
      <label className={styles.field}><span className={styles.label}>From (UTC)</span>
        <input className={styles.exactInput} type="date" aria-label="From date (UTC)" value={draft.from}
          onChange={event => change("from", event.target.value)} />
      </label>
      <label className={styles.field}><span className={styles.label}>Through (UTC)</span>
        <input className={styles.exactInput} type="date" aria-label="Through date (UTC)" value={draft.to}
          onChange={event => change("to", event.target.value)} />
      </label>
      <button type="submit" disabled={pending}>{pending ? "Applying…" : "Apply filters"}</button>
      <button type="button" disabled={pending || !Object.values(draft).some(Boolean)} onClick={() => {
        setDraft(EMPTY); setError(""); onApply(EMPTY);
      }}>Clear filters</button>
      <button type="button" disabled={pending || (!draft.from && !draft.to)} onClick={() => {
        const next = { ...draft, from: "", to: "" };
        setDraft(next); setError(""); onApply(next);
      }}>Clear dates</button>
    </div>
    <p id={`${id}-suggestions`} className={styles.hint}>Table and actor match exactly. Suggestions come only from loaded rows, not the full history. Both dates are inclusive in UTC.</p>
    {error ? <p role="alert">{error}</p> : null}
  </form>;
}
