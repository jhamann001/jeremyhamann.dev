"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  confirmPaperworkTitle,
  generatePaperwork,
  loadPaperwork,
  loadPaperworkWatchouts,
  type PaperworkWatchoutsResult,
} from "@/app/(authenticated)/acat-tracking/paperwork-actions";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import {
  PAPERWORK_FAILURE_COPY,
  PAPERWORK_HISTORY_FAILURE,
  PAPERWORK_NOT_DOCUMENTED,
  PAPERWORK_NO_CUSTODIAN,
  PAPERWORK_NO_DOCUMENTS,
  PAPERWORK_SAVE_FAILED,
  PAPERWORK_TEMPLATE_LABELS,
  PAPERWORK_WATCHOUTS_FAILURE,
  buildPaperworkRequest,
  effectiveInstruction,
  handlingSummary,
  includedPositions,
  paperworkReadiness,
  partialCounts,
  receivingConfirmed,
  supportsMixed,
  titlesDiffer,
  type PaperworkCustodian,
  type PaperworkDraft,
  type PaperworkFailureReason,
  type PaperworkInstruction,
  type PaperworkWorkflow,
} from "@/lib/transfers/paperwork-section";
import type { ConfirmReceivingTitle, GenerateTransferForm, TransferFormPreparation } from "@/lib/transfers/transfer-form-contract";
import { RECEIVING_REGISTRATIONS, receivingRegistrationSchema, suggestedReceivingRegistration } from "@/lib/transfers/transfer-registration";
import styles from "./AcatPaperworkSection.module.css";

type Source = { kind: "loading" } | { kind: "failed"; reason: PaperworkFailureReason } | { kind: "loaded"; data: TransferFormPreparation };
type Watchouts =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "loaded"; custodian: PaperworkCustodian | null; retrievedAt: string };
type Attempt<T> = { fingerprint: string; input: T } | null;
type PositionInstructions = Record<string, PaperworkInstruction | undefined>;

const NIL_UUID = "00000000-0000-4000-8000-000000000000";
const NOT_LISTED = "__NOT_LISTED__";

function when(value: string | null): string {
  if (!value) return "Time not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "Time not recorded" : parsed.toLocaleString();
}

function documentHref(recordId: string, documentId: string): string {
  return `/api/transfers/${encodeURIComponent(recordId)}/forms/${encodeURIComponent(documentId)}`;
}

function holdingName(position: { symbol: string; description: string }): string {
  return position.symbol || position.description || "Unnamed holding";
}

const INSTRUCTION_LABEL: Record<PaperworkInstruction, string> = { IN_KIND: "Transfer in kind", LIQUIDATE: "Liquidate" };

/** Save the stored PDF as a file. Never regenerates anything. */
async function saveStoredDocument(recordId: string, documentId: string): Promise<void> {
  const response = await fetch(documentHref(recordId, documentId), { cache: "no-store" });
  if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/pdf")) {
    throw new Error("download_failed");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const disposition = response.headers.get("content-disposition") ?? "";
    const link = document.createElement("a");
    link.href = url;
    link.download = disposition.match(/filename="([^"]+)"/)?.[1] ?? `transfer-${documentId}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AcatPaperworkSection({ recordId, readOnly }: { recordId: string; readOnly: boolean }) {
  const id = useId();
  const [source, setSource] = useState<Source>({ kind: "loading" });
  const [historyFailed, setHistoryFailed] = useState(false);
  const [watch, setWatch] = useState<Watchouts>({ kind: "loading" });
  const [watchCheckedAt, setWatchCheckedAt] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState("");
  const [instruction, setInstruction] = useState<PaperworkDraft["instruction"]>("");
  const [positionInstructions, setPositionInstructions] = useState<PositionInstructions>({});
  const [deliveringTitle, setDeliveringTitle] = useState("");
  const [deliveringVerified, setDeliveringVerified] = useState(false);
  const [houseAccount, setHouseAccount] = useState("");
  const [houseVerified, setHouseVerified] = useState(false);
  const [manualLetter, setManualLetter] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [title, setTitle] = useState("");
  const [registration, setRegistration] = useState("");
  const [titleVerified, setTitleVerified] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [busy, setBusy] = useState<"confirm" | "generate" | "save" | null>(null);
  const [stale, setStale] = useState(false);
  const [actionFailure, setActionFailure] = useState<{ kind: "confirm" | "generate"; reason: PaperworkFailureReason } | null>(null);
  const [storedDocument, setStoredDocument] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const sourceRequest = useRef(0);
  const watchRequest = useRef(0);
  const inFlight = useRef(false);
  const confirmAttempt = useRef<Attempt<ConfirmReceivingTitle>>(null);
  const generateAttempt = useRef<Attempt<GenerateTransferForm>>(null);
  const draftRef = useRef({ workflowId: "", instruction: "" as PaperworkDraft["instruction"], positionInstructions: {} as PositionInstructions, houseAccount: "", letterRequired: false, deliveringTitle: "", revision: "" });
  draftRef.current = { ...draftRef.current, workflowId, instruction, positionInstructions, houseAccount, deliveringTitle };

  const clearReview = useCallback(() => { setReviewed(false); setNotice(null); }, []);

  const applySource = useCallback((next: TransferFormPreparation) => {
    const previous = draftRef.current;
    const sameRevision = previous.revision === next.sourceRevision;
    const keptWorkflow = next.workflows.find((candidate) => candidate.id === previous.workflowId);
    const selected = keptWorkflow ?? (next.workflows.length === 1 ? next.workflows[0] : undefined);
    const keptMixed = sameRevision && keptWorkflow && previous.instruction === "MIXED" && supportsMixed(next, selected);
    const keptInstruction = keptMixed ? "MIXED"
      : previous.instruction && previous.instruction !== "MIXED" && selected?.handling.options.includes(previous.instruction) ? previous.instruction : "";
    setSource({ kind: "loaded", data: next });
    setHistoryFailed(false);
    setStale(false);
    setWorkflowId(selected?.id ?? "");
    setInstruction(keptInstruction);
    setPositionInstructions(keptMixed ? previous.positionInstructions : {});
    setHouseAccount(keptWorkflow ? previous.houseAccount : "");
    setHouseVerified(false);
    setDeliveringTitle(sameRevision && previous.deliveringTitle ? previous.deliveringTitle : next.accounts.deliveringTitleSuggestion);
    setDeliveringVerified(false);
    setTitle(next.confirmation?.title || next.accounts.receivingTitleSuggestion);
    setRegistration(suggestedReceivingRegistration(next.confirmation?.registration ?? next.accounts.registrationSuggestion));
    setTitleVerified(false);
    setEditingTitle(!receivingConfirmed(next));
    setReviewed(false);
    confirmAttempt.current = null;
    generateAttempt.current = null;
    draftRef.current = { ...previous, revision: next.sourceRevision };
  }, []);

  /** `keep` leaves the current recommendation in place while the read is in flight (history refresh after a save). */
  const refresh = useCallback(async (keep = false) => {
    const current = ++sourceRequest.current;
    if (!keep) {
      // A failed refresh must not leave an earlier recommendation looking current.
      setSource({ kind: "loading" });
      setActionFailure(null);
      setNotice(null);
    }
    try {
      const result = await loadPaperwork(recordId);
      if (sourceRequest.current !== current) return;
      if (result.ok) applySource(result.data);
      else if (keep) setHistoryFailed(true);
      else setSource({ kind: "failed", reason: result.reason });
    } catch {
      if (sourceRequest.current !== current) return;
      if (keep) setHistoryFailed(true);
      else setSource({ kind: "failed", reason: "unavailable" });
    }
  }, [recordId, applySource]);

  const refreshWatchouts = useCallback(async (quiet = false) => {
    const current = ++watchRequest.current;
    if (!quiet) setWatch({ kind: "loading" });
    try {
      const result: PaperworkWatchoutsResult = await loadPaperworkWatchouts(recordId);
      if (watchRequest.current !== current) return;
      if (result.ok) {
        setWatch({ kind: "loaded", custodian: result.custodian, retrievedAt: result.retrievedAt });
        setWatchCheckedAt(result.checkedAt);
      } else setWatch({ kind: "failed" });
    } catch {
      if (watchRequest.current === current) setWatch({ kind: "failed" });
    }
  }, [recordId]);

  useEffect(() => {
    void refresh();
    void refreshWatchouts();
    return () => { sourceRequest.current += 1; watchRequest.current += 1; };
  }, [refresh, refreshWatchouts]);

  // The playbook can change while a transfer stays open; read it again on return.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void refreshWatchouts(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshWatchouts]);

  const data = source.kind === "loaded" ? source.data : null;
  const workflow: PaperworkWorkflow | undefined = data?.workflows.find((candidate) => candidate.id === workflowId);
  const counts = data ? partialCounts(data) : null;
  const included = data ? includedPositions(data) : [];
  const confirmed = data ? receivingConfirmed(data) : false;
  const mismatch = data ? titlesDiffer(data, deliveringTitle) : false;
  const draft: PaperworkDraft = {
    workflowId, instruction, positionInstructions, deliveringTitle, houseAccount, houseVerified,
    letterRequired: manualLetter || mismatch,
    reviewed: reviewed && (!data?.inheritedTitleReview || deliveringVerified),
  };
  const readiness = data ? paperworkReadiness(data, draft) : { ready: false, reason: "" };
  const canDownload = Boolean(data && readiness.ready && !editingTitle && !busy && !stale && !readOnly);
  const reason = !data ? "" : stale ? "Refresh before continuing." : editingTitle ? "Confirm and save the receiving account title first." : readiness.reason;
  const instructionNow = effectiveInstruction(workflow, draft);

  const failure = (kind: "confirm" | "generate", why: PaperworkFailureReason) => {
    setActionFailure({ kind, reason: why });
    if (why === "stale" || why === "review_required" || why === "not_found") { setStale(true); setReviewed(false); }
  };

  const saveTitle = async () => {
    const chosen = receivingRegistrationSchema.safeParse(registration);
    if (!data || inFlight.current || stale || !title.trim() || !chosen.success || !titleVerified) return;
    const base = { expectedRevision: data.sourceRevision, title: title.trim(), registration: chosen.data, confirmed: true as const };
    const fingerprint = JSON.stringify(base);
    if (confirmAttempt.current?.fingerprint !== fingerprint) {
      confirmAttempt.current = { fingerprint, input: { ...base, operationId: crypto.randomUUID() } };
    }
    const requestNumber = sourceRequest.current;
    inFlight.current = true; setBusy("confirm"); setActionFailure(null); setNotice(null);
    try {
      const result = await confirmPaperworkTitle(recordId, confirmAttempt.current.input);
      if (sourceRequest.current !== requestNumber) return;
      if (result.ok) {
        applySource(result.data);
        setNotice("Receiving account title confirmed and saved.");
      } else failure("confirm", result.reason);
    } catch {
      if (sourceRequest.current === requestNumber) failure("confirm", "unavailable");
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const saveFile = async (documentId: string) => {
    setBusy("save"); setSaveFailed(false);
    try {
      await saveStoredDocument(recordId, documentId);
      setStoredDocument(null);
      setNotice("Saved to this transfer's paperwork history. You can download it again without regenerating.");
      setReviewed(false);
      generateAttempt.current = null;
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    if (!data || !canDownload || inFlight.current) return;
    const probe = buildPaperworkRequest(data, draft, NIL_UUID);
    if (!probe) return;
    const fingerprint = JSON.stringify({ ...probe, operationId: "" });
    // An unchanged request keeps its operation id so a retry never makes a second form.
    if (generateAttempt.current?.fingerprint !== fingerprint) {
      generateAttempt.current = { fingerprint, input: { ...probe, operationId: crypto.randomUUID() } };
    }
    const requestNumber = sourceRequest.current;
    inFlight.current = true; setBusy("generate"); setActionFailure(null); setNotice(null); setSaveFailed(false);
    let documentId: string | null = null;
    try {
      const result = await generatePaperwork(recordId, generateAttempt.current.input);
      if (sourceRequest.current !== requestNumber) return;
      if (!result.ok) { failure("generate", result.reason); return; }
      documentId = result.data.documentId;
      setStoredDocument(documentId);
    } catch {
      if (sourceRequest.current === requestNumber) failure("generate", "unavailable");
      return;
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
    if (!documentId) return;
    await saveFile(documentId);
    // The archive stands even when these follow-up reads fail; never turn them into a second generation.
    void refresh(true);
    void refreshWatchouts(true);
  };

  const retryDownload = async () => {
    if (!storedDocument || busy) return;
    await saveFile(storedDocument);
  };

  const custodian = watch.kind === "loaded" ? watch.custodian : null;
  const rules: [string, string | null][] = custodian ? [
    ["LOA", custodian.letterOfAcceptance],
    ["Receiving / house account", custodian.receivingAccountNumber],
    ["Medallion", custodian.medallionRequired],
    ["Client signature", custodian.signature],
    ["Return method", custodian.returnMethod],
    ["Liquidation guidance", custodian.liquidationMethod],
  ] : [];
  const shownRules = rules.filter(([label, value]) => label !== "Receiving / house account" || Boolean(value?.trim()));

  return (
    <section className={styles.root} data-testid="acat-paperwork" aria-labelledby={`${id}-title`}>
      <div className={styles.head}>
        <div>
          <div className={styles.titleRow}>
            <h3 id={`${id}-title`} className={styles.title}>Transfer paperwork recommendation</h3>
            {data && data.blockers.length > 0 && <span className={styles.badgeReview}>Review needed</span>}
          </div>
          <p className={styles.sub}>
            {watch.kind === "loaded" && watch.custodian
              ? `Form logic is combined with the live ${watch.custodian.name} Custodian Library record.`
              : "Form logic is combined with the live Custodian Library record when one matches."}
          </p>
        </div>
        <button type="button" className={styles.button} disabled={busy !== null} onClick={() => { void refresh(); void refreshWatchouts(); }}>
          Refresh
        </button>
      </div>

      <div className={styles.body}>
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
        {readOnly && <p className={styles.hint}>Edits are off, so paperwork can be reviewed but not changed.</p>}

        {source.kind === "loading" && <p role="status" className={styles.state}>Loading transfer paperwork guidance…</p>}

        {source.kind === "failed" && (
          <div role="alert" className={styles.noticeDanger}>
            <p>{PAPERWORK_FAILURE_COPY[source.reason]}</p>
            <button type="button" className={styles.button} onClick={() => void refresh()}>Retry</button>
          </div>
        )}

        {data && <>
          {data.blockers.length > 0 && (
            <div className={styles.noticeWarn}>
              <p className={styles.label}>Confirm before generating</p>
              <ul>{data.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}</ul>
            </div>
          )}

          {data.workflows.length > 1 && (
            <label className={styles.field}>
              <span className={styles.label}>Form workflow</span>
              <select className={styles.select} value={workflowId} disabled={readOnly}
                onChange={(event) => { setWorkflowId(event.target.value); setInstruction(""); setPositionInstructions({}); setHouseAccount(""); setHouseVerified(false); clearReview(); }}>
                <option value="">Choose using current documentation</option>
                {data.workflows.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
              </select>
            </label>
          )}

          <div className={styles.candidates} aria-label="Recommended forms">
            {data.workflows.length === 0 && <p className={styles.hint}>No supported form route is available. Confirm the custodian and route in Transfer Tracker.</p>}
            {data.workflows.map((candidate) => (
              <div key={candidate.id} className={`${styles.candidate} ${candidate.id === workflowId ? styles.candidateChosen : ""}`}>
                <p className={styles.candidateName}>{candidate.name}</p>
                {candidate.id === workflowId && <span className={styles.chip}>Selected</span>}
                {candidate.template && <p className={styles.candidateMeta}>{PAPERWORK_TEMPLATE_LABELS[candidate.template]}</p>}
                <p className={styles.candidateStrong}>{handlingSummary(candidate)}</p>
                {candidate.note && <p className={styles.candidateMeta}>{candidate.note}</p>}
                {!candidate.automated && <p className={styles.candidateMeta}>Prepare this form manually in Transfer Tracker.</p>}
              </div>
            ))}
          </div>

          {workflow?.handling.mode === "CLIENT_DIRECTED" && (
            <fieldset className={styles.choices} disabled={readOnly || busy !== null}>
              <legend className={styles.label}>Client asset instruction</legend>
              {workflow.handling.options.map((option) => (
                <label key={option} className={`${styles.choice} ${instruction === option ? styles.choiceChosen : ""}`}>
                  <input type="radio" name={`${id}-instruction`} value={option} checked={instruction === option}
                    onChange={() => { setInstruction(option); setPositionInstructions({}); clearReview(); }} />
                  {INSTRUCTION_LABEL[option]}
                </label>
              ))}
              {supportsMixed(data, workflow) && (
                <label className={`${styles.choice} ${instruction === "MIXED" ? styles.choiceChosen : ""}`}>
                  <input type="radio" name={`${id}-instruction`} value="MIXED" checked={instruction === "MIXED"}
                    onChange={() => { setInstruction("MIXED"); setPositionInstructions({}); clearReview(); }} />
                  Mix of in-kind and cash
                </label>
              )}
              {instruction === "MIXED" && included.map((position) => (
                <div key={position.id} className={styles.positionRow}>
                  <span>{holdingName(position)} <span className={styles.cell}>Recorded quantity: {position.quantity.toLocaleString()}</span></span>
                  <select className={styles.select} style={{ width: "auto" }} aria-label={`Instruction for ${holdingName(position)}`}
                    value={positionInstructions[position.id] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setPositionInstructions((current) => ({ ...current, [position.id]: value === "IN_KIND" || value === "LIQUIDATE" ? value : undefined }));
                      clearReview();
                    }}>
                    <option value="">Choose an instruction</option>
                    <option value="IN_KIND">Transfer in kind</option>
                    <option value="LIQUIDATE">Liquidate</option>
                  </select>
                </div>
              ))}
            </fieldset>
          )}
          {workflow?.handling.mode === "FIXED" && (
            <p className={styles.hint}>
              This route uses {instructionNow === "LIQUIDATE" ? "liquidation" : "an in-kind transfer"}. Confirm this matches the client&apos;s instructions.
            </p>
          )}

          <div className={styles.block} aria-label="Account titles">
            <span className={styles.label}>Receiving account title</span>
            {confirmed && !editingTitle && data.confirmation ? (
              <>
                <strong>{data.confirmation.title}</strong>
                <span className={styles.hint}>{data.confirmation.registration || "Registration not recorded"}</span>
                <p className={styles.saved}>
                  Saved <time dateTime={data.confirmation.confirmedAt ?? undefined}>{when(data.confirmation.confirmedAt)}</time>
                  {` by ${data.confirmation.confirmedBy || "an unrecorded user"}`}
                </p>
                {!readOnly && <button type="button" className={styles.linkButton} disabled={busy !== null}
                  onClick={() => { setEditingTitle(true); setTitleVerified(false); confirmAttempt.current = null; clearReview(); }}>Edit receiving account title</button>}
              </>
            ) : readOnly ? (
              <>
                <strong>{data.confirmation?.title || data.accounts.receivingTitleSuggestion || "Not recorded"}</strong>
                <span className={styles.hint}>Not confirmed yet.</span>
              </>
            ) : (
              <>
                {data.confirmation && !data.confirmation.valid && (
                  <p className={styles.errorText}>{data.confirmation.source === "TRACKER_LEGACY" ? "Earlier Tracker confirmation — reconfirm" : "Receiving details changed — reconfirm"}</p>
                )}
                <label className={styles.field}>
                  Exact receiving account title
                  <input className={styles.input} autoComplete="off" maxLength={200} value={title}
                    onChange={(event) => { setTitle(event.target.value); setTitleVerified(false); confirmAttempt.current = null; clearReview(); }} />
                </label>
                <label className={styles.field}>
                  Receiving registration
                  <select className={styles.select} value={registration}
                    onChange={(event) => { setRegistration(event.target.value); setTitleVerified(false); confirmAttempt.current = null; clearReview(); }}>
                    <option value="">Choose a registration</option>
                    {RECEIVING_REGISTRATIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                    <option value={NOT_LISTED}>Not listed — needs review</option>
                  </select>
                </label>
                {registration === NOT_LISTED && <p className={styles.errorText}>Review this account&apos;s registration before continuing. Nothing is saved until a supported registration is confirmed.</p>}
                <label className={styles.check}>
                  <input type="checkbox" checked={titleVerified} onChange={(event) => setTitleVerified(event.target.checked)} />
                  I verified this exact title and registration against the receiving account.
                </label>
                <div>
                  <button type="button" className={styles.primary}
                    disabled={busy !== null || stale || !title.trim() || !receivingRegistrationSchema.safeParse(registration).success || !titleVerified}
                    onClick={() => void saveTitle()}>
                    {busy === "confirm" ? "Saving…" : "Confirm and save"}
                  </button>
                </div>
              </>
            )}

            <span className={styles.label}>Delivering account title</span>
            {data.inheritedTitleReview && !readOnly ? (
              <>
                <label className={styles.field}>
                  Delivering account title from current statement
                  <input className={styles.input} autoComplete="off" maxLength={200} value={deliveringTitle}
                    onChange={(event) => { setDeliveringTitle(event.target.value); setDeliveringVerified(false); clearReview(); }} />
                </label>
                <p className={styles.hint}>The client name is only a tracker suggestion. Replace it with the exact registration shown on the current delivering statement.</p>
                <p className={styles.candidateStrong}>
                  {mismatch ? "Titles differ — the letter of authorization will be populated." : "Titles match — Custodian Library LOA guidance still applies."}
                </p>
                <label className={styles.check}>
                  <input type="checkbox" checked={deliveringVerified} onChange={(event) => { setDeliveringVerified(event.target.checked); clearReview(); }} />
                  I confirmed this delivering title against the current statement.
                </label>
              </>
            ) : (
              <strong>{deliveringTitle || "Not recorded"}</strong>
            )}
            <span className={styles.hint}>
              {data.accounts.deliveringMasked || "Not available"} → {data.accounts.receivingMasked || "Not available"}
            </span>
          </div>

          {workflow?.requiresReceivingAccountNumber && !readOnly && (
            <div className={styles.block}>
              <label className={styles.field}>
                <span className={styles.label}>Verified receiving / house account number</span>
                <input className={styles.input} autoComplete="off" maxLength={100} value={houseAccount}
                  onChange={(event) => { setHouseAccount(event.target.value); setHouseVerified(false); clearReview(); }} />
              </label>
              <label className={styles.check}>
                <input type="checkbox" checked={houseVerified} onChange={(event) => { setHouseVerified(event.target.checked); clearReview(); }} />
                I verified this receiving/house number with Apex MF Ops.
              </label>
            </div>
          )}
        </>}

        <div aria-label="Custodian rules">
          <p className={styles.label}>Custodian Library — source of truth</p>
          {watch.kind === "loading" && <p role="status" className={styles.state}>Loading custodian rules…</p>}
          {watch.kind === "failed" && (
            <div role="alert" className={styles.noticeDanger}>
              <p>{PAPERWORK_WATCHOUTS_FAILURE}</p>
              <button type="button" className={styles.button} onClick={() => void refreshWatchouts()}>Retry</button>
            </div>
          )}
          {watch.kind === "loaded" && !watch.custodian && <p className={styles.hint}>{PAPERWORK_NO_CUSTODIAN}</p>}
          {watch.kind === "loaded" && watch.custodian && (
            <>
              <dl className={styles.rules}>
                {shownRules.map(([label, value]) => (
                  <div key={label}><dt>{label}</dt><dd>{value?.trim() || PAPERWORK_NOT_DOCUMENTED}</dd></div>
                ))}
              </dl>
              <p className={styles.label} style={{ marginTop: 10 }}>Watchouts</p>
              <p className={styles.watchouts}>{watch.custodian.watchouts?.trim() || PAPERWORK_NOT_DOCUMENTED}</p>
              {watchCheckedAt && <p className={styles.hint}>Playbook read <time dateTime={watchCheckedAt}>{when(watchCheckedAt)}</time></p>}
            </>
          )}
        </div>

        {data && (
          <>
            <div className={styles.download}>
              <div className={styles.downloadText}>
                <p className={styles.strong}>Prefilled transfer form</p>
                <p>
                  SSN/Tax ID, delivering address, signatures, and medallion remain blank for confirmation and secure completion.
                  Mutual-fund cash elections follow the selected liquidation instruction.
                </p>
                {counts?.required && (
                  <p className={counts.undecided === 0 && counts.included > 0 ? styles.countsOk : styles.countsWarn}>
                    Partial-transfer holdings: {counts.included} included, {counts.excluded} excluded, {counts.undecided} undecided.
                    {!(counts.undecided === 0 && counts.included > 0) && " Review the saved transfer selections below before generating."}
                  </p>
                )}
                {counts?.required && (
                  <p>
                    Mark each holding Included or Excluded in Transfer Tracker, then use Refresh to update these counts.{" "}
                    <a className={styles.link} href={EXTERNAL_APPS.acatTracking} target="_blank" rel="noopener noreferrer">Open Transfer Tracker ↗</a>
                  </p>
                )}
                <p>Mapped holdings already saved on this transfer populate the fund rows. Generating the form does not run a new asset-mapping sync.</p>
                {!readOnly && (
                  <label className={styles.check}>
                    <input type="checkbox" checked={reviewed} disabled={busy !== null || stale}
                      onChange={(event) => { setReviewed(event.target.checked); generateAttempt.current = null; setNotice(null); }} />
                    I verified the delivering title and reviewed both accounts, the selected holdings and the transfer instructions.
                  </label>
                )}
                {actionFailure && (
                  <div role="alert" className={styles.noticeDanger}>
                    <p>{PAPERWORK_FAILURE_COPY[actionFailure.reason]}</p>
                    {actionFailure.kind === "generate" && !stale && (
                      <button type="button" className={styles.button} disabled={!canDownload} onClick={() => void download()}>Retry</button>
                    )}
                    {stale && <button type="button" className={styles.button} onClick={() => void refresh()}>Refresh</button>}
                  </div>
                )}
                {saveFailed && storedDocument && (
                  <div role="alert" className={styles.noticeDanger}>
                    <p>{PAPERWORK_SAVE_FAILED}</p>
                    <button type="button" className={styles.button} disabled={busy !== null} onClick={() => void retryDownload()}>Retry download</button>
                  </div>
                )}
                {!canDownload && reason && !readOnly && !busy && <p className={styles.reason}>{reason}</p>}
              </div>
              {!readOnly && (
                <button type="button" className={styles.primary} disabled={!canDownload} onClick={() => void download()}>
                  {busy === "generate" ? "Generating…" : busy === "save" ? "Downloading…" : "Download prefilled form"}
                </button>
              )}
            </div>

            {counts?.required && data.positions.length > 0 && (
              <table className={styles.table} aria-label="Partial-transfer holdings">
                <thead><tr><th>Holding</th><th>Quantity</th><th>Transfer</th></tr></thead>
                <tbody>
                  {data.positions.map((position) => (
                    <tr key={position.id} className={position.include === null ? styles.undecided : undefined}>
                      <td>{holdingName(position)}{position.symbol && position.description && <span className={styles.cell}>{position.description}</span>}</td>
                      <td>{position.quantity.toLocaleString()}</td>
                      <td>{position.include === true ? "Included" : position.include === false ? "Excluded" : "Undecided"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        <div aria-label="Transfer document history">
          <p className={styles.label}>Transfer document history</p>
          {(source.kind === "failed" || historyFailed) ? (
            <div role="alert" className={styles.noticeDanger}>
              <p>{PAPERWORK_HISTORY_FAILURE}</p>
              <button type="button" className={styles.button} onClick={() => void refresh()}>Retry</button>
            </div>
          ) : source.kind === "loading" ? (
            <p role="status" className={styles.state}>Loading document history…</p>
          ) : data && data.documents.length === 0 ? (
            <p className={styles.hint}>{PAPERWORK_NO_DOCUMENTS}</p>
          ) : data ? (
            <ul className={styles.history}>
              {data.documents.map((document) => (
                <li key={document.id}>
                  <a className={styles.link} href={documentHref(recordId, document.id)} target="_blank" rel="noopener noreferrer">{document.filename}</a>
                  <span className={styles.historyMeta}>
                    {document.createdBy} · Stored <time dateTime={document.createdAt}>{when(document.createdAt)}</time>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {data && (
          <div className={styles.footer}>
            <span className={styles.hint}>Checked <time dateTime={data.checkedAt}>{when(data.checkedAt)}</time></span>
          </div>
        )}
      </div>
    </section>
  );
}
