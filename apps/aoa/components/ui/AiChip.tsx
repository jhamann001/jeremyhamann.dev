import type { ReactNode } from "react";
import styles from "./AiChip.module.css";

export function AiChip({ children = "AI" }: { children?: ReactNode }) {
  return <span className={styles.chip}>{children}</span>;
}
