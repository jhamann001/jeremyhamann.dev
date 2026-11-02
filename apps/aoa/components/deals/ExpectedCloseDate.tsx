import type { DealStage } from "@/lib/data/deal-types";
import { expectedCloseDay, isExpectedCloseOverdue } from "@/lib/deals/expected-close";
import styles from "./ExpectedCloseDate.module.css";

/** Clock-free so a server-supplied date snapshot also stays stable across a
 * client boundary. Both deal cards use the same date label and overdue cue. */
export function ExpectedCloseDate({
  date,
  stage,
  todayEt,
}: {
  date: Date | null;
  stage: DealStage;
  todayEt: string;
}) {
  const day = expectedCloseDay(date);
  if (day == null) return <>—</>;
  const overdue = isExpectedCloseOverdue(stage, date, todayEt);
  const label = new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <span className={`${styles.date}${overdue ? ` ${styles.overdue}` : ""}`}>
      <time dateTime={day}>{label}</time>
      {overdue ? <span> · Overdue</span> : null}
    </span>
  );
}
