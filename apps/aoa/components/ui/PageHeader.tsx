import type { ReactNode } from "react";
import { SectionLabel } from "./SectionLabel";
import styles from "./PageHeader.module.css";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.copy}>
        <SectionLabel>{eyebrow}</SectionLabel>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
