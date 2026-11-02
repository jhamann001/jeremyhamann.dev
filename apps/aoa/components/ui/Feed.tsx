import type { ReactNode } from "react";
import styles from "./Feed.module.css";

// Timeline feed: a left rule with a kind-colored dot per item (TDD §5).
// `kind` maps to a tone class; unknown kinds fall back to a neutral dot.

const KIND_CLASS: Record<string, string> = {
  note: styles.note,
  task: styles.task,
  event: styles.event,
  email: styles.email,
  alert: styles.alert,
};

export function FeedItem({
  kind,
  time,
  title,
  desc,
}: {
  kind: string;
  time: string;
  // ReactNode so callers can decorate the title (e.g. the Command Center's
  // signal role badge pill, ticket) — plain strings still work everywhere.
  title: ReactNode;
  desc: ReactNode;
}) {
  return (
    <li className={styles.item}>
      <span className={`${styles.dot} ${KIND_CLASS[kind] ?? ""}`.trim()} aria-hidden="true" />
      <div className={styles.content}>
        <div className={styles.head}>
          <span className={styles.title}>{title}</span>
          <span className={styles.time}>{time}</span>
        </div>
        <p className={styles.desc}>{desc}</p>
      </div>
    </li>
  );
}

export function Feed({ children }: { children: ReactNode }) {
  return <ul className={styles.feed}>{children}</ul>;
}
