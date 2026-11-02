"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  applyTransferFeeRules,
  loadFeeRules,
  loadTransferFee,
  saveTransferFeeField,
} from "@/app/(authenticated)/acat-tracking/fee-actions";
import {
  FEE_COPY,
  FEE_FIELDS,
  FAILURE_COPY,
  feeFailureMessage,
  feeChargeState,
  feeSnapshotOf,
  headerBadge,
  isFullOutgoing,
  noScheduleOnFile,
  parseFeeAmount,
  ruleAmountLabel,
  ruleDetail,
  sameFeeSnapshot,
  selectedTotals,
  type FeeActionResult,
  type FeeFailureCode,
  type FeeField,
  type FeeRule,
  type FeeSnapshot,
  type TransferFee,
} from "@/lib/data/acat-fee-view";
import {
  ArrowRight,
  BookOpen,
  CircleAlert,
  CircleCheck,
  Clock,
  DollarSign,
  LoaderCircle,
  Pencil,
  Receipt,
  X,
} from "./transfer-fee-icons";
import { REIMBURSEMENT_COPY, reimbursementRequestHref, reimbursementStatusChip, type SubmittedReimbursement } from "@/lib/data/acat-reimbursement-view";
import styles from "./TransferFeeSection.module.css";

export type TransferFeeRecord = {
  clientName: string | null;
  direction: string | null;
  type: string | null;
  status: string | null;
  transferringContra: string | null;
  custodianName: string;
  controlNumber: string | null;
  apexAccountId: string | null;
  custodianId: string | null;
  transferWorkflow: string | null;
  /** The record's single linked Cedar Ridge user id; a hint for the reimbursement preview only (ticket). */
  cedarRidgeUserId?: string | null;
};

// Loaded only when the server enabled the requests-on-file list, so a closed release adds no code or imports.
const TransferFeeRequestsList = dynamic(
  () => import("./TransferFeeRequestsList").then((module) => module.TransferFeeRequestsList),
  { ssr: false },
);

// Loaded only when the preview opens, so a closed release (or a user who never clicks) adds no code or imports.
const TransferReimbursementDialog = dynamic(
  () => import("./TransferReimbursementDialog").then((module) => module.TransferReimbursementDialog),
  { ssr: false },
);

type Notice =
  | { kind: "success"; title: string; message: string }
  | { kind: "error"; title: string; message: string; retry: () => void };

const SUCCESS_NOTICE_MS = 6000;

type Submitted = { request: SubmittedReimbursement; clientName: string; accountLabel: string };

const TONE_CLASS = {
  warning: styles.toneWarning, info: styles.toneInfo, success: styles.toneSuccess, danger: styles.toneDanger, neutral: styles.toneNeutral,
} as const;

const BADGE_CLASS = { warning: styles.badgeWarning, success: styles.badgeSuccess, neutral: styles.badgeNeutral } as const;

function money(value: number): string {
  return `$${Number(value ?? 0).toFixed(2)}`;
}

// Escape cancels only this edit: the drawer listens for Escape on window.
function stopEscape(event: KeyboardEvent<HTMLElement>) {
  event.preventDefault();
  event.stopPropagation();
  event.nativeEvent.stopPropagation();
}

// `feeRequestsHref` is decided on the server (lib/operations/fee-request-link.ts): the Operations
// Tools fee-request route when the user may open it, else null. `reimbursement` is also decided on
// the server (ticket): when true, Log Reimbursement opens a preview the user edits and confirms,
// and confirming creates one Pending Operations Tools fee request. When false the section is the
// ticket link-out: status, history and Log Reimbursement are that page's, and nothing is written.
export function TransferFeeSection({ recordId, refreshToken, record, feeRequestsHref = null, reimbursement = false, requestsOnFile = false, showSchedule = true, readOnly = false, initialFee, initialRules, onFeeChanged }: {
  recordId: string;
  refreshToken: string;
  record: TransferFeeRecord;
  feeRequestsHref?: string | null;
  reimbursement?: boolean;
  /** Decided on the server: list the Operations Tools requests already on file for this transfer's client and account. */
  requestsOnFile?: boolean;
  /** Hide the legacy schedule when the containing workspace supplies the full custodian library. */
  showSchedule?: boolean;
  /** Archived transfers retain their stored details and reimbursement history without editing actions. */
  readOnly?: boolean;
  /** Immediately display the server's fee snapshot, then refresh it from the existing fee source. */
  initialFee?: TransferFee | null;
  /** Canonical rules already read for this custodian; the normal read still refreshes them. */
  initialRules?: readonly FeeRule[];
  /** Called with the stored fee's Fee review inputs whenever they change. */
  onFeeChanged?: (snapshot: FeeSnapshot) => void;
}) {
  const [fee, setFee] = useState<TransferFee | null>(initialFee ?? null);
  const [load, setLoad] = useState<"loading" | "ready" | "failed">("loading");
  const [loadCode, setLoadCode] = useState<FeeFailureCode>("transport");

  const [rules, setRules] = useState<FeeRule[]>([...(initialRules ?? [])]);
  const [rulesState, setRulesState] = useState<"loading" | "ready" | "failed">(initialRules ? "ready" : record.custodianId ? "loading" : "ready");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  const [editingField, setEditingField] = useState<FeeField | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  const [notice, setNotice] = useState<Notice | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [submitted, setSubmitted] = useState<Submitted[]>([]);

  const cancelEditRef = useRef(false);
  const savingRef = useRef<string | null>(null);
  const applyingRef = useRef(false);
  const request = useRef(0);

  // Fold a tracker answer into the section. The stored fee always replaces the
  // displayed one; any reimbursement log in the answer is ignored. The dialog's two fee
  // inputs go to the parent when they change (the first answer always reports); the ref
  // keeps `absorb` stable so a new callback never re-runs the load effect.
  const onFeeChangedRef = useRef(onFeeChanged);
  useEffect(() => { onFeeChangedRef.current = onFeeChanged; }, [onFeeChanged]);
  const reportedFee = useRef<FeeSnapshot | null>(null);
  const absorb = useCallback((res: FeeActionResult) => {
    if (!res.fee) return;
    setFee(res.fee);
    const next = feeSnapshotOf(res.fee);
    if (reportedFee.current !== null && sameFeeSnapshot(reportedFee.current, next)) return;
    reportedFee.current = next;
    onFeeChangedRef.current?.(next);
  }, []);

  const reload = useCallback(async () => {
    const current = ++request.current;
    try {
      const res = await loadTransferFee(recordId);
      if (request.current !== current) return;
      absorb(res);
      if (res.ok) { setLoad("ready"); return; }
      setLoadCode(res.code);
      setLoad("failed");
    } catch {
      if (request.current !== current) return;
      setLoadCode("transport");
      setLoad("failed");
    }
  }, [absorb, recordId]);

  useEffect(() => {
    void reload();
    return () => { request.current += 1; };
  }, [reload, refreshToken]);

  const loadRules = useCallback(async () => {
    if (!showSchedule || !record.custodianId) { setRules([]); setRulesState("ready"); return; }
    setRulesState("loading");
    try {
      const res = await loadFeeRules(record.custodianId);
      if (res.ok) { setRules(res.rules); setRulesState("ready"); } else setRulesState("failed");
    } catch {
      setRulesState("failed");
    }
  }, [record.custodianId, showSchedule]);

  useEffect(() => { void loadRules(); }, [loadRules]);

  useEffect(() => {
    if (notice?.kind !== "success") return;
    const timer = setTimeout(() => setNotice(null), SUCCESS_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const failure = useCallback((action: "save" | "apply", code: FeeFailureCode, retry: () => void) => {
    const { title, message } = feeFailureMessage(action, code);
    setNotice({ kind: "error", title, message, retry });
  }, []);

  const patchField = useCallback(async (field: FeeField, value: string) => {
    if (readOnly || savingRef.current === field) return;
    savingRef.current = field;
    setSaving(true);
    try {
      const res = await saveTransferFeeField(recordId, field, value);
      absorb(res);
      if (res.ok) {
        setNotice({ kind: "success", title: "Updated", message: `${field} saved` });
        // Only close the editor if THIS field is still the one open.
        setEditingField((current) => (current === field ? null : current));
      } else {
        failure("save", res.code, () => void patchField(field, value));
      }
    } catch {
      failure("save", "transport", () => void patchField(field, value));
    } finally {
      setSaving(false);
      if (savingRef.current === field) savingRef.current = null;
    }
  }, [absorb, failure, readOnly, recordId]);

  const selectedTotal = useMemo(() => selectedTotals(rules, selected), [rules, selected]);
  const selectedRules = useMemo(() => rules.filter((rule) => selected.has(rule.id)), [rules, selected]);

  const runApply = useCallback(async (ids: string[]) => {
    if (readOnly || ids.length === 0 || applyingRef.current || selectedTotals(rules, new Set(ids)).requiresAmountConfirmation) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      const res = await applyTransferFeeRules(recordId, ids);
      absorb(res);
      if (res.ok) {
        setSelected(new Set());
        setNotice({ kind: "success", title: "Applied", message: `${ids.length} fee${ids.length === 1 ? "" : "s"} applied to record` });
      } else {
        failure("apply", res.code, () => void runApply(ids));
      }
    } catch {
      failure("apply", "transport", () => void runApply(ids));
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  }, [absorb, failure, readOnly, recordId, rules]);

  const feeAmt = parseFeeAmount(fee?.feeAmount);
  const contraName = record.transferringContra || record.custodianName;

  const fullOut = isFullOutgoing({ direction: record.direction, type: record.type, transferWorkflow: record.transferWorkflow });
  const feeState = feeChargeState(fee);
  const hasFee = feeState === "charged";
  const hasPositiveAmount = feeAmt !== null && feeAmt > 0;
  const badge = headerBadge({ state: feeState, unavailable: load === "failed" });
  const loading = load === "loading" && !fee;

  function startEdit(field: FeeField) {
    if (readOnly) return;
    // A prior Escape unmounts the input before its blur clears the flag.
    cancelEditRef.current = false;
    setEditingField(field);
    setEditValue(fee?.[field] ?? "");
  }

  function endEdit() {
    setEditingField(null);
    setEditValue("");
  }

  function onEditBlur(field: FeeField) {
    if (cancelEditRef.current) { cancelEditRef.current = false; endEdit(); return; }
    void patchField(field, editValue);
  }

  function toggleRule(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <section className={styles.root} aria-label="Fee section" data-testid="transfer-fee-section">
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div className={styles.headLeft}>
            <DollarSign size={15} className={styles.accentIcon} />
            <h3 className={styles.cardTitle}>{FEE_COPY.title}</h3>
          </div>
          <span className={`${styles.badge} ${BADGE_CLASS[badge.tone]}`}>{badge.label}</span>
        </div>
        {load === "failed" && (
          <div className={styles.cardBody}>
            <div role="alert" className={styles.logFailure}>
              <span>{FAILURE_COPY[loadCode]}</span>
              {fee && <span>Showing previously loaded fee details.</span>}
              <button type="button" className={styles.retry} onClick={() => void reload()}>{FEE_COPY.retry}</button>
            </div>
          </div>
        )}
        {!(load === "failed" && !fee) && (
          <div className={styles.divide}>
            {FEE_FIELDS.map((field) => {
              const value = fee?.[field.key] ?? "";
              const isEditing = !readOnly && editingField === field.key;
              return (
                <div key={field.key} className={styles.row}>
                  <span className={styles.rowLabel}>{field.label}</span>
                  {isEditing ? (
                    <div className={styles.editWrap}>
                      {field.type === "select" ? (
                        <select value={editValue} aria-label={field.label} className={styles.input} autoFocus
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") { cancelEditRef.current = true; stopEscape(e); endEdit(); }
                          }}
                          onBlur={() => onEditBlur(field.key)}>
                          <option value="">—</option>
                          {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                      ) : (
                        <input type={field.type === "date" ? "date" : "text"} value={editValue} aria-label={field.label}
                          className={styles.input} autoFocus
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void patchField(field.key, editValue);
                            if (e.key === "Escape") { cancelEditRef.current = true; stopEscape(e); endEdit(); }
                          }}
                          onBlur={() => onEditBlur(field.key)} />
                      )}
                      {saving && <LoaderCircle size={14} className={`${styles.spin} ${styles.spinSuccess}`} />}
                      <button type="button" className={styles.iconButton} aria-label="Cancel edit"
                        onMouseDown={() => { cancelEditRef.current = true; }}
                        onClick={endEdit}>
                        <X size={14} />
                      </button>
                    </div>
                  ) : readOnly ? (
                    <div className={styles.editWrap}><span className={value ? styles.value : styles.valueEmpty}>{value || "—"}</span></div>
                  ) : (
                    <button type="button" className={styles.valueButton} aria-label={`Edit ${field.label}`} disabled={loading || load === "failed"}
                      onClick={() => startEdit(field.key)}>
                      <span className={value ? styles.value : styles.valueEmpty}>{value || "—"}</span>
                      <Pencil size={11} className={styles.pencil} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div role="status" aria-live="polite" className={styles.live}>
        {notice?.kind === "success" && (
          <div className={`${styles.notice} ${styles.noticeSuccess}`}>
            <span className={styles.noticeTitle}>{notice.title}</span> {notice.message}
          </div>
        )}
      </div>
      {!readOnly && notice?.kind === "error" && (
        <div role="alert" className={`${styles.notice} ${styles.noticeError}`}>
          <div className={styles.noticeRow}>
            <span><span className={styles.noticeTitle}>{notice.title}</span> {notice.message}</span>
            <button type="button" className={styles.retry} aria-label="Retry" onClick={notice.retry}>{FEE_COPY.retry}</button>
          </div>
        </div>
      )}

      {fullOut && (
        <div className={`${styles.panel} ${styles.panelWarning}`}>
          <p className={styles.panelTitle}>{FEE_COPY.fullOutTitle}</p>
          <p className={styles.panelText}>{FEE_COPY.fullOutBody}</p>
        </div>
      )}

      {showSchedule && (load !== "failed" || fee) && (
        <FeeSchedulePanel contraName={contraName} state={rulesState} rules={rules} selected={selected}
          onToggle={toggleRule} totals={selectedTotal} recordHasFee={hasFee || feeState === "review"} onApply={() => void runApply(selectedRules.map((rule) => rule.id))}
          applying={applying} readOnly={readOnly || load !== "ready"} onRetry={() => void loadRules()} />
      )}

      {hasFee && (
        <div className={styles.feeCard}>
          <p className={styles.feeCardLabel}>{FEE_COPY.cardLabel}</p>
          <p className={`${styles.feeCardAmount} ${hasPositiveAmount ? "" : styles.feeCardAmountZero}`}>{feeAmt === null ? FEE_COPY.amountNotRecorded : money(feeAmt)}</p>
          <p className={styles.feeCardDescription}>Fee from {contraName}</p>
        </div>
      )}

      {submitted.map(({ request, clientName: shownClient, accountLabel: shownAccount }) => {
        const chip = reimbursementStatusChip(request.status);
        return (
          <div key={request.id} className={styles.submittedCard} data-testid="reimbursement-submitted" role="status">
            <div className={styles.submittedHead}>
              <h3 className={styles.submittedTitle}><CircleCheck size={16} />{REIMBURSEMENT_COPY.successTitle}</h3>
              <span className={`${styles.statusChip} ${TONE_CLASS[chip.tone]}`}>{chip.label}</span>
            </div>
            <p className={styles.submittedBody}>
              {REIMBURSEMENT_COPY.successBody} {request.feeAmount ? `$${request.feeAmount}` : ""}{request.feeTypes.length > 0 ? ` · ${request.feeTypes.join(", ")}` : ""}
            </p>
            <p className={styles.submittedMeta}>{request.clientName ?? shownClient} · {request.accountLabel ?? shownAccount}</p>
            {feeRequestsHref && (
              <p className={styles.submittedMeta}>
                <Link href={reimbursementRequestHref(feeRequestsHref, request.id)} className={styles.pendingLink}>{REIMBURSEMENT_COPY.successOpen}</Link>
              </p>
            )}
          </div>
        );
      })}

      {requestsOnFile && (
        <TransferFeeRequestsList recordId={recordId} cedarRidgeUserId={record.cedarRidgeUserId ?? null} maskedAccount={record.apexAccountId}
          feeRequestsHref={feeRequestsHref} feeCreditRequestId={fee?.feeCreditRequestId ?? null} reloadKey={submitted.length} />
      )}

      {feeRequestsHref && !(load === "failed" && !fee) && (
        <div className={`${styles.card} ${styles.cardBody}`} data-testid="fee-requests-link-card">
          <div className={styles.requestsRow}>
            <div>
              <h3 className={styles.requestsTitle}>{FEE_COPY.requestsTitle}</h3>
              <p className={styles.requestsText}>{FEE_COPY.requestsBody}</p>
            </div>
            <Link href={feeRequestsHref} className={styles.requestsLink}>
              {FEE_COPY.requestsLink}
              <ArrowRight size={11} />
            </Link>
          </div>
        </div>
      )}

      {!loading && load !== "failed" && (hasFee ? !readOnly && (
        <div className={`${styles.panel} ${styles.panelWarning} ${styles.panelAction}`}>
          <div className={styles.panelRow}>
            <div>
              <div className={styles.actionHead}>
                <div className={styles.actionIcon}><CircleAlert size={16} /></div>
                <h3 className={styles.actionTitle}>{FEE_COPY.actionRequired}</h3>
              </div>
              <p className={styles.actionText}>
                {feeAmt === null ? <>A fee is recorded for this transfer, but its amount has not been documented. </> : <>The recorded fee amount is <strong>{fee?.feeAmount}</strong>. </>}
                {FEE_COPY.reimbursementReviewBody}
              </p>
              <p className={styles.actionMeta}>
                {record.controlNumber && `Control #: ${record.controlNumber} · `}
                Apex Account: {record.apexAccountId}
              </p>
              {feeRequestsHref && hasPositiveAmount && (
                <p className={styles.actionMeta}>{reimbursement ? REIMBURSEMENT_COPY.linkNote : FEE_COPY.logLinkNote}</p>
              )}
            </div>
            {!reimbursement && feeRequestsHref === null ? (
              <p className={styles.actionUnavailable}>{FEE_COPY.logUnavailable}</p>
            ) : !hasPositiveAmount ? (
              <button type="button" className={styles.logButton} disabled title={FEE_COPY.enterAmountTitle}>
                <Receipt size={14} />
                {FEE_COPY.enterAmountFirst}
              </button>
            ) : reimbursement ? (
              <button type="button" className={styles.logButton} aria-haspopup="dialog" onClick={() => setPreviewOpen(true)}>
                <Receipt size={14} />
                {submitted.length > 0 ? REIMBURSEMENT_COPY.logAnother : REIMBURSEMENT_COPY.logReimbursement}
              </button>
            ) : feeRequestsHref ? (
              <Link href={feeRequestsHref} className={`${styles.logButton} ${styles.logLink}`} aria-label={FEE_COPY.logLinkLabel}>
                <Receipt size={14} />
                {FEE_COPY.logReimbursement}
              </Link>
            ) : null}
          </div>
        </div>
      ) : feeState === "no-fee" ? (
        <div className={`${styles.panel} ${styles.panelSuccess}`}>
          <div className={styles.panelRowCenter}>
            <div className={`${styles.stateIcon} ${styles.stateIconSuccess}`}><CircleCheck size={18} /></div>
            <div>
              <h3 className={styles.stateTitleSuccess}>{FEE_COPY.noFeeTitle}</h3>
              <p className={styles.stateTextSuccess}>{FEE_COPY.noFeeBody}</p>
            </div>
          </div>
        </div>
      ) : feeState === "review" ? (
        <div className={`${styles.panel} ${styles.panelWarning}`}>
          <h3 className={styles.panelTitle}>{FEE_COPY.reviewTitle}</h3>
          <p className={styles.panelText}>{FEE_COPY.reviewBody}</p>
        </div>
      ) : (
        <div className={`${styles.panel} ${styles.panelNeutral}`}>
          <div className={styles.panelRowCenter}>
            <div className={`${styles.stateIcon} ${styles.stateIconNeutral}`}><Clock size={18} /></div>
            <div>
              <h3 className={styles.stateTitleNeutral}>{FEE_COPY.pendingTitle}</h3>
              <p className={styles.stateTextNeutral}>{FEE_COPY.pendingBody}</p>
            </div>
          </div>
        </div>
      ))}

      {previewOpen && reimbursement && !readOnly && (
        <TransferReimbursementDialog
          key={`reimbursement:${submitted.length}`}
          recordId={recordId}
          record={record}
          feeAmount={fee?.feeAmount ?? null}
          feeApexTicket={fee?.feeApexTicket ?? null}
          requestsHref={feeRequestsHref}
          onClose={() => setPreviewOpen(false)}
          onSubmitted={(request, shown) => {
            setSubmitted((current) => [...current, { request, ...shown }]);
            setPreviewOpen(false);
          }}
        />
      )}
    </section>
  );
}

function FeeSchedulePanel({ contraName, state, rules, selected, onToggle, totals, recordHasFee, onApply, applying, readOnly, onRetry }: {
  contraName: string;
  state: "loading" | "ready" | "failed";
  rules: FeeRule[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  totals: ReturnType<typeof selectedTotals>;
  recordHasFee: boolean;
  onApply: () => void;
  applying: boolean;
  readOnly: boolean;
  onRetry: () => void;
}) {
  if (state === "loading") {
    return (
      <div className={`${styles.card} ${styles.cardBody}`}>
        <div className={styles.checking}>
          <LoaderCircle size={14} className={styles.spin} />
          <span>{FEE_COPY.loadingSchedule}</span>
        </div>
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div className={styles.headLeft}>
            <BookOpen size={15} className={styles.accentIcon} />
            <h3 className={styles.cardTitle}>{FEE_COPY.scheduleTitle}</h3>
          </div>
        </div>
        <div className={styles.cardBody}>
          <div role="alert" className={styles.logFailure}>
            <span>{FEE_COPY.rulesFailed}</span>
            <button type="button" className={styles.retry} aria-label="Retry fee schedule" onClick={onRetry}>{FEE_COPY.retry}</button>
          </div>
        </div>
      </div>
    );
  }
  if (rules.length === 0) {
    return (
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <div className={styles.headLeft}>
            <BookOpen size={15} className={styles.accentIcon} />
            <h3 className={styles.cardTitle}>{FEE_COPY.scheduleTitle}</h3>
          </div>
        </div>
        <div className={styles.scheduleEmpty}>
          {contraName ? noScheduleOnFile(contraName) : FEE_COPY.noScheduleSet}
        </div>
      </div>
    );
  }
  const count = selected.size;
  const canApply = !recordHasFee && count > 0 && !totals.requiresAmountConfirmation;
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div className={styles.headLeft}>
          <BookOpen size={15} className={styles.accentIcon} />
          <h3 className={styles.cardTitle}>{FEE_COPY.scheduleTitle} — {contraName}</h3>
          <span className={styles.pill}>{rules.length} configured</span>
        </div>
        {!recordHasFee && !readOnly && (
          <button type="button" className={styles.smallButton} onClick={onApply} disabled={!canApply || applying}>
            {applying ? <LoaderCircle size={11} className={styles.spin} /> : <ArrowRight size={11} />}
            {FEE_COPY.applySelected}
          </button>
        )}
      </div>
      <p className={styles.scheduleNote}>
        Showing every fee configured for {contraName}.{!readOnly && " Select one or more to apply to this record."}
      </p>
      {!readOnly && totals.requiresAmountConfirmation && <p className={styles.scheduleNote}>{FEE_COPY.confirmSelectedAmount}</p>}
      <div className={styles.divide}>
        {rules.map((rule) => {
          const checked = selected.has(rule.id);
          return (
            <label key={rule.id} className={`${styles.rule} ${checked ? styles.ruleChecked : ""}`}>
              <div className={styles.ruleLeft}>
                {!readOnly && <input type="checkbox" className={styles.checkbox} checked={checked} onChange={() => onToggle(rule.id)}
                  aria-label={`Select ${rule.feeType}`} />}
                <div className={styles.ruleText}>
                  <p className={styles.ruleName}>{rule.feeType}</p>
                  <p className={styles.ruleDetail}>{ruleDetail(rule)}</p>
                </div>
              </div>
              <span className={styles.ruleAmount}>{ruleAmountLabel(rule)}</span>
            </label>
          );
        })}
        {!readOnly && <div className={styles.totalRow}>
          <span className={styles.totalLabel}>Selected Total ({count} fee{count === 1 ? "" : "s"})</span>
          <span className={styles.totalValue}>
            {totals.requiresAmountConfirmation ? "Amount needs confirmation" : `$${totals.total.toFixed(2)}`}
          </span>
        </div>}
      </div>
    </div>
  );
}
