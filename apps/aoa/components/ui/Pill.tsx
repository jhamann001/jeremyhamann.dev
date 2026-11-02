import type { ReactNode } from "react";
import styles from "./Pill.module.css";

export const STATUS_TONES = ["ok", "caution", "attention", "danger", "info", "rollover", "blocked", "neutral"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];
export type PillTone = "green" | "gold" | "blue" | "amber" | "red" | "gray" | StatusTone;

export function isStatusTone(tone: string): tone is StatusTone {
  return (STATUS_TONES as readonly string[]).includes(tone);
}

export function Pill({ tone = "gray", dot = false, hue, children }: {
  tone?: PillTone; dot?: boolean; hue?: string; children: ReactNode;
}) {
  const hueClass = hue ? styles[`hue_${hue}`] : undefined;
  return (
    <span className={hueClass ? `${styles.pill} ${styles[tone]} ${hueClass}` : `${styles.pill} ${styles[tone]}`}
      data-tone={isStatusTone(tone) ? tone : undefined} data-hue={hue}>
      {dot && <span className={styles.dot} />}
      {children}
    </span>
  );
}
