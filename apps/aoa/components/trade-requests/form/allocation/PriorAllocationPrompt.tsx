"use client";

import { useEffect } from "react";
import { loadPriorAllocation } from "@/app/(authenticated)/trade-requests/new/actions";
import { Button } from "@/components/ui";
import {
  ALLOCATION_COPY,
  previousAllocationLoading,
  previousAllocationPromptVisible,
  priorAllocationClientId,
  priorAllocationKey,
  priorAllocationSummary,
  withPreviousAllocationApplied,
  withPreviousAllocationDeclined,
  withPriorAllocationLoaded,
  withPriorAllocationTarget,
} from "@/lib/trade-requests/new-request-allocation";
import { useNewRequestDraft } from "../NewRequestDraft";
import styles from "./Allocation.module.css";

/**
 * Loads the first selected client's prior allocation whenever the trade type,
 * the first client or manual entry changes. The key is kept on the draft, so a
 * remounted form neither reloads nor resets the answer.
 */
export function usePriorAllocationLoader() {
  const { draft, updateDraft } = useNewRequestDraft();
  const key = priorAllocationKey(draft);
  const loaded = draft.priorAllocation.key;
  const clientId = priorAllocationClientId(draft, key);

  useEffect(() => {
    if (key === loaded) return;
    updateDraft((current) => withPriorAllocationTarget(current, key));
    if (!clientId) return;
    loadPriorAllocation(clientId)
      .then((allocation) => updateDraft((current) => withPriorAllocationLoaded(current, key, allocation)))
      .catch(() => updateDraft((current) => withPriorAllocationLoaded(current, key, null)));
  }, [key, loaded, clientId, updateDraft]);
}

/** Unnumbered: the loading announcement, then the prompt while unanswered (Rebalance and Cash Deposit, new requests). */
export function PriorAllocationPrompt() {
  const { draft, updateDraft } = useNewRequestDraft();
  const prior = draft.priorAllocation.allocation;
  if (previousAllocationLoading(draft)) {
    return <p className={styles.srOnly} role="status" aria-live="polite">{ALLOCATION_COPY.priorLoading}</p>;
  }
  if (!previousAllocationPromptVisible(draft) || !prior) return null;
  return (
    <div className={styles.prompt} role="region" aria-labelledby="new-request-prior-allocation">
      <p id="new-request-prior-allocation" className={styles.promptLead}>{ALLOCATION_COPY.priorOnFile}</p>
      <p className={styles.promptSummary}>{priorAllocationSummary(prior)}</p>
      <div className={styles.promptActions}>
        <Button onClick={() => updateDraft(withPreviousAllocationApplied)}>{ALLOCATION_COPY.usePrevious}</Button>
        <Button variant="ghost" onClick={() => updateDraft(withPreviousAllocationDeclined)}>{ALLOCATION_COPY.startFresh}</Button>
      </div>
    </div>
  );
}
