"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { HouseholdActivity } from "@/lib/data/types";
import type { HouseholdHistoryPage } from "@/lib/data/household-history";
import { utcDateLabel } from "@/lib/display-date";
import { householdHistoryLocation } from "@/lib/navigation/household-history-query";
import { useProgressiveList } from "@/components/navigation/useProgressiveList";
import { ProgressiveListControls } from "@/components/navigation/ProgressiveListControls";
import { Card, CardHeader, CardBody } from "@/components/ui";
import styles from "./ActivityCard.module.css";

const EMPTY_META = { openCount: 0, completedCount: 0 };

function ActivityRow({ item }: { item: HouseholdActivity }) {
  const when = item.activity_at ?? item.source_modified_at;
  const meta = [item.owner_name, utcDateLabel(when)].filter(Boolean).join(" · ");
  return (
    <li className={styles.row} data-list-row-id={item.sf_id}>
      <div className={styles.head}>
        <span className={styles.subject}>{item.subject ?? "Call"}</span>
      </div>
      {meta ? <div className={styles.meta}>{meta}</div> : null}
      {item.note ? <p className={styles.note}>{item.note}</p> : null}
    </li>
  );
}

export function ActivityCard({ initialPage, householdId, scope }: {
  initialPage: HouseholdHistoryPage<"activity">; householdId: string; scope: string;
}) {
  const pathname = usePathname();
  const search = useSearchParams();
  const { href, historyHref } = householdHistoryLocation(pathname, search.toString(), "activity");
  const state = useProgressiveList({ initialPage, scope, href, historyHref,
    endpoint: `/api/navigation/household-activity?${new URLSearchParams({ household: householdId })}`,
    rowIdKey: "sf_id", emptyMeta: EMPTY_META, scrollSelector: "[data-history-scroll='activity']" });

  return (
    <div ref={state.rootRef} data-history-list="activity" data-list-ready={state.ready}>
    <Card>
      <CardHeader>
        <h2>Activity &amp; notes</h2>
        <span className={styles.count}>
          {state.page.total} {state.page.total === 1 ? "call" : "calls"}
        </span>
      </CardHeader>
      <CardBody>
        <p className={styles.sub}>Household-level call activity from CRM.</p>

        {state.loadState === "idle" && state.page.total === 0 ? (
          <p className={styles.empty}>No activity on file.</p>
        ) : null}
          <div className={styles.scroll} data-history-scroll="activity">
            <ul className={styles.list}>
              {state.page.rows.map((item) => (
                <ActivityRow key={item.sf_id} item={item} />
              ))}
            </ul>
            <ProgressiveListControls state={state} label="Calls" href={href} />
          </div>
      </CardBody>
    </Card>
    </div>
  );
}
