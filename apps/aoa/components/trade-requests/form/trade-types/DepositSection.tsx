"use client";

import { TRADE_TYPE_COPY, cashDepositNote, rebalanceAllText } from "@/lib/trade-requests/new-request-trade-types";
import { FieldLabel } from "../common-inputs/FieldLabel";
import { FormSectionHeading, type NewRequestSectionProps } from "../FormSectionHeading";
import { useNewRequestDraft } from "../NewRequestDraft";
import { useNoPlanCopy } from "../NoPlanCopy";
import styles from "../NewRequestForm.module.css";

/** Cash Deposit: amount, deposit account, the rebalance-all option and the Cash Deposit note. */
export function DepositSection({ number, title }: NewRequestSectionProps) {
  const { draft, updateDraft } = useNewRequestDraft();
  const noPlanCopy = useNoPlanCopy();
  const note = cashDepositNote(noPlanCopy);
  return (
    <section className={styles.section} aria-labelledby={`new-request-section-${number}`}>
      <FormSectionHeading number={number} title={title} />
      <div className={styles.grid2}>
        <div className={styles.field}>
          <FieldLabel htmlFor="new-request-deposit-amount" text={TRADE_TYPE_COPY.depositAmount} required />
          <input
            id="new-request-deposit-amount" type="text" aria-required="true" placeholder={TRADE_TYPE_COPY.depositAmountPlaceholder}
            value={draft.tradeAmount} onChange={(event) => updateDraft({ tradeAmount: event.target.value })}
          />
        </div>
        <div className={styles.field}>
          <FieldLabel htmlFor="new-request-deposit-account" text={TRADE_TYPE_COPY.depositAccount} required />
          <select
            id="new-request-deposit-account" aria-required="true" value={draft.depositAccount}
            onChange={(event) => updateDraft({ depositAccount: event.target.value })}
          >
            <option value="" disabled>{TRADE_TYPE_COPY.selectDepositAccount}</option>
            {draft.selectedAccounts.map((account) => <option key={account} value={account}>{account}</option>)}
          </select>
        </div>
      </div>
      <label htmlFor="new-request-rebalance-all" className={styles.checkRow}>
        <input
          id="new-request-rebalance-all" type="checkbox" className={styles.checkbox} checked={draft.rebalanceAll}
          aria-labelledby="new-request-rebalance-all-title" aria-describedby="new-request-rebalance-all-text"
          onChange={(event) => updateDraft({ rebalanceAll: event.target.checked })}
        />
        <span>
          <span id="new-request-rebalance-all-title" className={styles.checkRowTitle}>{TRADE_TYPE_COPY.rebalanceAll}</span>
          <span id="new-request-rebalance-all-text" className={styles.checkRowText}>
            {rebalanceAllText(draft.rebalanceAll, noPlanCopy)}
          </span>
        </span>
      </label>
      <div className={styles.note} role="note">
        {note.lead && <span className={styles.noteLead}>{note.lead} </span>}{note.text}
      </div>
    </section>
  );
}
