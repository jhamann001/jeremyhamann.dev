"use client";

import { useState, useTransition } from "react";
import {
  FUNDING_TYPES,
  FUNDING_TYPE_ETA,
  FUNDING_TYPE_LABEL,
} from "@/lib/data/transfer-types";
import { Button } from "@/components/ui";
import {
  setCashInFlight,
  setChecklistFlag,
  type ChecklistField,
} from "@/app/(authenticated)/asset-transfer/actions";
import {
  FULL_ACAT_REFUSED_MESSAGE,
  fullAcatRefused,
  type EligibilityHolding,
} from "@/lib/transfers/holding-eligibility";
import { useTransferPlanDraft } from "./TransferPlanDraftProvider";
import styles from "./DecisionChecklistCard.module.css";

// Decision-stage readiness + funding-plan status. The rail and position
// controls share one browser-local draft; only explicit approval persists them
// and satisfies funding_plan_complete. The remaining readiness toggles retain
// their existing audited actions. VIEWER/non-Ops roles see the approved plan.

type BoolField = ChecklistField | "cash_in_flight";
type FundingTypeChoice = (typeof FUNDING_TYPES)[number];

/** ATW-03 (AC-28): a refused Full ACAT never reaches the draft. */
export function chooseFundingType(
  value: string,
  refused: boolean,
  setFundingType: (value: FundingTypeChoice | null) => void,
  setError: (message: string | null) => void,
): void {
  if (value === "ACAT_FULL" && refused) {
    setError(FULL_ACAT_REFUSED_MESSAGE);
    return;
  }
  setError(null);
  setFundingType(value === "" ? null : (value as FundingTypeChoice));
}

const CHECKLIST: { field: ChecklistField; label: string; hint: string }[] = [
  {
    field: "accounts_opened_at_apex",
    label: "Accounts opened at Apex",
    hint: "Receiving accounts exist at the custodian",
  },
  {
    field: "funding_initiated",
    label: "Funding initiated",
    hint: "ACAT submitted or cash instruction sent",
  },
];

export function DecisionChecklistCard({
  transferId,
  accountsOpenedAtApex,
  fundingInitiated,
  cashInFlight,
  canWrite,
  showReadiness,
  eligibilityEnabled = false,
  eligibilityHoldings = [],
}: {
  transferId: string;
  accountsOpenedAtApex: boolean;
  fundingInitiated: boolean;
  cashInFlight: boolean;
  canWrite: boolean;
  showReadiness: boolean;
  eligibilityEnabled?: boolean;
  eligibilityHoldings?: EligibilityHolding[];
}) {
  const draft = useTransferPlanDraft();
  const fullAcatUnavailable = fullAcatRefused(eligibilityEnabled, eligibilityHoldings);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const values: Record<BoolField, boolean> = {
    accounts_opened_at_apex: accountsOpenedAtApex,
    funding_initiated: fundingInitiated,
    cash_in_flight: cashInFlight,
  };

  const report = (result: void | { ok: false; errors: { message: string }[] }) =>
    setError(result && !result.ok ? result.errors[0]?.message ?? null : null);

  const toggleChecklist = (field: ChecklistField, next: boolean) => {
    startTransition(async () => {
      report(await setChecklistFlag(transferId, field, next));
    });
  };

  const toggleCash = (next: boolean) => {
    startTransition(async () => {
      report(await setCashInFlight(transferId, next));
    });
  };

  const boolRow = (field: BoolField, label: string, hint: string) => {
    const done = values[field];
    return (
      <li key={field} className={styles.row}>
        <span
          className={done ? styles.markerDone : styles.markerTodo}
          aria-hidden="true"
        >
          {done ? "✓" : "○"}
        </span>
        <span className={styles.text}>
          <span className={styles.label}>{label}</span>
          <span className={styles.hint}>{hint}</span>
        </span>
        {canWrite && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              field === "cash_in_flight"
                ? toggleCash(!done)
                : toggleChecklist(field, !done)
            }
          >
            {done ? "Clear" : "Mark done"}
          </Button>
        )}
      </li>
    );
  };

  return (
    <div className={styles.wrap}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.funding}>
        <label className={styles.fundingLabel} htmlFor="funding_type">
          Funding type
        </label>
        {canWrite && draft.canEdit ? (
          <select
            id="funding_type"
            className={styles.select}
            value={draft.fundingType ?? ""}
            disabled={pending || draft.pending}
            onChange={(e) =>
              chooseFundingType(e.target.value, fullAcatUnavailable, draft.setFundingType, setError)
            }
          >
            <option value="">Not chosen</option>
            {FUNDING_TYPES.map((ft) => (
              <option key={ft} value={ft} disabled={ft === "ACAT_FULL" && fullAcatUnavailable}>
                {FUNDING_TYPE_LABEL[ft]}
              </option>
            ))}
          </select>
        ) : (
          <span className={styles.fundingValue}>
            {draft.fundingType
              ? FUNDING_TYPE_LABEL[draft.fundingType]
              : "Not chosen"}
          </span>
        )}
        {draft.fundingType && FUNDING_TYPE_ETA[draft.fundingType] && (
          <span className={styles.eta}>
            Est. {FUNDING_TYPE_ETA[draft.fundingType]}
          </span>
        )}
      </div>

      <ul className={styles.list}>
        <li className={styles.row}>
          <span
            className={
              draft.planComplete && draft.approvedVersion > 0 && !draft.dirty
                ? styles.markerDone
                : draft.dirty || (draft.planComplete && draft.approvedVersion === 0)
                  ? styles.markerDraft
                  : styles.markerTodo
            }
            aria-hidden="true"
          >
            {draft.planComplete && draft.approvedVersion > 0 && !draft.dirty
              ? "✓"
              : draft.dirty || (draft.planComplete && draft.approvedVersion === 0)
                ? "•"
                : "○"}
          </span>
          <span className={styles.text}>
            <span className={styles.label}>Funding plan approval</span>
            <span className={styles.hint}>
              {draft.dirty
                ? `Draft changes are not saved${draft.planComplete && draft.approvedVersion > 0 ? `; version ${draft.approvedVersion} remains active` : ""}.`
                : draft.planComplete && draft.approvedVersion > 0
                  ? `Approved version ${draft.approvedVersion}${draft.approvedBy ? ` by ${draft.approvedBy}` : ""}${draft.approvedAt ? ` on ${new Date(draft.approvedAt).toLocaleDateString("en-US")}` : ""}.`
                  : draft.planComplete
                    ? "Legacy completion needs approval to create a versioned plan."
                  : "Rail and position choices are not finalized yet."}
            </span>
          </span>
        </li>
        {showReadiness && draft.fundingType !== "DRS" &&
          CHECKLIST.map((c) => boolRow(c.field, c.label, c.hint))}
        {showReadiness && draft.fundingType !== "DRS" &&
          boolRow(
            "cash_in_flight",
            "Cash in flight",
            "Wire / check / ACH / manual transfer sent (non-ACAT rail)",
          )}
      </ul>

    </div>
  );
}
