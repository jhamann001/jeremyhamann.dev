"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { loadTransferPreparation } from "@/app/(authenticated)/acat-tracking/preparation-actions";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import {
  resolveTransferPreparation,
  type PreparationChoices,
} from "@/lib/transfers/transfer-preparation";
import styles from "./TransferPreparationPanel.module.css";
import { TransferFormPanel } from "./TransferFormPanel";

type LoadResult = Awaited<ReturnType<typeof loadTransferPreparation>>;

const failureCopy = {
  forbidden: "You don't have access to review transfer requirements.",
  invalid: "This transfer record cannot be reviewed.",
  not_found: "This transfer record is no longer available in the Tracker.",
  unavailable: "Transfer requirements are unavailable. Try refreshing the source.",
} as const;

function sourceTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Not available" : date.toLocaleString();
}

function PreparationReview({ recordId }: { recordId: string }) {
  const [result, setResult] = useState<LoadResult | null>(null);
  const [choices, setChoices] = useState<PreparationChoices>({});
  const request = useRef(0);
  const id = useId();

  const refresh = useCallback(async () => {
    const current = ++request.current;
    // A failed refresh must not leave an earlier recommendation looking current.
    setResult(null);
    setChoices({});
    try {
      const next = await loadTransferPreparation(recordId);
      if (request.current === current) setResult(next);
    } catch {
      if (request.current === current) setResult({ ok: false, reason: "unavailable" });
    }
  }, [recordId]);

  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
  }, [refresh]);

  const preparation = result?.ok
    ? resolveTransferPreparation(result.context, choices)
    : null;

  return (
    <div className={styles.body}>
      <p className={styles.intro}>Optional planning preview. Explore requirements and proposed tasks here; these choices are unsaved. Prepare the actual paperwork in Prepare transfer form above.</p>
      {result === null ? (
        <p role="status">Checking the transfer and custodian library…</p>
      ) : !result.ok ? (
        <div role="alert">
          <p>{failureCopy[result.reason]}</p>
          {result.reason === "unavailable" && <button className={styles.refresh} type="button" onClick={() => void refresh()}>Refresh source</button>}
        </div>
      ) : preparation ? (
        <>
          <div className={styles.toolbar}>
            <span className={styles.checked}>Source checked <time dateTime={result.checkedAt}>{sourceTime(result.checkedAt)}</time></span>
            <button className={styles.refresh} type="button" onClick={() => void refresh()}>Refresh source</button>
          </div>
          <span className={styles.status}>Review required</span>
          <dl className={styles.facts}>
            <div><dt>Custodian recorded in Tracker</dt><dd>{preparation.custodianMatch.recordedName || "Not recorded"}</dd></div>
            <div><dt>Direction</dt><dd>{preparation.direction === "INCOMING" ? "Incoming" : preparation.direction === "OUTGOING" ? "Outgoing" : "Not confirmed"}</dd></div>
            <div><dt>Transfer scope</dt><dd>{preparation.scope === "FULL" ? "Full" : preparation.scope === "PARTIAL" ? "Partial" : "Not confirmed"}</dd></div>
          </dl>
          <label className={styles.field} htmlFor={`${id}-custodian`}>
            Custodian for this draft
            <select id={`${id}-custodian`} value={choices.custodianId ?? ""} onChange={(event) => setChoices(event.target.value ? { custodianId: event.target.value } : {})}>
              <option value="">{preparation.custodianMatch.status === "MATCHED" && !choices.custodianId
                ? `Use recorded custodian: ${preparation.custodianMatch.selected?.name}`
                : "Use the recorded custodian match"}</option>
              {result.context.library.custodians.map((custodian) => <option key={custodian.id} value={custodian.id}>{custodian.name}</option>)}
            </select>
            <span className={styles.fieldHint}>Changing this selection does not update or confirm the Tracker entry.</span>
          </label>
          {preparation.candidateWorkflows.length > 1 ? (
            <label className={styles.field} htmlFor={`${id}-workflow`}>
              Form route for this draft
              <select id={`${id}-workflow`} value={choices.workflowId ?? ""} onChange={(event) => setChoices((current) => ({ ...current, workflowId: event.target.value || undefined }))}>
                <option value="">Choose a route to review</option>
                {preparation.candidateWorkflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.displayName}</option>)}
              </select>
              <span className={styles.fieldHint}>Choose only after reviewing the account and custodian requirements.</span>
            </label>
          ) : null}

          <div className={styles.form}>
            <h3>Form to review</h3>
            {preparation.selectedForm ? (
              <>
                <p><strong>{preparation.selectedForm.name}</strong></p>
                {preparation.selectedWorkflow && <p className={styles.muted}>{preparation.selectedWorkflow.displayName}</p>}
                <p className={styles.muted}>{preparation.selectedForm.support === "MANUAL_ONLY"
                  ? "Manual preparation required. Follow the current custodian instructions after review."
                  : "Use Prepare transfer form above to review the saved transfer and generate paperwork."}</p>
              </>
            ) : <p className={styles.muted}>No form selected. Resolve the route and missing information before preparing paperwork.</p>}
          </div>

          <h4>Information and confirmations needed</h4>
          <ul className={styles.list}>
            {preparation.reviewItems.map((item) => <li key={item.code}>{item.message}</li>)}
          </ul>

          <details className={styles.subdisclosure}>
            <summary>Proposed tasks · {preparation.proposedTasks.length} · unsaved</summary>
            <p className={styles.muted}>Review this plan with CS and Operations. No tasks have been created or assigned.</p>
            <ul className={styles.tasks}>
              {preparation.proposedTasks.map((task) => (
                <li key={task.id}>
                  <div className={styles.taskTop}><span className={styles.owner}>{task.owner}</span><strong>{task.title}</strong></div>
                  <p>{task.detail}</p>
                </li>
              ))}
            </ul>
          </details>
          <details className={styles.subdisclosure}>
            <summary>Source requirements and notes</summary>
            <p className={styles.muted}>Custodian library wording is shown as recorded. Conditional requirements still need review for this transfer.</p>
            <p className={styles.checked}>Library retrieved <time dateTime={preparation.libraryRetrievedAt}>{sourceTime(preparation.libraryRetrievedAt)}</time> · Custodian review status: {preparation.custodianReviewStatus || "Not recorded"}</p>
            <dl className={styles.source}>
              {preparation.sourceRequirements.map((requirement) => <div key={requirement.field}><dt>{requirement.label}</dt><dd>{requirement.value || "Not recorded"}</dd></div>)}
            </dl>
            <ul className={styles.list}>{preparation.cautions.map((caution) => <li key={caution}>{caution}</li>)}</ul>
          </details>
        </>
      ) : null}
      <div className={styles.links}>
        <a href="/acat-tracking?view=library">Custodian library and fees</a>
        <a href={EXTERNAL_APPS.acatTracking} target="_blank" rel="noopener noreferrer">Open Transfer Tracker ↗</a>
      </div>
    </div>
  );
}

function PreparationDisclosure({ recordId }: { recordId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.disclosure} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={styles.summary}>Review transfer requirements</summary>
      {open ? <PreparationReview recordId={recordId} /> : null}
    </details>
  );
}

/** Load on expansion; each record has its own closed disclosure and draft state.
 * Closing discards the unsaved draft and reopening checks the source again. */
export function TransferPreparationPanel({ recordId, onScopeChanged }: { recordId: string; onScopeChanged?: (scope: "FULL" | "PARTIAL") => void }) {
  const [previewVersion, setPreviewVersion] = useState(0);
  const handleScopeChanged = useCallback((scope: "FULL" | "PARTIAL") => {
    setPreviewVersion((version) => version + 1);
    onScopeChanged?.(scope);
  }, [onScopeChanged]);
  return <>
    <TransferFormPanel key={`form-${recordId}`} recordId={recordId} onScopeChanged={handleScopeChanged} />
    <PreparationDisclosure key={`preview-${recordId}-${previewVersion}`} recordId={recordId} />
  </>;
}
