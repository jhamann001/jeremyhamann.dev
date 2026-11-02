import { Button, Pill } from "@/components/ui";
import type { RunClientLink } from "@/lib/data/asset-map-client-link-contract";
import {
  CLIENT_LINK_COPY,
  LINK_SUMMARY_COPY,
  canRetryLookup,
  clientLinkDate,
  holderConflicts,
  linkMethodView,
  linkSummaryPeople,
  lookupNotice,
  reviewStateTone,
  suggestionView,
  type FailureView,
} from "./client-link-model";
import { ClientLinkErrorNotice, DirectoryNotice, HolderConflictNotice, PersonId } from "./ClientLinkNotices";
import styles from "./ClientLinking.module.css";

const ACTIVITY_LIMIT = 5;

export type HouseholdLinkCardProps = {
  run: RunClientLink | null;
  failure: FailureView | null;
  canReview: boolean;
  /** Defaults to `!canReview`; false for a read-only role while writes are on. */
  writesDisabled?: boolean;
  busy: boolean;
  onRetryLoad: () => void;
  onRetryLookup: () => void;
  onReview: () => void;
  onViewChange: (batchId: string) => void;
};

export function HouseholdLinkCard({ run, failure, canReview, writesDisabled = !canReview, busy, onRetryLoad, onRetryLookup, onReview, onViewChange }: HouseholdLinkCardProps) {
  const people = run?.identity.people ?? [];
  const suggestion = run && people.length === 0 ? suggestionView(run.lookup) : null;
  const conflicts = run ? holderConflicts(run) : null;
  const method = run ? linkMethodView(run.identity) : null;
  return (
    <details className={styles.disclosure} data-link-card="">
      <summary className={styles.summary}>
        <strong>{LINK_SUMMARY_COPY.label}</strong>
        {run ? (
          <>
            <Pill tone={reviewStateTone(run.identity.review_state)}>{run.identity.review_state}</Pill>
            <span className={styles.summaryText}>{linkSummaryPeople(run)}</span>
          </>
        ) : failure ? (
          <Pill tone="danger">{failure.title}</Pill>
        ) : (
          <span className={styles.muted}>{LINK_SUMMARY_COPY.loading}</span>
        )}
        <span className={styles.summaryHint}>{LINK_SUMMARY_COPY.showDetails}</span>
      </summary>
      <section className={styles.section}>
        <div className={styles.card} aria-label={CLIENT_LINK_COPY.cardTitle}>
          <div className={styles.cardHead}>
            <h2>{CLIENT_LINK_COPY.cardTitle}</h2>
          </div>
          <ClientLinkErrorNotice failure={failure} onRetry={onRetryLoad} />
          {!run && !failure ? <p className={styles.muted} aria-busy="true">{CLIENT_LINK_COPY.loadingRun}</p> : null}
          {run ? (
            <>
              {people.length > 0 ? (
                <div className={styles.people}>
                  {people.map((p) => (
                    <div key={p.user_id} className={styles.person}>
                      <strong>{p.display_name}</strong>
                      <PersonId person={p} />
                    </div>
                  ))}
                </div>
              ) : suggestion ? (
                <div>
                  <h3>{suggestion.title}</h3>
                  <div className={styles.people}>
                    {suggestion.people.map((p) => (
                      <div key={p.user_id}>
                        <strong>{p.display_name}</strong> <code>{p.user_id}</code>
                      </div>
                    ))}
                  </div>
                  {suggestion.evidence.map((e) => <p key={e} className={styles.muted}>{e}</p>)}
                </div>
              ) : (
                <p className={styles.muted}>{CLIENT_LINK_COPY.noLink}</p>
              )}
              {method ? (
                <div className={styles.muted} data-link-method={run.identity.method ?? "unknown"}>
                  {method.acceptedHere ? <div>{CLIENT_LINK_COPY.acceptedHere}</div> : null}
                  <div>{method.label}</div>
                </div>
              ) : null}
              {conflicts ? <HolderConflictNotice flags={conflicts} /> : null}
              <DirectoryNotice notice={lookupNotice(run.lookup)} />
            </>
          ) : null}
          <div className={styles.cardFoot}>
            {canReview && run ? (
              <div className={styles.actions}>
                {canRetryLookup(run.lookup.state) ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={onRetryLookup}>{CLIENT_LINK_COPY.retryLookup}</Button>
                ) : null}
                <Button size="sm" disabled={busy} onClick={onReview}>
                  {people.length > 0 ? CLIENT_LINK_COPY.manageLink : CLIENT_LINK_COPY.reviewLink}
                </Button>
              </div>
            ) : null}
            {writesDisabled ? <span className={styles.muted}>{CLIENT_LINK_COPY.writesDisabled}</span> : null}
          </div>
        </div>
        {canReview && run && run.events.length > 0 ? (
          <div className={styles.card} aria-label={CLIENT_LINK_COPY.activity}>
            <h3>{CLIENT_LINK_COPY.activity}</h3>
            {run.events.slice(0, ACTIVITY_LIMIT).map(({ event_id, batch_id, kind, actor, occurred_at, reason }) => (
              <div key={event_id} className={styles.activityRow}>
                <div>
                  <strong>{kind.replaceAll("_", " ")}</strong>
                  <div className={styles.muted}>{actor} · {clientLinkDate(occurred_at)}</div>
                  {reason ? <p>{reason}</p> : null}
                </div>
                {batch_id ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onViewChange(batch_id)}>
                    {CLIENT_LINK_COPY.viewChange}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </details>
  );
}
