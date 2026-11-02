"use client";

import { useRef } from "react";
import { Button } from "@/components/ui";
import {
  ACCOUNT_TYPES,
  NEW_REQUEST_COPY,
  formatCurrency,
  manualTotal,
  toggleValue,
  type ManualAccount,
  type NewRequestDraft,
} from "@/lib/trade-requests/new-request";
import { useNewRequestDraft } from "./NewRequestDraft";
import styles from "./NewRequestForm.module.css";

export function ManualAccounts({ draft }: { draft: NewRequestDraft }) {
  const { updateDraft } = useNewRequestDraft();
  const nextId = useRef(0);
  const update = (id: string, field: keyof ManualAccount, value: string) =>
    updateDraft((current) => ({
      ...current,
      manualAccounts: current.manualAccounts.map((account) => (account.id === id ? { ...account, [field]: value } : account)),
    }));
  const add = () => {
    nextId.current += 1;
    const id = `manual-${Date.now()}-${nextId.current}`;
    updateDraft((current) => ({
      ...current,
      manualAccounts: [...current.manualAccounts, { id, accountNumber: "", accountType: "Taxable", balance: "" }],
    }));
  };
  const remove = (id: string) =>
    updateDraft((current) => ({
      ...current,
      manualAccounts: current.manualAccounts.filter((account) => account.id !== id),
      manualSelectedIds: current.manualSelectedIds.filter((entry) => entry !== id),
    }));

  return (
    <div className={styles.panel} role="group" aria-labelledby="new-request-manual-accounts-label">
      <div className={styles.panelHead}>
        <p id="new-request-manual-accounts-label" className={styles.label}>{NEW_REQUEST_COPY.manualAccounts}</p>
        {draft.manualSelectedIds.length > 0 && (
          <span className={styles.total}>{NEW_REQUEST_COPY.total} {formatCurrency(manualTotal(draft))}</span>
        )}
      </div>
      {draft.manualAccounts.map((account, index) => (
        <div key={account.id} className={`${styles.manualRow} ${styles.field}`} data-testid="manual-account-row">
          <input
            type="checkbox" className={styles.checkbox} aria-label={`Select manual account ${index + 1}`}
            checked={draft.manualSelectedIds.includes(account.id)}
            onChange={() => updateDraft((current) => ({ ...current, manualSelectedIds: toggleValue(current.manualSelectedIds, account.id) }))}
          />
          <div className={styles.manualFields}>
            <input
              type="text" aria-label={NEW_REQUEST_COPY.manualAccountNumber} placeholder={NEW_REQUEST_COPY.manualAccountNumber}
              value={account.accountNumber} onChange={(event) => update(account.id, "accountNumber", event.target.value)}
            />
            <select aria-label="Account type" value={account.accountType} onChange={(event) => update(account.id, "accountType", event.target.value)}>
              {ACCOUNT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
            <input
              type="text" inputMode="decimal" aria-label={NEW_REQUEST_COPY.manualAccountValue} placeholder={NEW_REQUEST_COPY.manualAccountValue}
              value={account.balance} onChange={(event) => update(account.id, "balance", event.target.value)}
            />
          </div>
          <button type="button" className={styles.remove} aria-label={NEW_REQUEST_COPY.removeAccount} onClick={() => remove(account.id)}>×</button>
        </div>
      ))}
      <Button variant="ghost" className={styles.addAccount} onClick={add}><span aria-hidden="true">+</span> {NEW_REQUEST_COPY.addAccount}</Button>
    </div>
  );
}
