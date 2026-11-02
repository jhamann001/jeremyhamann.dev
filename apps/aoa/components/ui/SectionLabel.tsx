import type { ReactNode } from "react";
import styles from "./SectionLabel.module.css";

export function SectionLabel({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`${styles.label} ${className}`.trim()}>{children}</div>;
}
