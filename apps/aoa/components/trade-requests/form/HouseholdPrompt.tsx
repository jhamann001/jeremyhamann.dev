"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import {
  NEW_REQUEST_COPY,
  householdsWithUnselected,
  otherClientCount,
  type HouseholdAccount,
  type HouseholdResolveResult,
  type HouseholdWithUnselected,
} from "@/lib/trade-requests/new-request";
import styles from "./NewRequestForm.module.css";

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Single firm household prompt (AC-122, AC-123), multi-household warning (AC-124), or nothing (AC-142). */
export function HouseholdPrompt({ resolution, selectedAccountIds, selectedClientIds, onInclude, onDismiss }: {
  resolution: HouseholdResolveResult;
  selectedAccountIds: readonly string[];
  selectedClientIds: readonly string[];
  onInclude: (accounts: HouseholdAccount[]) => void;
  onDismiss: () => void;
}) {
  const rows = householdsWithUnselected(resolution, selectedAccountIds);
  if (rows.length === 0) return null;
  if (rows.length === 1) {
    const row = rows[0];
    return (
      <SingleHousehold
        key={row.missing.map((account) => account.accountId).join("|")}
        row={row} selectedClientIds={selectedClientIds} onInclude={onInclude} onDismiss={onDismiss}
      />
    );
  }
  return (
    <div role="region" aria-label={NEW_REQUEST_COPY.householdRegion} className={`${styles.household} ${styles.caution}`} data-testid="household-warning">
      <div className={styles.householdHead}>
        <div>
          <p className={styles.householdLead}>Selection spans {rows.length} firm households</p>
          <ul className={styles.householdList}>
            {rows.map(({ household, missing }) => (
              <li key={household.householdId}>
                <strong>{household.householdName}</strong> — {plural(missing.length, "sibling account")} not in this trade
              </li>
            ))}
          </ul>
          <p className={styles.householdSub}>{NEW_REQUEST_COPY.notTagged}</p>
        </div>
        <button type="button" className={styles.close} aria-label={NEW_REQUEST_COPY.dismissSidecar} onClick={onDismiss}>×</button>
      </div>
      <div className={styles.householdActions}>
        <Button variant="ghost" size="sm" onClick={onDismiss}>{NEW_REQUEST_COPY.continue}</Button>
      </div>
    </div>
  );
}

function SingleHousehold({ row, selectedClientIds, onInclude, onDismiss }: {
  row: HouseholdWithUnselected;
  selectedClientIds: readonly string[];
  onInclude: (accounts: HouseholdAccount[]) => void;
  onDismiss: () => void;
}) {
  const { household, missing } = row;
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(missing.map((account) => account.accountId)));
  const others = otherClientCount(missing.filter((account) => !account.clientId || !selectedClientIds.includes(account.clientId)));
  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div role="region" aria-label={NEW_REQUEST_COPY.householdRegion} className={`${styles.household} ${styles.info}`} data-testid="household-prompt">
      <div className={styles.householdHead}>
        <div>
          <p className={styles.householdLead}>
            {plural(missing.length, "sibling account")}
            {others > 0 && <> in {plural(others, "other client")}</>}
            {" "}— part of household <strong>{household.householdName}</strong>
          </p>
          <p className={styles.householdSub}>{NEW_REQUEST_COPY.includeQuestion}</p>
        </div>
        <button type="button" className={styles.close} aria-label={NEW_REQUEST_COPY.dismissSidecar} onClick={onDismiss}>×</button>
      </div>
      <div className={styles.householdActions}>
        <Button variant="primary" size="sm" onClick={() => onInclude(missing)}>{NEW_REQUEST_COPY.includeAll}</Button>
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{NEW_REQUEST_COPY.choose}</Button>
        <button type="button" className={styles.linkButton} onClick={onDismiss}>{NEW_REQUEST_COPY.dismiss}</button>
      </div>
      {open && (
        <div className={styles.disclosure}>
          {missing.map((account) => (
            <label key={account.accountId} className={styles.disclosureItem}>
              <input type="checkbox" className={styles.checkbox} checked={chosen.has(account.accountId)} onChange={() => toggle(account.accountId)} />
              <span>
                <strong>{account.accountTitle || account.accountNumber || account.accountId}</strong>
                {account.accountNumber && account.accountTitle ? <> · {account.accountNumber}</> : null}
              </span>
            </label>
          ))}
          <div>
            <Button
              variant="primary" size="sm" className={styles.submit} disabled={chosen.size === 0}
              onClick={() => onInclude(missing.filter((account) => chosen.has(account.accountId)))}
            >
              Include selected ({chosen.size})
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
