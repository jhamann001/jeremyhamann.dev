"use client";

import { useEffect, useRef } from "react";
import { loadClientExclusions } from "@/app/(authenticated)/trade-requests/new/actions";
import {
  EXCLUSIONS_COPY,
  standingExclusionsFillKey,
  standingExclusionsText,
  withExclusionsNotice,
  withStandingExclusions,
  type ExclusionClient,
} from "@/lib/trade-requests/new-request-exclusions";
import { useNewRequestDraft } from "../NewRequestDraft";
import styles from "../NewRequestForm.module.css";
import noticeStyles from "./Exclusions.module.css";

/**
 * Fills the exclusion fields from the selected clients' standing lists when
 * the selected clients change on a new request, keeping typed-over text
 * (AC-90). Only the latest selection's answer is applied; a failed read
 * keeps the text and shows the prefill notice.
 */
export function useStandingExclusionsFill() {
  const { context, updateDraft } = useNewRequestDraft();
  const key = standingExclusionsFillKey(context);
  const sequence = useRef(0);

  useEffect(() => {
    const current = ++sequence.current;
    if (!key) {
      updateDraft((draft) => withExclusionsNotice(draft, null));
      return;
    }
    const clients = JSON.parse(key) as ExclusionClient[];
    const failed = () => {
      if (sequence.current === current) updateDraft((draft) => withExclusionsNotice(draft, EXCLUSIONS_COPY.prefillFailed));
    };
    loadClientExclusions(clients.map((client) => client.id))
      .then((result) => {
        if (!result.ok) return failed();
        if (sequence.current !== current) return;
        updateDraft((draft) => withStandingExclusions(draft, standingExclusionsText(result.data, clients), "fill"));
      })
      .catch(failed);
  }, [key, updateDraft]);
}

/** "Advisor Specific Exclusions" and "Client Requested Exclusions", after the ESG filters. */
export function ExclusionFields() {
  const { draft, updateDraft } = useNewRequestDraft();
  return (
    <>
      <div className={styles.grid2}>
        <div className={styles.field}>
          <label htmlFor="new-request-advisor-exclusions" className={styles.label}>{EXCLUSIONS_COPY.advisorExclusions}</label>
          <textarea
            id="new-request-advisor-exclusions" rows={3} placeholder={EXCLUSIONS_COPY.advisorPlaceholder}
            value={draft.advisorExclusions} onChange={(event) => updateDraft({ advisorExclusions: event.target.value, exclusionsNotice: null })}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="new-request-client-exclusions" className={styles.label}>{EXCLUSIONS_COPY.clientExclusions}</label>
          <textarea
            id="new-request-client-exclusions" rows={3} placeholder={EXCLUSIONS_COPY.clientPlaceholder}
            value={draft.clientExclusions} onChange={(event) => updateDraft({ clientExclusions: event.target.value, exclusionsNotice: null })}
          />
        </div>
      </div>
      {draft.exclusionsNotice && (
        <p className={noticeStyles.notice} role="status" data-testid="exclusions-notice">{draft.exclusionsNotice}</p>
      )}
    </>
  );
}
