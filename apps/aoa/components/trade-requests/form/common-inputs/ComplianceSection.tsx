"use client";

import {
  ESG_OPTIONS,
  LIQUIDATION_APPROVALS,
  RESIDENCES,
  TRADE_TYPE_COPY,
  toggleEsgFilter,
  type LiquidationApproval,
  type Residence,
} from "@/lib/trade-requests/new-request-trade-types";
import { FormSectionHeading, type NewRequestSectionProps } from "../FormSectionHeading";
import { ExclusionFields } from "../exclusions/ExclusionFields";
import { useNewRequestDraft } from "../NewRequestDraft";
import styles from "../NewRequestForm.module.css";
import { FieldLabel } from "./FieldLabel";

const ESG_LABEL_ID = "new-request-esg-label";

/**
 * State Residence, Liquidation Approval and ESG filters (Initial Funding,
 * Rebalance, Cash Deposit). The standing-exclusion text fields follow the
 * ESG filters in this section.
 */
export function ComplianceSection({ number, title }: NewRequestSectionProps) {
  const { draft, updateDraft } = useNewRequestDraft();
  const esg = draft.esgFilters;
  return (
    <section className={styles.section} aria-labelledby={`new-request-section-${number}`}>
      <FormSectionHeading number={number} title={title} />
      <div className={styles.grid2}>
        <div className={styles.field}>
          <FieldLabel htmlFor="new-request-residence" text={TRADE_TYPE_COPY.residence} title={TRADE_TYPE_COPY.residenceTitle} />
          <select
            id="new-request-residence" value={draft.residence}
            onChange={(event) => updateDraft({ residence: event.target.value as Residence })}
          >
            {RESIDENCES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <FieldLabel
            htmlFor="new-request-liquidation-approval" text={TRADE_TYPE_COPY.liquidationApproval}
            title={TRADE_TYPE_COPY.liquidationApprovalTitle}
          />
          <select
            id="new-request-liquidation-approval" value={draft.liquidationApproval}
            onChange={(event) => updateDraft({ liquidationApproval: event.target.value as LiquidationApproval })}
          >
            <option value="" disabled>{TRADE_TYPE_COPY.selectApproval}</option>
            {LIQUIDATION_APPROVALS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
      </div>
      <div className={styles.field}>
        <span id={ESG_LABEL_ID} className={styles.label} title={TRADE_TYPE_COPY.esgTitle}>{TRADE_TYPE_COPY.esg}</span>
        <div className={styles.panel} role="group" aria-labelledby={ESG_LABEL_ID}>
          <div className={styles.esgOptions}>
            {ESG_OPTIONS.map(({ key, label }) => (
              <label key={key} className={styles.esgOption}>
                <input
                  type="checkbox" className={styles.checkbox} checked={esg[key]}
                  onChange={() => updateDraft((current) => ({ ...current, esgFilters: toggleEsgFilter(current.esgFilters, key) }))}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {esg.other && (
            <input
              type="text" className={styles.input} aria-label={TRADE_TYPE_COPY.esgOtherLabel} placeholder={TRADE_TYPE_COPY.esgOtherPlaceholder}
              value={esg.otherDescription}
              onChange={(event) => updateDraft((current) => ({
                ...current, esgFilters: { ...current.esgFilters, otherDescription: event.target.value },
              }))}
            />
          )}
        </div>
      </div>
      <ExclusionFields />
    </section>
  );
}
