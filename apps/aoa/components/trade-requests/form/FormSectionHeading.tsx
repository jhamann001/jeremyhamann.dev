import type { ReactNode } from "react";
import { SectionLabel } from "@/components/ui";
import styles from "./NewRequestForm.module.css";

export type NewRequestSectionProps = { number: number; title: string };

export function FormSectionHeading({ number, title, actions }: NewRequestSectionProps & { actions?: ReactNode }) {
  return (
    <div className={styles.sectionHead}>
      <SectionLabel><h3 id={`new-request-section-${number}`} className={styles.sectionTitle}>{number}. {title}</h3></SectionLabel>
      {actions}
    </div>
  );
}
