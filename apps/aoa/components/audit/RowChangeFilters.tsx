"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/workflow";
import styles from "./AuditFilters.module.css";

// Filter strip for the Field-changes audit view (tkt-audit-row-change-ui):
// table + op + actor. Server-side filtering — the selects only rewrite the URL
// query (house Select reuse); the server component re-queries listRowChanges
// with the new params. Option lists are the seam's DISTINCT vocabularies, so
// every dropdown reflects what actually exists in audit.row_change. Changing a
// filter drops `page` (a page index is meaningless across filters) but PRESERVES
// `view=changes` so the toggle stays on this view. Mirrors AuditFilters.

const ALL = "";

export function RowChangeFilters({
  tables,
  ops,
  actors,
  table,
  op,
  actor,
  onChange,
}: {
  tables: string[];
  ops: string[];
  actors: string[];
  table: string;
  op: string;
  actor: string;
  onChange?: (key: "action" | "actor" | "table" | "op", value: string) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const apply = (key: "table" | "op" | "actor", value: string) => {
    if (onChange) { onChange(key, value); return; }
    const params = new URLSearchParams(searchParams);
    params.set("view", "changes"); // stay on this view
    if (value === ALL) params.delete(key);
    else params.set(key, value);
    params.delete("page"); // filters reset pagination
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <div className={styles.row} role="group" aria-label="Filter field changes">
      <label className={styles.field}>
        <span className={styles.label}>Table</span>
        <Select
          value={table}
          ariaLabel="Filter by table"
          options={[
            { value: ALL, label: "All tables" },
            ...tables.map((t) => ({ value: t, label: t })),
          ]}
          onChange={(v) => apply("table", v)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Operation</span>
        <Select
          value={op}
          ariaLabel="Filter by operation"
          options={[
            { value: ALL, label: "All operations" },
            ...ops.map((o) => ({ value: o, label: o })),
          ]}
          onChange={(v) => apply("op", v)}
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Actor</span>
        <Select
          value={actor}
          ariaLabel="Filter by actor email"
          options={[
            { value: ALL, label: "All actors" },
            ...actors.map((a) => ({ value: a, label: a })),
          ]}
          onChange={(v) => apply("actor", v)}
        />
      </label>
    </div>
  );
}
