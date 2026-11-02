"use client";

import { useEffect, useRef, useState } from "react";
import {
  searchOperationsFeeClients,
  submitOperationsFeeRequest,
} from "@/app/(authenticated)/operations/fee-requests/actions";
import type { OperationsFeeClientOption } from "@/lib/data/operations-fee-requests";
import {
  EXCEPTION_TYPES,
  FEE_CREDIT_TYPES,
  type OperationsFeeRequestKind,
} from "@/lib/operations/fee-request";
import styles from "./FeeRequestIntake.module.css";

type Props = {
  defaultWaiverMonth: string;
  submissionKey: string;
};

export function FeeRequestIntake({ defaultWaiverMonth, submissionKey }: Props) {
  const [kind, setKind] = useState<OperationsFeeRequestKind>("FEE_CREDIT");
  const [clientQuery, setClientQuery] = useState("");
  const [clientResults, setClientResults] = useState<OperationsFeeClientOption[]>([]);
  const [selectedClient, setSelectedClient] = useState<OperationsFeeClientOption | null>(null);
  const [clientSearchState, setClientSearchState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const searchSequence = useRef(0);
  const [indefinite, setIndefinite] = useState(false);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [selectedFeeTypes, setSelectedFeeTypes] = useState<string[]>([]);
  const isFeeCredit = kind === "FEE_CREDIT";

  useEffect(() => {
    const query = clientQuery.trim();
    if (selectedClient || query.length < 2) {
      setClientResults([]);
      setClientSearchState("idle");
      return;
    }
    const sequence = ++searchSequence.current;
    setClientSearchState("loading");
    let requestTimeout: number | undefined;
    let settled = false;
    const timer = window.setTimeout(() => {
      requestTimeout = window.setTimeout(() => {
        if (sequence !== searchSequence.current) return;
        settled = true;
        setClientResults([]);
        setClientSearchState("error");
      }, 17_000);
      searchOperationsFeeClients(query)
        .then((results) => {
          if (settled || sequence !== searchSequence.current) return;
          settled = true;
          if (requestTimeout !== undefined) window.clearTimeout(requestTimeout);
          setClientResults(results);
          setClientSearchState("ready");
        })
        .catch(() => {
          if (settled || sequence !== searchSequence.current) return;
          settled = true;
          if (requestTimeout !== undefined) window.clearTimeout(requestTimeout);
          setClientResults([]);
          setClientSearchState("error");
        });
    }, 250);
    return () => {
      settled = true;
      window.clearTimeout(timer);
      if (requestTimeout !== undefined) window.clearTimeout(requestTimeout);
    };
  }, [clientQuery, selectedClient]);

  return (
    <form className={styles.form} action={submitOperationsFeeRequest}>
      <input type="hidden" name="submissionKey" value={submissionKey} />
      <input type="hidden" name="requestKind" value={kind} />
      <div className={styles.kindPicker} aria-label="Request type">
        <button
          type="button"
          className={isFeeCredit ? styles.activeKind : styles.kindButton}
          onClick={() => setKind("FEE_CREDIT")}
        >
          <span>Fee credit</span>
          <small>One-time custodial or transaction fee</small>
        </button>
        <button
          type="button"
          className={!isFeeCredit ? styles.activeKind : styles.kindButton}
          onClick={() => setKind("SERVICE_GUARANTEE")}
        >
          <span>Service guarantee or billing exception</span>
          <small>Temporary or indefinite AUM-fee waiver</small>
        </button>
      </div>

      <div className={styles.grid}>
        <label className={styles.full}>
          Client
          <input
            type="hidden"
            name="clientSfId"
            value={selectedClient?.clientSfId ?? ""}
          />
          <div className={styles.clientSearch}>
            <input
              aria-label="Client"
              autoComplete="off"
              placeholder="Search client or household"
              required
              value={clientQuery}
              onChange={(event) => {
                setClientQuery(event.target.value);
                setSelectedClient(null);
                setSelectedAccountIds([]);
              }}
            />
            {clientSearchState === "loading" && (
              <p className={styles.searchStatus} role="status">Searching…</p>
            )}
            {clientSearchState === "error" && (
              <p className={styles.fieldError} role="alert">Client search is temporarily unavailable. Try again.</p>
            )}
            {clientSearchState === "ready" && clientResults.length === 0 && (
              <p className={styles.searchStatus}>No matching clients or households.</p>
            )}
            {!selectedClient && clientResults.length > 0 && (
              <div className={styles.clientResults} aria-label="Matching clients">
                {clientResults.map((client) => (
                  <button
                    key={client.clientSfId}
                    type="button"
                    onClick={() => {
                      setSelectedClient(client);
                      setClientQuery(`${client.name}${client.householdName ? ` · ${client.householdName}` : ""}`);
                      setClientResults([]);
                    }}
                  >
                    <b>{client.name}</b>
                    <span>{client.householdName ?? "No household name"} · {client.accounts.length} account{client.accounts.length === 1 ? "" : "s"}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {selectedClient && (
            <span className={styles.selectedClient}>
              Selected · {selectedClient.name}
              <button
                type="button"
                onClick={() => {
                  setSelectedClient(null);
                  setClientQuery("");
                  setSelectedAccountIds([]);
                }}
              >Change</button>
            </span>
          )}
        </label>

        {!isFeeCredit && (
          <label>
            Exception type
            <select value={kind} onChange={(event) => setKind(event.target.value as OperationsFeeRequestKind)}>
              {EXCEPTION_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        )}

        {isFeeCredit ? (
          <>
            <fieldset className={styles.full}>
              <legend>Fee type</legend>
              <div className={styles.checkGrid}>
                {FEE_CREDIT_TYPES.map((feeType) => (
                  <label key={feeType} className={styles.checkOption}>
                    <input
                      type="checkbox"
                      name="feeTypes"
                      value={feeType}
                      checked={selectedFeeTypes.includes(feeType)}
                      onChange={(event) => setSelectedFeeTypes((current) => (
                        event.target.checked
                          ? [...current, feeType]
                          : current.filter((value) => value !== feeType)
                      ))}
                    />
                    <span>{feeType}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label>
              Requested credit amount
              <span className={styles.moneyInput}><span>$</span><input name="feeAmount" inputMode="decimal" placeholder="0.00" required /></span>
              <small>Enter the exact requested amount; AOA does not calculate it.</small>
            </label>
          </>
        ) : (
          <>
            <label>
              Waiver start
              <input type="month" name="waiverStart" required defaultValue={defaultWaiverMonth} />
            </label>
            <label>
              Duration in months
              <input type="number" name="waiverDurationMonths" min="1" max="120" defaultValue="6" required={!indefinite} disabled={indefinite} />
            </label>
            <label className={styles.indefinite}>
              <input type="checkbox" name="indefiniteDuration" checked={indefinite} onChange={(event) => setIndefinite(event.target.checked)} />
              Indefinite duration
            </label>
          </>
        )}

        <fieldset className={styles.full} key={selectedClient?.clientSfId ?? "no-client"}>
          <legend>Accounts where this request applies</legend>
          {!selectedClient ? (
            <p className={styles.fieldHint}>Choose a client to see their accounts.</p>
          ) : selectedClient.accounts.length === 0 ? (
            <p className={styles.fieldError}>No current AOA account records are linked to this client.</p>
          ) : (
            <div className={styles.checkGrid}>
              {selectedClient.accounts.map((account) => (
                <label key={account.id} className={styles.checkOption}>
                  <input
                    type="checkbox"
                    name="accountIds"
                    value={account.id}
                    checked={selectedAccountIds.includes(account.id)}
                    onChange={(event) => setSelectedAccountIds((current) => (
                      event.target.checked
                        ? [...current, account.id]
                        : current.filter((value) => value !== account.id)
                    ))}
                  />
                  <span>{account.label}{account.status ? ` · ${account.status}` : ""}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <label className={styles.full}>
          {isFeeCredit ? "Reason or context (optional)" : "Reason for waiver"}
          <textarea name="reason" rows={4} maxLength={2000} required={!isFeeCredit} placeholder={isFeeCredit ? "Add context for the reviewer" : "Explain why this exception is needed"} />
        </label>
        <label className={styles.full}>
          Relevant Zendesk or CRM tickets (optional)
          <input name="relevantTicketRefs" placeholder="Enter ticket numbers separated by commas" />
        </label>
      </div>

      <div className={styles.submitRow}>
        <p>Submitting creates a pending review. It does not credit a fee or change billing. Slack notifications are disabled in development.</p>
        <button
          type="submit"
          disabled={
            !selectedClient
            || selectedClient.accounts.length === 0
            || selectedAccountIds.length === 0
            || (isFeeCredit && selectedFeeTypes.length === 0)
          }
        >
          Submit for review
        </button>
      </div>
    </form>
  );
}
