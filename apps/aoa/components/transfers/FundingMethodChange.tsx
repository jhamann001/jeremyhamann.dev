"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui";
import { changeFundingMethod, prepareFundingMethodChange, confirmFundingMethodInitiated } from "@/app/(authenticated)/asset-transfer/funding-method-actions";
import {
  fundingRouteFamily,
  type FundingMethodChangePreparation,
  type FundingMethodCorrectionRow,
} from "@/lib/data/transfer-funding-method-change";
import { FUNDING_TYPES, FUNDING_TYPE_LABEL, stageLabel, type FundingType, type TransferDecisionChoice, type TransferStage } from "@/lib/data/transfer-types";
import styles from "./FundingMethodChange.module.css";

type Props = {
  transferId: string;
  stage: TransferStage;
  fundingType: FundingType | null;
  planVersion: number;
  methodRevision: number;
  hasAcatLink: boolean;
};

/** Explicit method revisions are independent of the Preparation plan draft. */
export function FundingMethodChange(props: Props) {
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <button ref={triggerRef} type="button" className={styles.trigger} onClick={() => { setNotice(null); setOpen(true); }}>
        Change funding method
      </button>
      {notice && <p className={styles.success} role="status">{notice}</p>}
      {open && <FundingMethodDialog
        {...props}
        onClose={() => setOpen(false)}
        restoreFocus={() => triggerRef.current?.focus()}
        onSaved={() => {
          setOpen(false);
          setNotice(props.stage === "FUNDED" ? "Funding method corrected. The approved plan is unchanged." : "Funding method changed and plan approved.");
          router.refresh();
        }}
      />}
    </>
  );
}

function FundingMethodDialog({ onClose, onSaved, restoreFocus, ...props }: Props & {
  onClose: () => void;
  onSaved: () => void;
  restoreFocus: () => void;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const mountedRef = useRef(false);
  const submittingRef = useRef(false);
  const generationRef = useRef(0);
  const returnFocusRef = useRef(restoreFocus);
  const funded = props.stage === "FUNDED";
  const [fundingType, setFundingType] = useState<FundingType | "">("");
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<FundingMethodChangePreparation | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [basis, setBasis] = useState<Record<string, TransferDecisionChoice>>({});
  const [positions, setPositions] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    if (submittingRef.current || funded) return;
    const generation = ++generationRef.current;
    setLoading(true);
    setLoadError(null);
    setReviewed(false);
    try {
      const result = await prepareFundingMethodChange(props.transferId);
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (result.ok) {
        setData(result);
        setBasis(Object.fromEntries(result.basisDecisions.map((row) => [row.decisionId, row.decision])));
        setPositions(Object.fromEntries(result.partialPositions.map((row) => [row.symbol, row.isTransferring])));
      } else {
        setData(null);
        setLoadError(result.errors.map((error) => error.message).join(" "));
      }
    } catch {
      if (mountedRef.current && generation === generationRef.current) {
        setData(null);
        setLoadError("The funding instructions could not be loaded. Try again.");
      }
    } finally {
      if (mountedRef.current && generation === generationRef.current) setLoading(false);
    }
  }, [funded, props.transferId]);

  useEffect(() => {
    mountedRef.current = true;
    const dialog = dialogRef.current;
    const returnFocus = returnFocusRef.current;
    dialog?.showModal();
    selectRef.current?.focus();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      dialog?.close();
      returnFocus();
    };
  }, []);

  const partial = !funded && fundingType === "ACAT_PARTIAL";
  const missingPositions = partial && (!data || data.source === "none");
  const submit = async () => {
    if (submittingRef.current || !fundingType || fundingType === props.fundingType || !reason.trim() || !reviewed || missingPositions || (partial && (loading || !data))) return;
    submittingRef.current = true;
    setPending(true);
    setErrors([]);
    let saved = false;
    try {
      const result = await changeFundingMethod(props.transferId, {
        expectedStage: props.stage,
        basePlanVersion: props.planVersion,
        baseMethodRevision: props.methodRevision,
        fundingType,
        reason,
        affectedWorkReviewed: reviewed,
        ...(partial && data ? {
          sourceFingerprint: data.sourceFingerprint,
          basisDecisions: data.basisDecisions.map((row) => ({ decisionId: row.decisionId, decision: basis[row.decisionId] ?? row.decision })),
          partialPositions: data.partialPositions.map((row) => ({ symbol: row.symbol, isTransferring: positions[row.symbol] ?? row.isTransferring })),
        } : {}),
      });
      if (!mountedRef.current) return;
      if (result.ok) saved = true;
      else {
        setErrors(result.errors.map((error) => error.message));
        setReviewed(false);
      }
    } catch {
      if (mountedRef.current) {
        setErrors(["The change could not be confirmed. Your draft is still here. Refresh the transfer to check its saved method before trying again."]);
        setReviewed(false);
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
    if (saved && mountedRef.current) onSaved();
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); if (!submittingRef.current) onClose(); }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")).filter((element) => !element.matches(":disabled") && element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = elements[0];
        const last = elements[elements.length - 1];
        const active = event.currentTarget.ownerDocument.activeElement;
        if (!first) { event.preventDefault(); event.currentTarget.focus(); }
        else if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) { event.preventDefault(); first.focus(); }
      }}
    >
      <div className={styles.header}>
        <h2 id={`${id}-title`}>{funded ? "Correct recorded funding method" : "Change funding method"}</h2>
        <p id={`${id}-description`} className={styles.note}>{funded
          ? "Record how this transfer was funded. Its approved plan and completed work will stay intact."
          : "Review the revised instructions and approve the funding method for this transfer."}</p>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className={styles.body} aria-busy={loading || pending}>
          <p className={styles.current}>Current method: <strong>{props.fundingType ? FUNDING_TYPE_LABEL[props.fundingType] : "Not selected"}</strong> · {stageLabel(props.stage)}</p>
          <label className={styles.label} htmlFor={`${id}-method`}>New funding method</label>
          <select ref={selectRef} id={`${id}-method`} value={fundingType} disabled={pending} required className={styles.field} onChange={(event) => {
            const method = event.target.value as FundingType | "";
            setFundingType(method); setReviewed(false); setErrors([]);
            if (!funded && method === "ACAT_PARTIAL" && !data && !loading) void load();
          }}>
            <option value="">Choose a method</option>
            {FUNDING_TYPES.map((method) => <option key={method} value={method} disabled={method === props.fundingType}>{FUNDING_TYPE_LABEL[method]}</option>)}
          </select>
          <label className={styles.label} htmlFor={`${id}-reason`}>Reason for the change</label>
          <textarea id={`${id}-reason`} className={styles.field} rows={3} maxLength={500} required value={reason} disabled={pending} placeholder="For example: Expected a wire; the deposit arrived by ACH." onChange={(event) => { setReason(event.target.value); setReviewed(false); }} />
          <p className={styles.note}>Required · {reason.length}/500 characters</p>
          {partial && loading && <p className={styles.note} role="status">Loading current funding instructions…</p>}
          {partial && loadError && <div className={styles.error} role="alert"><p>{loadError}</p><Button size="sm" variant="ghost" disabled={loading || pending} onClick={() => void load()}>Reload instructions</Button></div>}
          {partial && !loading && data && (
            <fieldset className={styles.positions} disabled={pending}>
              <legend>Review every position</legend>
              {data.source === "none" ? <p className={styles.note}>Link an asset map or add position decisions before changing to ACAT-Partial.</p> : data.source === "asset-map" ? <>
                <p className={styles.note}>Select the securities to transfer. At least one must be selected.</p>
                {data.partialPositions.map((row) => <label className={styles.check} key={row.symbol}>
                  <input type="checkbox" checked={positions[row.symbol] ?? row.isTransferring} onChange={(event) => { setPositions((current) => ({ ...current, [row.symbol]: event.target.checked })); setReviewed(false); }} />
                  <span>{row.symbol}</span>
                </label>)}
              </> : <>
                <p className={styles.note}>Resolve every position and select at least one to bring in.</p>
                {data.basisDecisions.map((row) => <label key={row.decisionId} className={styles.position}>
                  <span>{row.symbol}</span>
                  <select className={styles.field} aria-label={`Decision for ${row.symbol}`} value={basis[row.decisionId] ?? row.decision} onChange={(event) => { setBasis((current) => ({ ...current, [row.decisionId]: event.target.value as TransferDecisionChoice })); setReviewed(false); }}>
                    <option value="UNDECIDED">Undecided</option><option value="BRING_IN">Bring in</option><option value="LEAVE_GIFT">Leave / gift</option>
                  </select>
                </label>)}
              </>}
              {data.source !== "none" && <Button size="sm" variant="ghost" disabled={pending || loading} onClick={() => void load()}>Reload positions</Button>}
            </fieldset>
          )}
          {fundingType && <section className={styles.review} aria-label="Affected work">
            <h3>Review affected work</h3>
            <ul>
              {funded ? <>
                <li>The recorded method will change to {FUNDING_TYPE_LABEL[fundingType]}. The saved approval stays unchanged.</li>
                <li>The transfer stays Funded. Completed tasks, account links and exceptions stay as they are.</li>
              </> : <>
                <li>A new approved plan will use {FUNDING_TYPE_LABEL[fundingType]}. Earlier approvals remain in history.</li>
                <li>The transfer stays {stageLabel(props.stage)}. Its owner, links and exceptions stay as they are.</li>
                {fundingRouteFamily(props.fundingType) !== fundingRouteFamily(fundingType) || fundingType === "ACAT_PARTIAL" || (props.fundingType === "ACAT_PARTIAL" && fundingType === "ACAT_FULL")
                  ? <li>Funding initiation and cash-in-flight checks will reset. Complete the new method&apos;s required workflow or confirm actual initiation before advancing.</li>
                  : <li>Existing readiness and funding-initiation checks stay unchanged. Confirm that they still apply to the revised instructions.</li>}
                {fundingType === "DRS" && <li>DRS tasks will start again for this plan. Earlier task statuses will be retained in the change history.</li>}
                {fundingType === "ACAT_PARTIAL" && <li>Partial-ACAT execution tasks will start again for the reviewed securities instructions.</li>}
                {(props.fundingType === "DRS" || props.fundingType === "ACAT_PARTIAL") && fundingType !== props.fundingType && <li>The previous method&apos;s workflow will no longer be active. Its task history is retained.</li>}
                <li>Saving replaces any unsaved edits in Funding plan &amp; positions on this page.</li>
              </>}
              {props.hasAcatLink && <li>The existing ACAT link stays attached. Check that it still belongs to this transfer.</li>}
              <li>This change does not submit, cancel or change instructions at a custodian.</li>
            </ul>
          </section>}
          <label className={styles.check}>
            <input type="checkbox" checked={reviewed} disabled={pending || !fundingType || (partial && (loading || !data))} onChange={(event) => setReviewed(event.target.checked)} />
            <span>{funded ? "I reviewed the correction and existing links." : "I reviewed the instructions, tasks, readiness checks, existing links and unsaved edits."}</span>
          </label>
          {errors.length > 0 && <div className={styles.error} role="alert">{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
        </div>
        <div className={styles.footer}>
          <Button variant="ghost" disabled={pending} onClick={() => { if (!submittingRef.current) onClose(); }}>Cancel</Button>
          <Button type="submit" disabled={pending || !fundingType || !reason.trim() || !reviewed || missingPositions || (partial && (loading || !data))}>
            {pending ? "Saving…" : funded ? "Save correction" : "Review and approve change"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}

export function FundingMethodHistory({ entries }: { entries: FundingMethodCorrectionRow[] }) {
  return <ol className={styles.history}>{entries.map((entry) => <li key={entry.id}>
    <strong>{entry.previousFundingType ? FUNDING_TYPE_LABEL[entry.previousFundingType] : "Not selected"} → {FUNDING_TYPE_LABEL[entry.fundingType]}</strong>
    <p>{entry.reason}</p>
    <p className={styles.note}>{entry.kind === "RECORDED_CORRECTION" ? `Recorded correction · original plan version ${entry.basePlanVersion} retained` : `Plan approved · version ${entry.planVersion}`} · {stageLabel(entry.stage)}</p>
    <p className={styles.note}>{entry.changedBy} · <time dateTime={entry.changedAt}>{new Date(entry.changedAt).toLocaleString("en-US", { timeZone: "UTC", timeZoneName: "short" })}</time></p>
  </li>)}</ol>;
}


/** Review is not proof of initiation; route changes expose a separate factual confirmation. */
export function FundingMethodInitiation({ canWrite, ...props }: Props & { canWrite: boolean }) {
  const router = useRouter();
  const submittingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const wasConfirmingRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (confirming) confirmationRef.current?.focus();
    else if (wasConfirmingRef.current) triggerRef.current?.focus();
    wasConfirmingRef.current = confirming;
  }, [confirming]);
  const method = props.fundingType;
  const specialized = method === "DRS" || method === "ACAT_PARTIAL";
  const missingLink = method === "ACAT_FULL" && !props.hasAcatLink;
  const submit = async () => {
    if (submittingRef.current || !confirmed || !canWrite || props.stage === "FUNDED" || specialized || missingLink) return;
    submittingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await confirmFundingMethodInitiated(props.transferId, {
        expectedStage: props.stage,
        basePlanVersion: props.planVersion,
        baseMethodRevision: props.methodRevision,
      });
      if (!result.ok) { setError(result.errors.map((item) => item.message).join(" ")); setConfirmed(false); }
      else { setConfirming(false); router.refresh(); }
    } catch { setError("Funding initiation could not be confirmed. Refresh the transfer and check before trying again."); setConfirmed(false); }
    finally { submittingRef.current = false; setPending(false); }
  };
  return <section className={styles.review} aria-label="Funding initiation review">
    <h3>Confirm the new funding instructions</h3>
    <p>{specialized
      ? `Complete the ${method === "DRS" ? "DRS workflow" : "partial-ACAT execution tasks"} for the new plan before advancing the transfer.`
      : `Confirm that funding has actually been initiated using ${method ? FUNDING_TYPE_LABEL[method] : "the new method"}. Reviewing the change alone does not confirm initiation.`}</p>
    {method === "ACAT_PARTIAL" && <Link className={styles.trigger} href="/tasks">Open Tasks →</Link>}
    {method === "DRS" && <a className={styles.trigger} href="#transfer-drs-workflow">Review DRS workflow below ↓</a>}
    {missingLink && <p>Link and review the ACAT in Information &amp; linked records first.</p>}
    {canWrite && !specialized && !missingLink && method && (confirming ? <>
      <label className={styles.check}><input ref={confirmationRef} type="checkbox" checked={confirmed} disabled={pending} onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirmed that funding has actually been initiated using {FUNDING_TYPE_LABEL[method]}.</span></label>
      <div className={styles.inlineActions}>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => { if (!submittingRef.current) { setConfirming(false); setConfirmed(false); } }}>Cancel</Button>
        <Button size="sm" disabled={pending || !confirmed} onClick={() => void submit()}>{pending ? "Confirming…" : "Confirm funding initiated"}</Button>
      </div>
    </> : <button ref={triggerRef} type="button" className={styles.trigger} onClick={() => { setConfirming(true); setError(null); }}>Confirm funding initiated for {FUNDING_TYPE_LABEL[method]}</button>)}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;
}
