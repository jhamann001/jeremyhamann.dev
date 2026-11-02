import type { ReactNode } from "react";
import styles from "./FieldList.module.css";

export type Field = { label: string; value: ReactNode };

// Label/value pairs rendered as a <dl> (label muted, value ink). Used for
// investment instructions, qualitative portrait fields, etc. (TDD §5).
export function FieldList({ items }: { items: Field[] }) {
  return (
    <dl className={styles.list}>
      {items.map((item) => (
        <div key={item.label} className={styles.row}>
          <dt className={styles.label}>{item.label}</dt>
          <dd className={styles.value}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
