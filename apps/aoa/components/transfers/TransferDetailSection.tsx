import type { ReactNode } from "react";
import styles from "./TransferDetailSection.module.css";

/** Native disclosure: closing it hides, but never unmounts, draft controls. */
export function TransferDetailSection({
  id,
  title,
  description,
  meta,
  initiallyOpen = false,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  meta?: string;
  initiallyOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details id={id} className={styles.section} open={initiallyOpen}>
      <summary className={styles.summary}>
        <span className={styles.heading}>
          <span className={styles.title}>{title}</span>
          {description && <span className={styles.description}>{description}</span>}
        </span>
        {meta && <span className={styles.meta}>{meta}</span>}
        <span className={styles.chevron} aria-hidden="true">⌄</span>
      </summary>
      <div className={styles.content}>{children}</div>
    </details>
  );
}
