import type { ReactNode } from "react";
import styles from "./SummaryGrid.module.css";

export function SummaryGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}
