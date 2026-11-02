"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/workflow";
import styles from "./AuditFilters.module.css";

// Filter strip for the Audit Log (WO ticket): action type + actor email.
// Server-side filtering — the selects only rewrite the URL query (house Select
// reuse, workflow/Select.tsx); the server component re-queries the seam with
// the new params. Option lists are the seam's DISTINCT vocabularies, so both
// dropdowns always reflect what actually exists in audit."AuditLog". Changing
// a filter drops `page` — page 3 of one filter is meaningless in another.

const ALL = "";

export function AuditFilters({
  actions,
  actors,
  action,
  actor,
  onChange,
}: {
  actions: string[];
  actors: string[];
  action: string;
  actor: string;
  onChange?: (key: "action" | "actor" | "table" | "op", value: string) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const apply = (key: "action" | "actor", value: string) => {
    if (onChange) { onChange(key, value); return; }
    const params = new URLSearchParams(searchParams);
    if (value === ALL) params.delete(key);
    else params.set(key, value);
    params.delete("page"); // filters reset pagination
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  return (
    <div className={styles.row} role="group" aria-label="Filter audit events">
      <label className={styles.field}>
        <span className={styles.label}>Action</span>
        <Select
          value={action}
          ariaLabel="Filter by action type"
          options={[
            { value: ALL, label: "All actions" },
            ...actions.map((a) => ({ value: a, label: a })),
          ]}
          onChange={(v) => apply("action", v)}
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
