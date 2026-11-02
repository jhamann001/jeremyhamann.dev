"use client";

import { LIQUIDATE_OPTIONS, TRADE_TYPE_COPY, type LiquidateOption } from "@/lib/trade-requests/new-request-trade-types";
import { FieldLabel } from "../common-inputs/FieldLabel";
import { FormSectionHeading, type NewRequestSectionProps } from "../FormSectionHeading";
import { useNewRequestDraft } from "../NewRequestDraft";
import styles from "../NewRequestForm.module.css";

export function LiquidationSection({ number, title }: NewRequestSectionProps) {
  const { draft, updateDraft } = useNewRequestDraft();
  return (
    <section className={styles.section} aria-labelledby={`new-request-section-${number}`}>
      <FormSectionHeading number={number} title={title} />
      <div className={styles.field}>
        <FieldLabel htmlFor="new-request-liquidate-option" text={TRADE_TYPE_COPY.liquidateOptions} required />
        <select
          id="new-request-liquidate-option" aria-required="true" value={draft.liquidateOption}
          onChange={(event) => updateDraft({ liquidateOption: event.target.value as LiquidateOption })}
        >
          <option value="" disabled>{TRADE_TYPE_COPY.selectLiquidateOption}</option>
          {LIQUIDATE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
      {draft.liquidateOption === "Specific Positions" && (
        <div className={styles.field}>
          <FieldLabel htmlFor="new-request-liquidate-positions" text={TRADE_TYPE_COPY.positions} required />
          <textarea
            id="new-request-liquidate-positions" rows={3} aria-required="true" placeholder={TRADE_TYPE_COPY.positionsPlaceholder}
            value={draft.liquidatePositions} onChange={(event) => updateDraft({ liquidatePositions: event.target.value })}
          />
        </div>
      )}
    </section>
  );
}
