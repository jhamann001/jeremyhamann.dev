"use client";

import { TRADE_TYPE_COPY } from "@/lib/trade-requests/new-request-trade-types";
import { FieldLabel } from "../common-inputs/FieldLabel";
import { FormSectionHeading, type NewRequestSectionProps } from "../FormSectionHeading";
import { useNewRequestDraft } from "../NewRequestDraft";
import styles from "../NewRequestForm.module.css";

/** Rebalance "New Deposits": shown only; the values are never sent (AC-152). */
export function NewDepositsSection({ number, title }: NewRequestSectionProps) {
  const { draft, updateDraft } = useNewRequestDraft();
  return (
    <section className={styles.section} aria-labelledby={`new-request-section-${number}`}>
      <FormSectionHeading number={number} title={title} />
      <p className={styles.sectionLead}>{TRADE_TYPE_COPY.newDepositsHelp}</p>
      <div className={styles.grid2}>
        <div className={styles.field}>
          <FieldLabel htmlFor="new-request-rebalance-deposit-amount" text={TRADE_TYPE_COPY.depositAmount} />
          <input
            id="new-request-rebalance-deposit-amount" type="text" placeholder={TRADE_TYPE_COPY.newDepositAmountPlaceholder}
            value={draft.tradeAmount} onChange={(event) => updateDraft({ tradeAmount: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <FieldLabel htmlFor="new-request-rebalance-deposit-account" text={TRADE_TYPE_COPY.depositAccount} />
          <select
            id="new-request-rebalance-deposit-account" value={draft.depositAccount}
            onChange={(event) => updateDraft({ depositAccount: event.target.value })}
          >
            <option value="">{TRADE_TYPE_COPY.noDeposit}</option>
            {draft.selectedAccounts.map((account) => <option key={account} value={account}>{account}</option>)}
          </select>
        </div>
      </div>
    </section>
  );
}
