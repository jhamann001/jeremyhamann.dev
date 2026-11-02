"use client";

import {
  FUNDING_TYPES,
  FUNDING_TYPE_ETA,
  FUNDING_TYPE_LABEL,
  type FundingType,
} from "@/lib/data/transfer-types";
import { useOptionalTransferPlanDraft } from "./TransferPlanDraftProvider";
import styles from "./FundingTypeControl.module.css";

// The Funding Type <select> for the Full Funding Picture (ticket Slice 5),
// extracted as its own client child so the funding picture (shown at EVERY
// stage) can show the rail. In DECISION, edits go to the shared browser-local
// funding-plan draft; they persist only through explicit approval. Outside
// DECISION the approved value is read-only.

export function FundingTypeControl({
  fundingType,
  canWrite,
}: {
  fundingType: FundingType | null;
  canWrite: boolean;
}) {
  const draft = useOptionalTransferPlanDraft();
  const selected = draft ? draft.fundingType : fundingType;
  const editable = canWrite && draft?.canEdit === true;

  if (!editable) {
    return (
      <span className={styles.value}>
        {selected ? FUNDING_TYPE_LABEL[selected] : "Not chosen"}
        {selected && FUNDING_TYPE_ETA[selected] && (
          <span className={styles.eta}>Est. {FUNDING_TYPE_ETA[selected]}</span>
        )}
      </span>
    );
  }

  const change = (raw: string) => {
    const next = raw === "" ? null : (raw as FundingType);
    draft.setFundingType(next);
  };

  return (
    <span className={styles.wrap}>
      <select
        aria-label="Funding type"
        className={styles.select}
        value={selected ?? ""}
        disabled={draft.pending}
        onChange={(e) => change(e.target.value)}
      >
        <option value="">Not chosen</option>
        {FUNDING_TYPES.map((ft) => (
          <option key={ft} value={ft}>
            {FUNDING_TYPE_LABEL[ft]}
          </option>
        ))}
      </select>
      {selected && FUNDING_TYPE_ETA[selected] && (
        <span className={styles.eta}>Est. {FUNDING_TYPE_ETA[selected]}</span>
      )}
      {draft.dirty && <span className={styles.draft}>Draft · not approved</span>}
      {draft.errors.find((error) => error.field === "funding_type") && (
        <span className={styles.error} role="alert">
          {
            draft.errors.find((error) => error.field === "funding_type")
              ?.message
          }
        </span>
      )}
    </span>
  );
}
