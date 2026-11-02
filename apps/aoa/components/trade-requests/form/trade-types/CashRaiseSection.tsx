"use client";

import { TRADE_TYPE_COPY } from "@/lib/trade-requests/new-request-trade-types";
import { FieldLabel } from "../common-inputs/FieldLabel";
import { FormSectionHeading, type NewRequestSectionProps } from "../FormSectionHeading";
import { useNewRequestDraft } from "../NewRequestDraft";
import styles from "../NewRequestForm.module.css";

export function CashRaiseSection({ number, title }: NewRequestSectionProps) {
  const { draft, updateDraft } = useNewRequestDraft();
  return (
    <section className={styles.section} aria-labelledby={`new-request-section-${number}`}>
      <FormSectionHeading number={number} title={title} />
      <div className={styles.grid2}>
        <div className={styles.field}>
          <FieldLabel htmlFor="new-request-raise-cash-amount" text={TRADE_TYPE_COPY.cashAmount} required />
          <p id="new-request-raise-cash-amount-help" className={styles.help}>{TRADE_TYPE_COPY.cashAmountHelp}</p>
          <input
            id="new-request-raise-cash-amount" type="text" aria-required="true" aria-describedby="new-request-raise-cash-amount-help"
            placeholder={TRADE_TYPE_COPY.cashAmountPlaceholder} value={draft.tradeAmount}
            onChange={(event) => updateDraft({ tradeAmount: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <FieldLabel htmlFor="new-request-liquidity-deadline" text={TRADE_TYPE_COPY.liquidityDeadline} />
          <p id="new-request-liquidity-deadline-help" className={styles.help}>{TRADE_TYPE_COPY.liquidityDeadlineHelp}</p>
          <input
            id="new-request-liquidity-deadline" type="date" aria-describedby="new-request-liquidity-deadline-help"
            value={draft.liquidityDeadline} onChange={(event) => updateDraft({ liquidityDeadline: event.target.value })}
          />
        </div>
      </div>
      <div className={styles.field}>
        <FieldLabel htmlFor="new-request-raise-cash-reason" text={TRADE_TYPE_COPY.raiseCashReason} required />
        <p id="new-request-raise-cash-reason-help" className={styles.help}>{TRADE_TYPE_COPY.raiseCashReasonHelp}</p>
        <textarea
          id="new-request-raise-cash-reason" rows={2} aria-required="true" aria-describedby="new-request-raise-cash-reason-help"
          placeholder={TRADE_TYPE_COPY.raiseCashReasonPlaceholder} value={draft.raiseCashReason}
          onChange={(event) => updateDraft({ raiseCashReason: event.target.value })}
        />
      </div>
    </section>
  );
}
