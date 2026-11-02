import { Feed, FeedItem, Pill } from "@/components/ui";
import { auditNewestFirst } from "@/lib/trade-requests/detail-view";
import type { TradeRequestAuditEntry } from "@/lib/trade-requests/request-types";
import styles from "./RequestDetail.module.css";

function when(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString();
}

export function AuditTrail({ entries }: { entries: TradeRequestAuditEntry[] }) {
  const ordered = auditNewestFirst(entries);
  return (
    <Feed>
      {ordered.map((entry, index) => (
        <FeedItem
          key={entry.id ?? index}
          kind={index === 0 ? "event" : ""}
          time={when(entry.date)}
          title={
            <span className={styles.auditTitle}>
              {entry.action}
              {entry.channel === "aoa" && <span title="Made through Always-On Advice"><Pill tone="gray">AOA</Pill></span>}
            </span>
          }
          desc={<><span className={styles.auditPerson}>{entry.user}</span><br />{entry.notes}</>}
        />
      ))}
    </Feed>
  );
}
