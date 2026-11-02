"use client";

import { ALLOCATION_COPY, RISK_SCORES, baseAllocationFor } from "@/lib/trade-requests/new-request-allocation";
import { FieldLabel } from "../common-inputs/FieldLabel";
import { FormSectionHeading, type NewRequestSectionProps } from "../FormSectionHeading";
import { useNewRequestDraft } from "../NewRequestDraft";
import formStyles from "../NewRequestForm.module.css";
import styles from "./Allocation.module.css";

const TILES = [
  { key: "equity", label: ALLOCATION_COPY.equity },
  { key: "fixed", label: ALLOCATION_COPY.fixed },
  { key: "cash", label: ALLOCATION_COPY.cash },
] as const;

/** Client Risk Score and the base allocation it assigns (AC-95). */
export function MandateSection({ number, title }: NewRequestSectionProps) {
  const { draft, updateDraft } = useNewRequestDraft();
  const base = baseAllocationFor(draft);
  return (
    <section className={formStyles.section} aria-labelledby={`new-request-section-${number}`}>
      <FormSectionHeading number={number} title={title} />
      <div className={styles.mandate}>
        <div className={formStyles.field}>
          <FieldLabel htmlFor="new-request-risk-score" text={ALLOCATION_COPY.riskScore} />
          <select
            id="new-request-risk-score" value={draft.riskProfile ?? ""} aria-describedby="new-request-risk-score-help"
            onChange={(event) => updateDraft({ riskProfile: event.target.value === "" ? null : Number(event.target.value) })}
          >
            <option value="">{ALLOCATION_COPY.selectRiskScore}</option>
            {RISK_SCORES.map((score) => <option key={score} value={score}>{`Level ${score} / 25`}</option>)}
          </select>
          <p id="new-request-risk-score-help" className={formStyles.help}>{ALLOCATION_COPY.riskScoreHelp}</p>
        </div>
        <div className={formStyles.field}>
          <span id="new-request-base-allocation" className={formStyles.label}>{ALLOCATION_COPY.baseAllocation}</span>
          <div className={styles.tiles} role="group" aria-labelledby="new-request-base-allocation">
            {TILES.map(({ key, label }) => (
              <div key={key} className={styles.tile} data-testid={`base-allocation-${key}`}>
                <p className={styles.tileLabel}>{label}</p>
                <p className={styles.tileValue}>{base === null ? ALLOCATION_COPY.unset : `${base[key]}%`}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
