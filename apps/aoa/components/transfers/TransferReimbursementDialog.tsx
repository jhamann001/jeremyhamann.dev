"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  lookupPendingReimbursements,
  previewTransferReimbursement,
  submitTransferReimbursement,
} from "@/app/(authenticated)/acat-tracking/reimbursement-actions";
import { searchOperationsFeeClients } from "@/app/(authenticated)/operations/fee-requests/actions";
import {
  defaultReimbursementFeeTypes,
  defaultReimbursementReason,
  newSubmissionKey,
  normalizeReimbursementAmount,
  parseReimbursementTickets,
  REIMBURSEMENT_COPY as COPY,
  REIMBURSEMENT_FAILURE_COPY,
  REIMBURSEMENT_FEE_TYPES,
  REIMBURSEMENT_REASON_MAX,
  REIMBURSEMENT_SEARCH_DEBOUNCE_MS,
  REIMBURSEMENT_SEARCH_MAX,
  REIMBURSEMENT_SEARCH_MIN,
  reimbursementDraftErrors,
  reimbursementRequestHref,
  type PendingReimbursement,
  type ReimbursementClient,
  type ReimbursementClientSource,
  type ReimbursementFailureCode,
  type ReimbursementField,
  type SubmittedReimbursement,
} from "@/lib/data/acat-reimbursement-view";
import type { OperationsFeeClientOption } from "@/lib/data/operations-fee-requests";
import { dialogKeyDown } from "./AcatTransferModals";
import type { TransferFeeRecord } from "./TransferFeeSection";
import { LoaderCircle, Receipt, X } from "./transfer-fee-icons";
import styles from "./TransferFeeSection.module.css";

type Phase = "loading" | "failed" | "ready";
type SearchState = "idle" | "loading" | "done" | "error";
type ClientNote = ReimbursementClientSource | "chosen";

const FIELD_LABEL: Record<ReimbursementField, string> = {
  client: "Client", account: "Apex account", amount: "Fee amount", feeTypes: "Fee types", reason: "Reason", tickets: "Relevant tickets",
};

function toClient(option: OperationsFeeClientOption): ReimbursementClient {
  return {
    clientSfId: option.clientSfId,
    name: option.name,
    householdName: option.householdName,
    accounts: option.accounts.map((account) => ({ id: account.id, label: account.label, status: account.status, matchesTransfer: false })),
  };
}

function singleTicket(value: string | null): string {
  const text = (value ?? "").trim();
  return text !== "" && text.length <= 80 && !/[\n,]/.test(text) ? text : "";
}

/**
 * The preview the user reviews before anything is written (ticket). It opens from Log
 * Reimbursement, prefills the client, account, fee amount and fee type from the open transfer,
 * and lets the user edit every field. Confirm calls `submitTransferReimbursement` once with the
 * values on screen; Cancel and Escape call nothing that writes.
 */
export function TransferReimbursementDialog({ recordId, record, feeAmount, feeApexTicket, requestsHref, onClose, onSubmitted }: {
  recordId: string;
  record: TransferFeeRecord;
  feeAmount: string | null;
  feeApexTicket: string | null;
  requestsHref: string | null;
  onClose: () => void;
  onSubmitted: (request: SubmittedReimbursement, shown: { clientName: string; accountLabel: string }) => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [submissionKey] = useState(newSubmissionKey);
  const contraName = record.transferringContra || record.custodianName || null;

  const [phase, setPhase] = useState<Phase>("loading");
  const [loadCode, setLoadCode] = useState<ReimbursementFailureCode>("unavailable");
  const [client, setClient] = useState<ReimbursementClient | null>(null);
  const [clientNote, setClientNote] = useState<ClientNote>("none");
  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState(() => normalizeReimbursementAmount(feeAmount) ?? "");
  const [feeTypes, setFeeTypes] = useState<string[]>(() => defaultReimbursementFeeTypes(record.direction));
  const [reason, setReason] = useState(() => defaultReimbursementReason({ recordId, controlNumber: record.controlNumber, contraName }));
  const [tickets, setTickets] = useState(() => singleTicket(feeApexTicket));
  const [touched, setTouched] = useState<Partial<Record<ReimbursementField, boolean>>>({});

  const [pending, setPending] = useState<PendingReimbursement[]>([]);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [pendingFailed, setPendingFailed] = useState(false);

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OperationsFeeClientOption[]>([]);
  const [searchState, setSearchState] = useState<SearchState>("idle");

  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ code: ReimbursementFailureCode; field: ReimbursementField | null } | null>(null);

  const loadToken = useRef(0);
  const pendingToken = useRef(0);
  const searchToken = useRef(0);
  const submittingRef = useRef(false);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    setPhase("loading");
    try {
      const res = await previewTransferReimbursement(recordId, {
        cedarRidgeUserId: record.cedarRidgeUserId ?? null,
        maskedAccount: record.apexAccountId,
      });
      if (loadToken.current !== token) return;
      if (!res.ok) { setLoadCode(res.code); setPhase("failed"); return; }
      const { prefill } = res;
      setClient(prefill.client);
      setClientNote(prefill.clientSource);
      setAccountId(prefill.accountId ?? "");
      setPending(prefill.pending);
      setPendingKey(prefill.client && prefill.accountId ? `${prefill.client.clientSfId}\u0000${prefill.accountId}` : null);
      setSearching(prefill.client === null);
      setPhase("ready");
    } catch {
      if (loadToken.current !== token) return;
      setLoadCode("unavailable");
      setPhase("failed");
    }
  }, [recordId, record.cedarRidgeUserId, record.apexAccountId]);

  useEffect(() => {
    void load();
    return () => { loadToken.current += 1; };
  }, [load]);

  // Focus moves into the form once it is ready and returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => opener?.focus();
  }, []);
  useEffect(() => {
    if (phase === "ready") dialogRef.current?.querySelector<HTMLElement>("select, input, textarea")?.focus();
  }, [phase]);

  // Pending requests for whatever client and account are chosen now.
  const chosenKey = client && accountId ? `${client.clientSfId}\u0000${accountId}` : null;
  useEffect(() => {
    if (phase !== "ready") return;
    if (chosenKey === null) { setPending([]); setPendingKey(null); setPendingFailed(false); return; }
    if (chosenKey === pendingKey) return;
    const token = ++pendingToken.current;
    const [clientSfId, account] = chosenKey.split("\u0000");
    setPendingFailed(false);
    void lookupPendingReimbursements(clientSfId, account).then((res) => {
      if (pendingToken.current !== token) return;
      if (res.ok) { setPending(res.pending); setPendingKey(chosenKey); } else { setPending([]); setPendingKey(chosenKey); setPendingFailed(true); }
    }).catch(() => {
      if (pendingToken.current !== token) return;
      setPending([]);
      setPendingKey(chosenKey);
      setPendingFailed(true);
    });
  }, [phase, chosenKey, pendingKey]);

  // Debounced client search, by name text only. The result carries ids; only an id is ever saved.
  useEffect(() => {
    if (!searching) return;
    const text = query.trim();
    if (text.length < REIMBURSEMENT_SEARCH_MIN) { setResults([]); setSearchState("idle"); return; }
    const token = ++searchToken.current;
    const timer = setTimeout(async () => {
      setSearchState("loading");
      try {
        const found = await searchOperationsFeeClients(text);
        if (searchToken.current !== token) return;
        setResults(found);
        setSearchState("done");
      } catch {
        if (searchToken.current !== token) return;
        setSearchState("error");
      }
    }, REIMBURSEMENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, searching]);

  const accounts = client?.accounts ?? [];
  const errors = useMemo(
    () => reimbursementDraftErrors(
      { clientSfId: client?.clientSfId ?? "", accountId, feeAmount: amount, feeTypes, reason, tickets },
      (client?.accounts ?? []).map((a) => a.id),
    ),
    [client, accountId, amount, feeTypes, reason, tickets],
  );
  const missing = (Object.keys(errors) as ReimbursementField[]).map((field) => FIELD_LABEL[field]);
  const canConfirm = phase === "ready" && missing.length === 0 && !submitting;
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const fieldError = (field: ReimbursementField): string | null =>
    failure?.field === field ? REIMBURSEMENT_FAILURE_COPY.invalid : touched[field] ? errors[field] ?? null : null;
  const touch = (field: ReimbursementField) => setTouched((t) => (t[field] ? t : { ...t, [field]: true }));

  function pick(option: OperationsFeeClientOption) {
    const next = toClient(option);
    setClientNote("chosen");
    if (!client || client.clientSfId !== next.clientSfId) setAccountId("");
    setClient(next);
    setSearching(false);
    setQuery("");
    setResults([]);
    setSearchState("idle");
    touch("client");
  }

  function toggleType(type: string) {
    setFeeTypes((current) => (current.includes(type) ? current.filter((t) => t !== type) : [...current, type]));
    touch("feeTypes");
  }

  async function confirm() {
    if (submittingRef.current || !canConfirm || !client || !account) return;
    const normalized = normalizeReimbursementAmount(amount);
    if (normalized === null) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const res = await submitTransferReimbursement({
        submissionKey, clientSfId: client.clientSfId, accountId, feeAmount: normalized, feeTypes, reason: reason.trim(), tickets,
      });
      if (res.ok) {
        onSubmitted(res.request, { clientName: client.name, accountLabel: account.label });
        return;
      }
      setFailure({ code: res.code, field: res.field });
    } catch {
      setFailure({ code: "failed", field: null });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const clientNoteText = clientNote === "transfer-link" ? COPY.linkedClient
    : clientNote === "directory" ? COPY.directoryClient
      : clientNote === "conflict" && !client ? COPY.conflictClient
        : null;
  const accountPrefilled = Boolean(account?.matchesTransfer);

  return (
    <div className={styles.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} data-acat-dialog tabIndex={-1}
        data-testid="reimbursement-dialog" className={`${styles.dialog} ${styles.dialogWide}`}
        onKeyDown={(e) => dialogKeyDown(e, dialogRef, onClose, submitting)}>
        <div className={styles.dialogHead}>
          <div className={styles.dialogIcon}><Receipt size={20} /></div>
          <div className={styles.dialogHeadText}>
            <h3 id={titleId} className={styles.dialogTitle}>{COPY.title}</h3>
            <p className={styles.dialogSub}>{COPY.subtitle}</p>
          </div>
          <button type="button" className={`${styles.iconButton} ${styles.dialogClose}`} aria-label={COPY.closePreview} disabled={submitting} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {phase === "loading" && (
          <div className={styles.checking} role="status">
            <LoaderCircle size={14} className={styles.spin} />
            <span>{COPY.loading}</span>
          </div>
        )}

        {phase === "failed" && (
          <div role="alert" className={styles.logFailure}>
            <span>{loadCode === "unavailable" ? COPY.loadFailed : REIMBURSEMENT_FAILURE_COPY[loadCode]}</span>
            {loadCode === "unavailable" && <button type="button" className={styles.retry} onClick={() => void load()}>{COPY.retry}</button>}
          </div>
        )}

        {phase === "ready" && (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void confirm(); }} noValidate>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>{COPY.client}</span>
              <div className={styles.clientBox} data-testid="reimbursement-client">
                <div>
                  {client ? (
                    <>
                      <p className={styles.clientName}>{client.name}</p>
                      {client.householdName && <p className={styles.clientMeta}>{COPY.household}: {client.householdName}</p>}
                      {clientNoteText && <p className={styles.clientMeta}>{clientNoteText}</p>}
                    </>
                  ) : (
                    <p className={styles.clientEmpty}>{clientNoteText ?? COPY.noClient}</p>
                  )}
                </div>
                {client && !searching && (
                  <button type="button" className={styles.smallButton} disabled={submitting} onClick={() => setSearching(true)}>{COPY.changeClient}</button>
                )}
              </div>
              {searching && (
                <>
                  <input type="text" className={styles.fieldControl} aria-label={COPY.clientSearch} placeholder={COPY.clientSearchHint}
                    maxLength={REIMBURSEMENT_SEARCH_MAX} value={query} disabled={submitting} onChange={(e) => setQuery(e.target.value)} />
                  {searchState === "loading" && <p className={styles.fieldHint} role="status">{COPY.clientSearching}</p>}
                  {searchState === "error" && <p className={styles.fieldError} role="alert">{COPY.clientSearchFailed}</p>}
                  {searchState === "done" && results.length === 0 && <p className={styles.fieldHint}>{COPY.clientNoMatch}</p>}
                  {results.length > 0 && (
                    <div className={styles.searchResults} role="listbox" aria-label="Matching clients">
                      {results.map((option) => (
                        <button key={option.clientSfId} type="button" role="option" aria-selected={false} className={styles.searchResult}
                          onClick={() => pick(option)}>
                          <span className={styles.clientName}>{option.name}</span>
                          {option.householdName && <span className={styles.clientMeta}>{COPY.household}: {option.householdName}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  {client && <button type="button" className={styles.ghostButton} onClick={() => { setSearching(false); setQuery(""); }}>{COPY.cancel}</button>}
                </>
              )}
              {fieldError("client") && <p className={styles.fieldError}>{fieldError("client")}</p>}
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>{COPY.account}</span>
              <select className={styles.fieldControl} aria-label={COPY.account} value={accountId} disabled={!client || submitting}
                aria-invalid={Boolean(fieldError("account"))}
                onChange={(e) => { setAccountId(e.target.value); touch("account"); }}>
                <option value="">{COPY.chooseAccount}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}{a.status ? ` · ${a.status}` : ""}{a.matchesTransfer ? ` · ${COPY.accountMatch}` : ""}
                  </option>
                ))}
              </select>
              {client && accounts.length === 0 && <span className={styles.fieldHint}>{COPY.accountNone}</span>}
              {record.apexAccountId && <span className={styles.fieldHint}>{COPY.accountHelp} {record.apexAccountId}.</span>}
              {client && !accountId && !accountPrefilled && <span className={styles.fieldHint}>{COPY.accountNotResolved}</span>}
              {fieldError("account") && <span className={styles.fieldError}>{fieldError("account")}</span>}
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>{COPY.amount}</span>
              <input type="text" inputMode="decimal" className={styles.fieldControl} aria-label={COPY.amount} value={amount} disabled={submitting}
                aria-invalid={Boolean(fieldError("amount"))}
                onChange={(e) => { setAmount(e.target.value); touch("amount"); }} onBlur={() => touch("amount")} />
              {fieldError("amount") && <span className={styles.fieldError}>{fieldError("amount")}</span>}
            </label>

            <fieldset className={`${styles.field} ${styles.fieldset}`}>
              <legend className={styles.fieldLabel}>{COPY.feeTypes}</legend>
              <div className={styles.typeGrid}>
                {REIMBURSEMENT_FEE_TYPES.map((type) => (
                  <label key={type} className={styles.typeOption}>
                    <input type="checkbox" checked={feeTypes.includes(type)} disabled={submitting} onChange={() => toggleType(type)} />
                    <span>{type}</span>
                  </label>
                ))}
              </div>
              {fieldError("feeTypes") && <span className={styles.fieldError}>{fieldError("feeTypes")}</span>}
            </fieldset>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>{COPY.reason}</span>
              <textarea className={styles.fieldControl} aria-label={COPY.reason} rows={3} value={reason} disabled={submitting}
                maxLength={REIMBURSEMENT_REASON_MAX + 200} aria-invalid={Boolean(fieldError("reason"))}
                onChange={(e) => { setReason(e.target.value); touch("reason"); }} />
              {fieldError("reason") && <span className={styles.fieldError}>{fieldError("reason")}</span>}
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>{COPY.tickets}</span>
              <textarea className={styles.fieldControl} aria-label={COPY.tickets} rows={2} value={tickets} disabled={submitting}
                aria-invalid={Boolean(fieldError("tickets"))}
                onChange={(e) => { setTickets(e.target.value); touch("tickets"); }} />
              <span className={styles.fieldHint}>{COPY.ticketsHint}{parseReimbursementTickets(tickets).length > 0 ? ` ${parseReimbursementTickets(tickets).length} on this request.` : ""}</span>
              {fieldError("tickets") && <span className={styles.fieldError}>{fieldError("tickets")}</span>}
            </label>

            {pending.length > 0 && (
              <div className={styles.pendingBox} role="status" data-testid="reimbursement-pending">
                <p className={styles.pendingTitle}>{COPY.pendingTitle}</p>
                <ul className={styles.pendingList}>
                  {pending.map((row) => (
                    <li key={row.id} className={styles.pendingRow}>
                      <span>${row.feeAmount ?? "—"} · {row.feeTypes.join(", ") || "—"} · {row.submittedAt.slice(0, 10)}</span>
                      {requestsHref && (
                        <Link href={reimbursementRequestHref(requestsHref, row.id)} className={styles.pendingLink}>{COPY.pendingOpen}</Link>
                      )}
                    </li>
                  ))}
                </ul>
                <p className={styles.fieldHint}>{COPY.pendingNote}</p>
              </div>
            )}
            {pendingFailed && <p className={styles.fieldHint}>The pending requests for this account could not be checked.</p>}

            {failure && failure.field === null && (
              <div role="alert" className={styles.dialogError}>{REIMBURSEMENT_FAILURE_COPY[failure.code]}</div>
            )}
          </form>
        )}

        <div className={styles.dialogFoot}>
          {phase === "ready" && missing.length > 0 && <span className={styles.dialogMissing}>Complete: {missing.join(", ")}</span>}
          <button type="button" className={styles.cancelButton} disabled={submitting} onClick={onClose}>{COPY.cancel}</button>
          {phase === "ready" && (
            <button type="button" className={styles.confirmButton} disabled={!canConfirm} onClick={() => void confirm()}>
              {submitting ? COPY.confirming : COPY.confirm}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
