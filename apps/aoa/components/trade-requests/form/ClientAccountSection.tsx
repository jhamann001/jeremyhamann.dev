"use client";

import { Button } from "@/components/ui";
import {
  NEW_REQUEST_COPY,
  accountsForClients,
  formatCurrency,
  householdResolutionKey,
  listedTotal,
  mergeHouseholdSelection,
  selectedAccountUlids,
  withAccountToggled,
  withClients,
  withManualMode,
} from "@/lib/trade-requests/new-request";
import { ClientMultiSelect } from "./ClientMultiSelect";
import { TradeTypeFields } from "./common-inputs/TradeTypeFields";
import { AccountExclusionsPanel } from "./exclusions/AccountExclusionsPanel";
import { ManageExclusionsButton } from "./exclusions/ManageExclusionsButton";
import { FormSectionHeading, type NewRequestSectionProps } from "./FormSectionHeading";
import { HouseholdPrompt } from "./HouseholdPrompt";
import { ManualAccounts } from "./ManualAccounts";
import { useNewRequestDraft } from "./NewRequestDraft";
import styles from "./NewRequestForm.module.css";

const CLIENT_LABEL_ID = "new-request-client-label";

export function ClientAccountSection({ number, title }: NewRequestSectionProps) {
  const { draft, updateDraft, clients, context, households } = useNewRequestDraft();
  const list = clients.status === "loaded" ? clients.clients : [];
  const groups = accountsForClients(context);
  const householdKey = householdResolutionKey(households);
  const editing = draft.formMode === "edit";
  const showHousehold = !!households && !draft.manualMode && !editing && householdKey !== null && draft.dismissedHouseholdKey !== householdKey;

  return (
    <section className={styles.section} aria-labelledby={`new-request-section-${number}`}>
      <FormSectionHeading
        number={number} title={title}
        actions={editing ? undefined : (
          <Button
            variant="ghost" size="sm"
            title={draft.manualMode ? NEW_REQUEST_COPY.useListTitle : NEW_REQUEST_COPY.enterManuallyTitle}
            onClick={() => updateDraft((current) => withManualMode(current, !current.manualMode))}
          >
            {draft.manualMode ? NEW_REQUEST_COPY.useList : NEW_REQUEST_COPY.enterManually}
          </Button>
        )}
      />
      <div className={styles.grid3}>
        <div className={styles.field}>
          {draft.manualMode ? (
            <>
              <label htmlFor="new-request-manual-client" className={styles.label}>{NEW_REQUEST_COPY.manualClientLabel}</label>
              <input
                id="new-request-manual-client" type="text" placeholder={NEW_REQUEST_COPY.manualClientPlaceholder}
                value={draft.manualClientName} onChange={(event) => updateDraft({ manualClientName: event.target.value })}
              />
            </>
          ) : (
            <>
              <div className={styles.labelRow}>
                <span id={CLIENT_LABEL_ID} className={styles.label}>
                  {NEW_REQUEST_COPY.clientLabel}{draft.clientIds.length > 1 ? ` (${draft.clientIds.length})` : ""}
                </span>
                <ManageExclusionsButton />
              </div>
              <ClientMultiSelect
                clients={list} selectedIds={draft.clientIds} labelId={CLIENT_LABEL_ID} disabled={editing}
                onChange={(ids) => updateDraft((current) => withClients(current, ids))}
              />
            </>
          )}
        </div>
        <TradeTypeFields />
      </div>

      {draft.manualMode && draft.manualClientName.trim() && <ManualAccounts draft={draft} />}

      {showHousehold && households && (
        <HouseholdPrompt
          resolution={households} selectedAccountIds={selectedAccountUlids(context)} selectedClientIds={draft.clientIds}
          onInclude={(accounts) => updateDraft((current) => ({
            ...mergeHouseholdSelection(current, households, accounts), dismissedHouseholdKey: householdKey,
          }))}
          onDismiss={() => updateDraft({ dismissedHouseholdKey: householdKey })}
        />
      )}

      {!draft.manualMode && groups.length > 0 && (
        <div className={styles.panel} role="group" aria-labelledby="new-request-accounts-label">
          <div className={styles.panelHead}>
            <p id="new-request-accounts-label" className={styles.label}>{NEW_REQUEST_COPY.selectAccounts}</p>
            {draft.selectedAccounts.length > 0 && (
              <span className={styles.total}>{NEW_REQUEST_COPY.total} {formatCurrency(listedTotal(context))}</span>
            )}
          </div>
          {groups.map(({ client, accounts }) => (
            <div key={client.id} className={styles.accountGroup}>
              {groups.length > 1 && <p className={styles.groupName}>{client.name}</p>}
              {accounts.map((account) => (
                <label key={account.accountNumber} className={styles.account}>
                  <span className={styles.accountMain}>
                    <input
                      type="checkbox" className={styles.checkbox} checked={draft.selectedAccounts.includes(account.accountNumber)}
                      onChange={() => updateDraft((current) => withAccountToggled(current, account.accountNumber))}
                    />
                    <span>
                      <span className={styles.accountNumber}>{account.accountNumber}</span>
                      <span className={styles.accountType}>{account.accountType}</span>
                    </span>
                  </span>
                  <span className={styles.balance}>{formatCurrency(account.balance)}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}

      {!draft.manualMode && groups.length > 0 && <AccountExclusionsPanel />}
    </section>
  );
}
