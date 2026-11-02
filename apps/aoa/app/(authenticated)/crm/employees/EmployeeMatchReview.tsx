"use client";

import { useActionState } from "react";
import { Pill } from "@/components/ui";
import type { EmployeeContactSearchState } from "./actions";
import { saveEmployeeContactDecision, searchEmployeeContacts } from "./actions";
import styles from "./page.module.css";

type Props = {
  uploadId: string;
  entryId: string;
  employeeName: string;
  initialState: EmployeeContactSearchState;
};

export function EmployeeMatchReview({
  uploadId,
  entryId,
  employeeName,
  initialState,
}: Props) {
  const [state, searchAction, pending] = useActionState(searchEmployeeContacts, initialState);

  const decisionForm = (
    candidate: EmployeeContactSearchState["candidates"][number],
    decision: "CONFIRMED" | "REJECTED",
    label: string,
  ) => (
    <form action={saveEmployeeContactDecision}>
      <input type="hidden" name="uploadId" value={uploadId} />
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="crmId" value={candidate.crmId} />
      <input type="hidden" name="clientSfId" value={candidate.clientSfId} />
      <input type="hidden" name="decision" value={decision} />
      <button className={decision === "REJECTED" ? styles.rejectButton : "btn"} type="submit">
        {label}
      </button>
    </form>
  );

  const candidateRow = (
    candidate: EmployeeContactSearchState["candidates"][number],
    previousRejection = false,
  ) => (
    <div className={styles.candidate} key={candidate.crmId}>
      <div>
        <strong>{candidate.displayName}</strong>
        <span>{candidate.householdName ?? "No household"}</span>
        <div className={styles.candidatePills}>
          {candidate.exactName
            ? <Pill tone="amber">Exact-name suggestion</Pill>
            : <Pill tone="gray">Search result</Pill>}
          {previousRejection ? <Pill tone="gray">Previously rejected</Pill> : null}
          {candidate.decision === "CONFIRMED" ? <Pill tone="green">confirmed</Pill> : null}
        </div>
      </div>
      <div className={styles.actions}>
        {decisionForm(
          candidate,
          "CONFIRMED",
          previousRejection ? "Reverse rejection and confirm" : "Confirm contact",
        )}
        {!previousRejection && candidate.decision !== "CONFIRMED"
          ? decisionForm(candidate, "REJECTED", "Not this contact")
          : null}
      </div>
    </div>
  );

  return (
    <>
      <form action={searchAction} className={styles.searchForm}>
        <input type="hidden" name="entryId" value={entryId} />
        <label>
          <span>Search CRM contacts</span>
          <input name="query" defaultValue={state.query || employeeName} minLength={2} maxLength={120} required />
        </label>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? "Searching…" : "Search"}
        </button>
      </form>
      {state.error ? <p className={styles.noMatches}>{state.error}</p> : null}
      {!state.error && state.candidates.length === 0 ? (
        <p className={styles.noMatches}>No matching CRM contacts found.</p>
      ) : (
        <div className={styles.candidates}>{state.candidates.map((candidate) => candidateRow(candidate))}</div>
      )}
      {state.previousRejections.length > 0 ? (
        <div className={styles.previousRejections}>
          <h3>Previous rejections</h3>
          <p className={styles.hint}>These contacts stay suppressed unless you explicitly reverse the prior decision.</p>
          <div className={styles.candidates}>
            {state.previousRejections.map((candidate) => candidateRow(candidate, true))}
          </div>
        </div>
      ) : null}
    </>
  );
}
