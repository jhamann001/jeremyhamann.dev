"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { confirmReceivingTitle, generateTransferForm, loadTransferForm, updateTransferScope } from "@/app/(authenticated)/acat-tracking/form-actions";
import { generateTransferFormSchema } from "@/lib/transfers/transfer-form-contract";
import type { ConfirmReceivingTitle, GenerateTransferForm, UpdateTransferScope, TransferFormFailureReason, TransferFormPreparation } from "@/lib/transfers/transfer-form-contract";
import { RECEIVING_REGISTRATIONS, receivingRegistrationSchema, suggestedReceivingRegistration } from "@/lib/transfers/transfer-registration";
import { EXTERNAL_APPS } from "@/lib/external-apps";
import styles from "./TransferFormPanel.module.css";

const transferMethodLabels = { ACAT: "ACAT (API)", MANUAL: "Manual", DRS: "DRS", RESIDUAL: "Residual", UNCLASSIFIED: "Not yet classified" } as const;

const failureCopy: Record<TransferFormFailureReason, string> = {
  disabled: "Form preparation is not connected in this environment yet. Continue in Transfer Tracker.",
  forbidden: "You don't have access to prepare forms for this transfer.",
  invalid: "Some form details are invalid. Check your entries and try again.",
  not_found: "This transfer is no longer available. Refresh the source before continuing.",
  stale: "The transfer changed. Refresh the source and review the current details before continuing.",
  unavailable: "The request could not be completed. Retry without changing your entries to safely check the same request.",
  review_required: "More review is required. Refresh the source to see the current requirements.",
};

function dateLabel(value: string | null) {
  if (!value) return "Time not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "Time not recorded" : parsed.toLocaleString();
}

function documentHref(recordId: string, documentId: string) {
  return `/api/transfers/${encodeURIComponent(recordId)}/forms/${encodeURIComponent(documentId)}`;
}

type Attempt<T> = { fingerprint: string; input: T } | null;
type FormStep = "receiving" | "route" | "handling" | "house" | "review";
type SingleInstruction = "IN_KIND" | "LIQUIDATE";
type HandlingChoice = "" | SingleInstruction | "MIXED";
type PositionInstructions = Partial<Record<string, SingleInstruction>>;
type FormWorkflow = TransferFormPreparation["workflows"][number];
type DraftChoices = { sourceRevision: string; workflowId: string; instruction: HandlingChoice; positionInstructions: PositionInstructions; houseAccount: string; letterRequired: boolean };

function supportsMixed(source: TransferFormPreparation, workflow?: FormWorkflow) {
  return source.scope === "PARTIAL" && workflow?.automated && workflow.handling.mode === "CLIENT_DIRECTED" && workflow.handling.options.includes("IN_KIND") && workflow.handling.options.includes("LIQUIDATE");
}

function handlingComplete(source: TransferFormPreparation, workflow: FormWorkflow | undefined, instruction: HandlingChoice, positionInstructions: PositionInstructions) {
  if (!workflow || !instruction) return false;
  if (instruction !== "MIXED") return workflow.handling.options.includes(instruction);
  if (!supportsMixed(source, workflow)) return false;
  const included = source.positions.filter((position) => position.include === true);
  return included.length >= 2 && included.every((position) => positionInstructions[position.id] === "IN_KIND" || positionInstructions[position.id] === "LIQUIDATE") &&
    included.some((position) => positionInstructions[position.id] === "IN_KIND") && included.some((position) => positionInstructions[position.id] === "LIQUIDATE");
}

function hasValidReceivingConfirmation(source: TransferFormPreparation) {
  return Boolean(source.confirmation?.valid && source.confirmation.id && suggestedReceivingRegistration(source.confirmation.registration));
}

function nextQuestion(source: TransferFormPreparation, workflowId: string, instruction: DraftChoices["instruction"], houseVerified = false, positionInstructions: PositionInstructions = {}): FormStep {
  if (!hasValidReceivingConfirmation(source)) return "receiving";
  const workflow = source.workflows.find((candidate) => candidate.id === workflowId);
  if (!workflow?.automated) return "route";
  if (workflow.handling.mode === "CLIENT_DIRECTED" && !handlingComplete(source, workflow, instruction, positionInstructions)) return "handling";
  if (workflow.requiresReceivingAccountNumber && !houseVerified) return "house";
  return "review";
}

function HoldingTable({ data, positionInstructions }: { data: TransferFormPreparation; positionInstructions?: PositionInstructions }) {
  return <div className={styles.tableWrap}><table><thead><tr><th>Holding</th><th>{positionInstructions ? "Recorded quantity" : "Quantity"}</th><th>Transfer</th>{positionInstructions && <th>Instruction</th>}</tr></thead><tbody>
    {data.positions.map((position) => <tr key={position.id} className={data.scope === "PARTIAL" && position.include === null ? styles.undecided : undefined}>
      <td><strong>{position.symbol || position.description || "Unnamed holding"}</strong>{position.symbol && <span className={styles.meta}>{position.description}</span>}</td>
      <td>{position.quantity.toLocaleString()}</td>
      <td>{data.scope === "FULL" || position.include === true ? "Included" : position.include === false ? "Excluded" : "Undecided"}</td>
      {positionInstructions && <td>{position.include !== true ? "—" : positionInstructions[position.id] === "IN_KIND" ? "In kind" : positionInstructions[position.id] === "LIQUIDATE" ? "Liquidate to cash" : "Not chosen"}</td>}
    </tr>)}
  </tbody></table></div>;
}

function FormSession({ recordId, onScopeChanged }: { recordId: string; onScopeChanged?: (scope: "FULL" | "PARTIAL") => void }) {
  const scopeChangedCallback = useRef(onScopeChanged);
  useEffect(() => { scopeChangedCallback.current = onScopeChanged; }, [onScopeChanged]);
  const [data, setData] = useState<TransferFormPreparation | null>(null);
  const [history, setHistory] = useState<TransferFormPreparation["documents"]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<TransferFormFailureReason | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<"confirm" | "generate" | "scope" | null>(null);
  const [editingScope, setEditingScope] = useState(false);
  const [scopeChoice, setScopeChoice] = useState<"" | "FULL" | "PARTIAL">("");
  const scopeHeading = useRef<HTMLHeadingElement | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [registration, setRegistration] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [instruction, setInstruction] = useState<HandlingChoice>("");
  const [positionInstructions, setPositionInstructions] = useState<PositionInstructions>({});
  const [deliveringTitle, setDeliveringTitle] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [editingDelivering, setEditingDelivering] = useState(false);
  const deliveringBeforeEdit = useRef("");
  const [activeStep, setActiveStep] = useState<FormStep>("receiving");
  const stepHeading = useRef<HTMLHeadingElement | null>(null);
  const focusNextStep = useRef(false);
  const [houseAccount, setHouseAccount] = useState("");
  const [houseVerified, setHouseVerified] = useState(false);
  const [letterRequired, setLetterRequired] = useState(false);
  const [createdDocument, setCreatedDocument] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);
  const inFlight = useRef(false);
  const confirmAttempt = useRef<Attempt<ConfirmReceivingTitle>>(null);
  const scopeAttempt = useRef<Attempt<UpdateTransferScope>>(null);
  const generateAttempt = useRef<Attempt<GenerateTransferForm>>(null);
  const id = useId();

  const clearGenerationReview = useCallback(() => {
    setReviewed(false);
    setHouseVerified(false); setLetterRequired(false); generateAttempt.current = null;
  }, []);

  const applySource = useCallback((next: TransferFormPreparation, previous?: DraftChoices) => {
    const keptWorkflow = previous && next.workflows.find((candidate) => candidate.id === previous.workflowId);
    const selected = keptWorkflow || (next.workflows.length === 1 ? next.workflows[0] : undefined);
    const keptMixed = previous?.instruction === "MIXED" && previous.sourceRevision === next.sourceRevision && keptWorkflow && supportsMixed(next, selected);
    const keptInstruction = keptMixed ? "MIXED" : previous?.instruction && previous.instruction !== "MIXED" && selected?.handling.options.includes(previous.instruction) ? previous.instruction : "";
    const keptPositions = keptMixed ? previous.positionInstructions : {};
    setData(next); setHistory(next.documents); setStale(false); setFailure(null);
    setEditingScope(false); setScopeChoice(""); scopeAttempt.current = null;
    setTitle(next.confirmation?.title || next.accounts.receivingTitleSuggestion);
    setRegistration(suggestedReceivingRegistration(next.confirmation?.registration ?? next.accounts.registrationSuggestion));
    setEditing(!hasValidReceivingConfirmation(next));
    setWorkflowId(selected?.id || ""); setInstruction(keptInstruction); setPositionInstructions(keptPositions);
    setHouseAccount(keptWorkflow ? previous!.houseAccount : "");
    setDeliveringTitle(next.accounts.deliveringTitleSuggestion); setEditingDelivering(false);
    confirmAttempt.current = null; clearGenerationReview();
    if (keptWorkflow) setLetterRequired(previous!.letterRequired);
    setActiveStep(nextQuestion(next, selected?.id || "", keptInstruction, false, keptPositions));
  }, [clearGenerationReview]);

  const advance = (step: FormStep) => { focusNextStep.current = true; setActiveStep(step); };
  useEffect(() => {
    if (!focusNextStep.current) return;
    focusNextStep.current = false;
    stepHeading.current?.focus({ preventScroll: true });
    stepHeading.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [activeStep, editing, editingScope]);
  useEffect(() => {
    if (!editingScope) return;
    scopeHeading.current?.focus({ preventScroll: true });
    scopeHeading.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [editingScope]);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const current = ++request.current;
    setLoading(true); setData(null); setFailure(null); setStale(false);
    setNotice(null); clearGenerationReview();
    setEditingScope(false); setScopeChoice(""); scopeAttempt.current = null;
    confirmAttempt.current = null;
    try {
      const result = await loadTransferForm(recordId);
      if (current !== request.current) return;
      if (result.ok) applySource(result.data);
      else {
        setFailure(result.reason);
        if (["forbidden", "disabled", "not_found"].includes(result.reason)) {
          setHistory([]); setCreatedDocument(null);
        }
      }
    } catch {
      if (current === request.current) setFailure("unavailable");
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [recordId, applySource, clearGenerationReview]);

  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
  }, [refresh]);

  const handleFailure = (reason: TransferFormFailureReason) => {
    setFailure(reason);
    if (["stale", "review_required", "not_found"].includes(reason)) {
      setStale(true); clearGenerationReview(); confirmAttempt.current = null;
      setEditingScope(false); setScopeChoice(""); scopeAttempt.current = null;
    }
    if (reason === "forbidden" || reason === "disabled") {
      setData(null); setHistory([]); setCreatedDocument(null);
    }
  };

  const scopeChangeAllowed = Boolean(data && data.direction === "INCOMING" && data.transferMethod !== "DRS" && data.transferMethod !== "RESIDUAL");
  const scopeChangeHelp = data?.direction !== "INCOMING" ? "Scope changes here are available for incoming transfers." : "DRS and residual transfers require their own workflow to change scope.";

  const saveScope = async () => {
    if (!data || !scopeChangeAllowed || !editingScope || !scopeChoice || scopeChoice === data.scope || inFlight.current || stale) return;
    const base = { expectedRevision: data.sourceRevision, scope: scopeChoice, confirmed: true as const };
    const fingerprint = JSON.stringify(base);
    if (scopeAttempt.current?.fingerprint !== fingerprint) {
      scopeAttempt.current = { fingerprint, input: { ...base, operationId: crypto.randomUUID() } };
    }
    const current = request.current;
    inFlight.current = true; setBusy("scope"); setFailure(null); setNotice(null);
    try {
      const result = await updateTransferScope(recordId, scopeAttempt.current.input);
      if (current !== request.current) return;
      if (result.ok) {
        setCreatedDocument(null); focusNextStep.current = true;
        applySource(result.data);
        setNotice("Scope saved. Review the transfer instructions before generating a new form.");
        // A surrounding-view refresh cannot undo the already committed scope save.
        try {
          if (result.data.scope === "FULL" || result.data.scope === "PARTIAL") scopeChangedCallback.current?.(result.data.scope);
        } catch { /* Preserve the successful save. */ }
      } else handleFailure(result.reason);
    } catch {
      if (current === request.current) setFailure("unavailable");
    } finally {
      inFlight.current = false;
      if (current === request.current) setBusy(null);
    }
  };

  const saveTitle = async () => {
    const selectedRegistration = receivingRegistrationSchema.safeParse(registration);
    if (!data || editingScope || inFlight.current || stale || !title.trim() || !selectedRegistration.success) return;
    const base = { expectedRevision: data.sourceRevision, title: title.trim(), registration: selectedRegistration.data, confirmed: true as const };
    const fingerprint = JSON.stringify(base);
    if (confirmAttempt.current?.fingerprint !== fingerprint) {
      confirmAttempt.current = { fingerprint, input: { ...base, operationId: crypto.randomUUID() } };
    }
    const current = request.current;
    inFlight.current = true; setBusy("confirm"); setFailure(null); setNotice(null);
    try {
      const result = await confirmReceivingTitle(recordId, confirmAttempt.current.input);
      if (current !== request.current) return;
      if (result.ok) {
        focusNextStep.current = true;
        applySource(result.data, { sourceRevision: data.sourceRevision, workflowId, instruction, positionInstructions, houseAccount, letterRequired });
        setNotice("Receiving account confirmed and saved.");
      }
      else handleFailure(result.reason);
    } catch {
      if (current === request.current) setFailure("unavailable");
    } finally {
      inFlight.current = false;
      if (current === request.current) setBusy(null);
    }
  };

  const workflow = data?.workflows.find((candidate) => candidate.id === workflowId);
  const assetInstruction = workflow?.handling.mode === "FIXED" ? workflow.handling.options[0] : instruction;
  const includedPositions = data?.positions.filter((position) => position.include === true) ?? [];
  const mixedAvailable = Boolean(data && supportsMixed(data, workflow));
  const handlingDone = Boolean(data && handlingComplete(data, workflow, assetInstruction || "", positionInstructions));
  const mixedReason = includedPositions.length < 2 ? "A mix needs at least two included holdings. For one holding, choose in kind or liquidate above."
    : includedPositions.some((position) => !positionInstructions[position.id]) ? "Choose an instruction for every included holding."
    : "A mix needs at least one holding in kind and one liquidated. Otherwise, choose a single instruction above.";
  const undecidedCount = data?.scope === "PARTIAL" ? data.positions.filter((position) => position.include === null).length : 0;
  const partialUndecided = undecidedCount > 0;
  const partialEmpty = data?.scope === "PARTIAL" && !data.positions.some((position) => position.include === true);
  const receivingValid = Boolean(data && hasValidReceivingConfirmation(data));
  const registrationIsSupported = receivingRegistrationSchema.safeParse(registration).success;
  const previousRegistrationNeedsReview = Boolean(data?.confirmation && !suggestedReceivingRegistration(data.confirmation.registration));
  const titleMismatch = Boolean(data?.inheritedTitleReview && data.confirmation && deliveringTitle.trim().replace(/\s+/g, " ").toLowerCase() !== data.confirmation.title.trim().replace(/\s+/g, " ").toLowerCase());
  const canGenerate = Boolean(data && !stale && !loading && !busy && !editingScope && !editing && receivingValid &&
    data.direction === "INCOMING" && data.scope !== "UNKNOWN" && data.blockers.length === 0 &&
    !partialUndecided && !partialEmpty && (!titleMismatch || letterRequired) && workflow?.automated && assetInstruction &&
    handlingDone && deliveringTitle.trim() && !editingDelivering && reviewed && (!workflow.requiresReceivingAccountNumber || (houseAccount.trim() && houseVerified)));

  const generate = async () => {
    if (!canGenerate || !data?.confirmation?.id || !workflow || !assetInstruction || inFlight.current) return;
    const base = {
      expectedRevision: data.sourceRevision, confirmationId: data.confirmation.id, workflowId: workflow.id,
      assetInstruction, deliveringTitle: deliveringTitle.trim(), deliveringTitleConfirmed: true as const,
      accountsReviewed: true as const, instructionsReviewed: true as const, letterOfAuthorizationRequired: letterRequired,
      ...(assetInstruction === "MIXED" ? { positionInstructions: includedPositions.map((position) => ({ positionId: position.id, assetInstruction: positionInstructions[position.id] })) } : {}),
      ...(workflow.requiresReceivingAccountNumber ? { receivingAccountNumber: houseAccount.trim(), receivingAccountNumberVerified: true as const } : {}),
    };
    const fingerprint = JSON.stringify(base);
    if (generateAttempt.current?.fingerprint !== fingerprint) {
      const parsed = generateTransferFormSchema.safeParse({ ...base, operationId: crypto.randomUUID() });
      if (!parsed.success) { setFailure("invalid"); return; }
      generateAttempt.current = { fingerprint, input: parsed.data };
    }
    const current = request.current;
    inFlight.current = true; setBusy("generate"); setFailure(null); setNotice(null);
    try {
      const result = await generateTransferForm(recordId, generateAttempt.current.input);
      if (current !== request.current) return;
      if (result.ok) {
        setCreatedDocument(result.data.documentId);
        setNotice("The PDF was generated and archived. Open it below for human review.");
        clearGenerationReview();
        // Archive success stands even if refreshing its history entry fails.
        // Never turn that follow-up read into a second generation attempt.
        try {
          const latest = await loadTransferForm(recordId);
          if (current !== request.current) return;
          if (latest.ok) {
            if (latest.data.sourceRevision === data.sourceRevision && latest.data.confirmation?.id === data.confirmation.id && latest.data.confirmation?.valid) {
              setData(latest.data); setHistory(latest.data.documents);
            } else applySource(latest.data);
          }
          else if (latest.reason === "forbidden" || latest.reason === "disabled") handleFailure(latest.reason);
          else setNotice("The PDF was generated and archived. Open it below; refresh form details to update the history list.");
        } catch {
          if (current === request.current) setNotice("The PDF was generated and archived. Open it below; refresh form details to update the history list.");
        }
      } else handleFailure(result.reason);
    } catch {
      if (current === request.current) setFailure("unavailable");
    } finally {
      inFlight.current = false;
      if (current === request.current) setBusy(null);
    }
  };

  const changeGeneration = () => { setReviewed(false); generateAttempt.current = null; setNotice(null); };
  const startScopeEdit = () => {
    if (!data || !scopeChangeAllowed || inFlight.current || stale) return;
    setScopeChoice(data.scope === "FULL" || data.scope === "PARTIAL" ? data.scope : "");
    setEditingScope(true); scopeAttempt.current = null; setFailure(null); changeGeneration();
  };
  const titleEdit = () => {
    if (!data) return;
    setTitle(data.confirmation?.title || data.accounts.receivingTitleSuggestion);
    setRegistration(suggestedReceivingRegistration(data.confirmation?.registration ?? data.accounts.registrationSuggestion));
    setEditing(true); confirmAttempt.current = null; changeGeneration(); advance("receiving");
  };

  const receiverDone = receivingValid && !editing;
  const routeDone = Boolean(workflow?.automated);
  const houseDone = !workflow?.requiresReceivingAccountNumber || Boolean(houseAccount.trim() && houseVerified);
  const reviewAvailable = receiverDone && routeDone && handlingDone && houseDone;
  const controlsLocked = Boolean(busy) || stale || editingScope;
  const showRoute = Boolean(data && (data.workflows.length !== 1 || !data.workflows[0].automated));
  const showHandling = workflow?.handling.mode === "CLIENT_DIRECTED";
  const showHouse = Boolean(workflow?.requiresReceivingAccountNumber);
  const steps: FormStep[] = ["receiving", ...(showRoute ? ["route" as const] : []), ...(showHandling ? ["handling" as const] : []), ...(showHouse ? ["house" as const] : []), "review"];
  const stepNumber = (step: FormStep) => steps.indexOf(step) + 1;
  const missingReason = !data ? "" : stale ? "Refresh the source before continuing."
    : !receiverDone ? "Confirm and save the receiving account first."
    : data.direction !== "INCOMING" ? "Automatic form preparation supports incoming transfers only."
    : data.scope === "UNKNOWN" ? scopeChangeAllowed ? "Choose Full or Partial using Change transfer scope above." : "Confirm the transfer scope in Tracker, then refresh."
    : partialUndecided ? `Decide whether to include ${undecidedCount === 1 ? "the undecided holding" : `all ${undecidedCount} undecided holdings`} in Tracker, then refresh.`
    : partialEmpty ? "Select at least one holding in Tracker, then refresh."
    : data.blockers.length ? data.blockers[0].message
    : !workflow ? "Choose a supported form route."
    : !workflow.automated ? "This route requires manual form preparation in Tracker."
    : !handlingDone ? instruction === "MIXED" ? mixedReason : "Choose how the assets should transfer."
    : !houseDone ? "Verify the receiving / house account number with Apex MF Ops."
    : editingDelivering ? "Finish editing the delivering title."
    : !deliveringTitle.trim() ? "Enter the exact delivering title."
    : titleMismatch && !letterRequired ? "Confirm the required separate Letter of Authorization for the different inherited account titles."
    : !reviewed ? "Check the final review confirmation to generate the form." : "";

  return <div className={styles.body}>
    {loading && <p role="status">Loading current form details…</p>}
    {failure && <p role={failure === "disabled" ? "status" : "alert"} className={styles.message}>{failureCopy[failure]}</p>}
    {notice && <p role="status" className={styles.notice}>{notice}</p>}
    {data && <>
      <div className={styles.context}><p><strong>{data.custodian?.name || "Custodian not confirmed"}</strong></p>
        {(!createdDocument || stale) && <button type="button" className={styles.textButton} disabled={Boolean(busy) || editingScope} onClick={() => void refresh()}>Refresh details</button>}
      </div>
      <dl className={styles.transferFacts} aria-label="Transfer scope and method"><div><dt>Transfer scope:</dt><dd>{data.scope === "FULL" ? "Full transfer" : data.scope === "PARTIAL" ? "Partial transfer" : "Not confirmed"}</dd><button type="button" className={styles.textButton} aria-label="Change transfer scope" title={scopeChangeAllowed ? undefined : scopeChangeHelp} disabled={controlsLocked || !scopeChangeAllowed} onClick={startScopeEdit}>Change</button></div><div><dt>Transfer method:</dt><dd>{transferMethodLabels[data.transferMethod ?? "UNCLASSIFIED"]}</dd></div></dl>
      {editingScope && <section className={`${styles.step} ${styles.active}`} aria-labelledby={`${id}-scope`}>
        <div className={styles.stepHeader}><h4 id={`${id}-scope`} ref={scopeHeading} tabIndex={-1}>Change transfer scope</h4></div>
        <fieldset disabled={Boolean(busy) || stale} className={styles.fields}>
          <label>New transfer scope<select value={scopeChoice} onChange={(event) => { const value = event.target.value; setScopeChoice(value === "FULL" || value === "PARTIAL" ? value : ""); scopeAttempt.current = null; setFailure(null); }}><option value="">Choose a scope</option><option value="FULL">Full transfer</option><option value="PARTIAL">Partial transfer</option></select></label>
          {scopeChoice === "FULL" && <p>Full transfer includes all assets in the delivering account, including holdings previously excluded from a partial transfer.</p>}
          {scopeChoice === "PARTIAL" && <p>Partial transfer uses the current holding selections in Tracker. Review included, excluded and undecided holdings before generating a form.</p>}
          {history.length > 0 && <p className={styles.help}>Earlier PDFs keep their original scope. Saving a new scope does not change or overwrite those forms.</p>}
          <div className={styles.actions}><button type="button" className={styles.primary} disabled={!scopeChoice || scopeChoice === data.scope} onClick={() => void saveScope()}>{busy === "scope" ? "Saving scope…" : "Save scope"}</button><button type="button" className={styles.button} onClick={() => { setEditingScope(false); setScopeChoice(""); scopeAttempt.current = null; setFailure(null); focusNextStep.current = true; }}>Cancel scope change</button></div>
        </fieldset>
      </section>}
      {data.transferMethod === "MANUAL" && workflow?.automated && <p className={styles.help}>Manual processing; this form can still be generated here.</p>}
    </>}
    {createdDocument && !editingScope && <div className={styles.success}><a className={styles.primary} href={documentHref(recordId, createdDocument)} target="_blank" rel="noopener noreferrer">Open PDF ↗</a><span>Saved in the transfer history. Review before sending.</span></div>}
    {data && !createdDocument && !editingScope && <>
      <div className={styles.accounts}>
        <div><span>Delivering</span><strong>{data.accounts.deliveringMasked || "Not available"}</strong></div>
        <span className={styles.arrow} aria-hidden="true">→</span>
        <div><span>Receiving</span><strong>{data.accounts.receivingMasked || "Not available"}</strong></div>
      </div>
      {partialUndecided && <div className={styles.blocker} role="note"><strong>Undecided holdings: {undecidedCount}</strong><p>Choose Included or Excluded in Tracker, then refresh to continue.</p><ul>{data.positions.filter((position) => position.include === null).map((position) => <li key={position.id}>{position.symbol || position.description || "Unnamed holding"} · {position.quantity.toLocaleString()}</li>)}</ul></div>}
      {data.blockers.filter((blocker) => blocker.code !== "receiving_confirmation").length > 0 && <div className={styles.blocker}><strong>Before you generate</strong><ul>{data.blockers.filter((blocker) => blocker.code !== "receiving_confirmation").map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}</ul></div>}
      <section className={`${styles.step} ${activeStep === "receiving" ? styles.active : ""}`} aria-labelledby={`${id}-receiving`}>
        <div className={styles.stepHeader}><h4 id={`${id}-receiving`} tabIndex={-1} ref={activeStep === "receiving" ? stepHeading : undefined}><span>{stepNumber("receiving")}</span>Receiving account</h4>
          {receiverDone && activeStep !== "receiving" && <button type="button" className={styles.textButton} disabled={controlsLocked} onClick={titleEdit}>Edit receiving account</button>}
        </div>
        {data.confirmation && !editing && <div className={styles.completed}><strong>{data.confirmation.title}</strong><span>{data.confirmation.registration || "Registration not recorded"}</span><p className={styles.attribution}>Confirmed by {data.confirmation.confirmedBy || "an unrecorded user"} · <span>Confirmed at <time dateTime={data.confirmation.confirmedAt ?? undefined}>{dateLabel(data.confirmation.confirmedAt)}</time></span></p></div>}
        {activeStep === "receiving" && <fieldset disabled={controlsLocked} className={styles.fields}>
          {data.confirmation && !data.confirmation.valid && <p className={styles.message}>{data.confirmation.source === "TRACKER_LEGACY" ? "Earlier Tracker confirmation — reconfirm" : "Receiving details changed — reconfirm"}</p>}
          {data.confirmation && <p className={styles.attribution}>Previously saved: {data.confirmation.title} · {data.confirmation.registration || "Registration not recorded"}<br />Previous confirmation by {data.confirmation.confirmedBy || "an unrecorded user"} · <time dateTime={data.confirmation.confirmedAt ?? undefined}>{dateLabel(data.confirmation.confirmedAt)}</time></p>}
          <p>Confirm how the receiving account is titled.</p>
          <label>Exact receiving account title<input autoComplete="off" maxLength={200} value={title} onChange={(event) => { setTitle(event.target.value); confirmAttempt.current = null; changeGeneration(); }} /></label>
          <label>Receiving registration<select value={registration} onChange={(event) => { setRegistration(event.target.value); confirmAttempt.current = null; changeGeneration(); }}><option value="">Choose a registration</option>{RECEIVING_REGISTRATIONS.map((option) => <option key={option} value={option}>{option}</option>)}<option value="__NOT_LISTED__">Not listed — needs review</option></select></label>
          {previousRegistrationNeedsReview && <p className={styles.help}>The saved registration needs review. Choose the correct registration and confirm it, or select Not listed for review.</p>}
          {registration === "__NOT_LISTED__" && <p className={styles.message}>Review this account’s registration before continuing. No change will be saved until a supported registration is selected and confirmed.</p>}
          <p className={styles.help}>By selecting Confirm and save, I confirm that I verified this exact title and registration against the receiving account.</p>
          <div className={styles.actions}><button type="button" className={styles.primary} disabled={!title.trim() || !registrationIsSupported} onClick={() => void saveTitle()}>{busy === "confirm" ? "Saving…" : "Confirm and save"}</button>
            {receivingValid && <button type="button" className={styles.button} onClick={() => { setEditing(false); confirmAttempt.current = null; setFailure(null); advance(nextQuestion(data, workflowId, instruction, houseVerified, positionInstructions)); }}>Cancel</button>}
          </div>
        </fieldset>}
      </section>
      {showRoute && <section className={`${styles.step} ${activeStep === "route" ? styles.active : ""}`} aria-labelledby={`${id}-route`}>
        <div className={styles.stepHeader}><h4 id={`${id}-route`} tabIndex={-1} ref={activeStep === "route" ? stepHeading : undefined}><span>{stepNumber("route")}</span>Transfer route</h4>
          {receiverDone && activeStep !== "route" && <button type="button" className={styles.textButton} disabled={controlsLocked} onClick={() => { changeGeneration(); advance("route"); }}>Change route</button>}
        </div>
        {activeStep !== "route" && <p className={styles.summary}>{workflow?.name || "After the receiving account is confirmed"}</p>}
        {activeStep === "route" && <fieldset disabled={controlsLocked || !receiverDone} className={styles.fields}>
          <p>Which route applies to this transfer?</p>
          {data.workflows.length > 1 ? <label>Form route<select value={workflowId} onChange={(event) => { setWorkflowId(event.target.value); setInstruction(""); setPositionInstructions({}); setHouseAccount(""); clearGenerationReview(); }}><option value="">Choose a route</option>{data.workflows.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.automated ? "" : " · prepare form manually"}</option>)}</select></label> : <p>{workflow?.name || "No supported route is available. Confirm the custodian and route in Tracker."}</p>}
          {workflow?.note && <p className={styles.help}>{workflow.note}</p>}
          {workflow && !workflow.automated && <p className={styles.blocker}>This route requires manual form preparation. Continue in Transfer Tracker.</p>}
          {workflow?.automated && <button type="button" className={styles.primary} onClick={() => advance(nextQuestion(data, workflowId, instruction, houseVerified, positionInstructions))}>Continue</button>}
        </fieldset>}
      </section>}
      {showHandling && <section className={`${styles.step} ${activeStep === "handling" ? styles.active : ""}`} aria-labelledby={`${id}-handling`}>
        <div className={styles.stepHeader}><h4 id={`${id}-handling`} tabIndex={-1} ref={activeStep === "handling" ? stepHeading : undefined}><span>{stepNumber("handling")}</span>Asset handling</h4>
          {receiverDone && routeDone && activeStep !== "handling" && <button type="button" className={styles.textButton} disabled={controlsLocked} onClick={() => { changeGeneration(); advance("handling"); }}>Change asset handling</button>}
        </div>
        {activeStep !== "handling" && <p className={styles.summary}>{instruction === "IN_KIND" ? "Transfer in kind" : instruction === "LIQUIDATE" ? "Liquidate and transfer cash" : instruction === "MIXED" ? `${includedPositions.filter((position) => positionInstructions[position.id] === "IN_KIND").length} in kind · ${includedPositions.filter((position) => positionInstructions[position.id] === "LIQUIDATE").length} liquidated` : "After the previous decision"}</p>}
        {activeStep === "handling" && <fieldset disabled={controlsLocked || !receiverDone || !routeDone} className={styles.fields}>
          <legend>How should these assets transfer?</legend>
          <div className={styles.choices}>{workflow.handling.options.map((option) => <label key={option} className={`${styles.choice} ${instruction === option ? styles.chosen : ""}`}><input type="radio" name={`${id}-instruction`} value={option} checked={instruction === option} onChange={() => { setInstruction(option); setPositionInstructions({}); changeGeneration(); }} /><span><strong>{option === "IN_KIND" ? "Transfer in kind" : "Liquidate and transfer cash"}</strong><span>{option === "IN_KIND" ? "Move the selected investments without selling them." : "Sell the selected investments and transfer the proceeds."}</span></span></label>)}
            {mixedAvailable && <label className={`${styles.choice} ${instruction === "MIXED" ? styles.chosen : ""}`}><input type="radio" name={`${id}-instruction`} value="MIXED" checked={instruction === "MIXED"} onChange={() => { setInstruction("MIXED"); setPositionInstructions({}); changeGeneration(); }} /><span><strong>Mix of in-kind and cash</strong><span>Choose a different instruction for each included holding.</span></span></label>}
          </div>
          {instruction === "MIXED" && mixedAvailable && <div className={styles.positionChoices}>
            <p className={styles.help}>Each choice applies to all shares of that selected holding. Transfer selections are managed in Tracker.</p>
            {includedPositions.map((position) => <label key={position.id}><span><strong>{position.symbol || position.description || "Unnamed holding"}</strong>{position.symbol && <span className={styles.meta}>{position.description}</span>}<span className={styles.meta}>Recorded quantity: {position.quantity.toLocaleString()}</span></span><select aria-label={`Instruction for ${position.symbol || position.description || "Unnamed holding"}`} value={positionInstructions[position.id] || ""} onChange={(event) => { const value = event.target.value; setPositionInstructions((current) => ({ ...current, [position.id]: value === "IN_KIND" || value === "LIQUIDATE" ? value : undefined })); changeGeneration(); }}><option value="">Choose an instruction</option><option value="IN_KIND">Transfer in kind</option><option value="LIQUIDATE">Liquidate to cash</option></select></label>)}
            {!handlingDone && <p className={styles.nextAction}>{mixedReason}</p>}
          </div>}
          <button type="button" className={styles.primary} disabled={!handlingDone} onClick={() => advance(showHouse && !houseDone ? "house" : "review")}>Continue</button>
        </fieldset>}
      </section>}
      {showHouse && <section className={`${styles.step} ${activeStep === "house" ? styles.active : ""}`} aria-labelledby={`${id}-house`}>
        <div className={styles.stepHeader}><h4 id={`${id}-house`} tabIndex={-1} ref={activeStep === "house" ? stepHeading : undefined}><span>{stepNumber("house")}</span>Receiving / house account</h4>
          {receiverDone && routeDone && handlingDone && activeStep !== "house" && <button type="button" className={styles.textButton} disabled={controlsLocked} onClick={() => { changeGeneration(); advance("house"); }}>Change house account</button>}
        </div>
        {activeStep !== "house" && <p className={styles.summary}>{houseDone ? "Verified with Apex MF Ops" : "Required for this form route"}</p>}
        {activeStep === "house" && <fieldset disabled={controlsLocked || !receiverDone || !handlingDone} className={styles.fields}>
          <p>This route needs a receiving / house account number verified with Apex MF Ops.</p>
          <label>Receiving / house account number<input autoComplete="off" maxLength={100} value={houseAccount} onChange={(event) => { setHouseAccount(event.target.value); setHouseVerified(false); changeGeneration(); }} /></label>
          <label className={styles.check}><input type="checkbox" checked={houseVerified} onChange={(event) => { setHouseVerified(event.target.checked); changeGeneration(); }} />I verified this number with Apex MF Ops.</label>
          <button type="button" className={styles.primary} disabled={!houseDone} onClick={() => advance("review")}>Continue</button>
        </fieldset>}
      </section>}
      <section className={`${styles.step} ${activeStep === "review" ? styles.active : ""}`} aria-labelledby={`${id}-review`}>
        <div className={styles.stepHeader}><h4 id={`${id}-review`} tabIndex={-1} ref={activeStep === "review" ? stepHeading : undefined}><span>{stepNumber("review")}</span>Review &amp; generate</h4>
          {reviewAvailable && activeStep !== "review" && <button type="button" className={styles.textButton} disabled={controlsLocked} onClick={() => advance("review")}>Review packet</button>}
        </div>
        {activeStep !== "review" && <p className={styles.summary}>A final review before the PDF is created.</p>}
        {activeStep === "review" && <>
          <p className={styles.routeSummary}><strong>{workflow?.name}</strong>{workflow?.handling.mode === "FIXED" && <span>This route uses {assetInstruction === "LIQUIDATE" ? "liquidation" : "in-kind transfer"}. Confirm this matches the client instructions.</span>}</p>
          <div className={styles.titleRow}><div><span className={styles.label}>Delivering account title</span>{!editingDelivering && <strong>{deliveringTitle || "Not recorded"}</strong>}</div>{!editingDelivering && <button type="button" className={styles.textButton} disabled={controlsLocked} onClick={() => { deliveringBeforeEdit.current = deliveringTitle; setEditingDelivering(true); changeGeneration(); }}>Edit delivering title</button>}</div>
          {editingDelivering && <fieldset disabled={controlsLocked} className={styles.fields}><label>Exact delivering account title<input autoComplete="off" maxLength={200} value={deliveringTitle} onChange={(event) => { setDeliveringTitle(event.target.value); changeGeneration(); }} /></label><div className={styles.actions}><button type="button" className={styles.button} disabled={!deliveringTitle.trim()} onClick={() => setEditingDelivering(false)}>Done</button><button type="button" className={styles.textButton} onClick={() => { setDeliveringTitle(deliveringBeforeEdit.current); setEditingDelivering(false); }}>Cancel title edit</button></div></fieldset>}
          {titleMismatch && <div className={styles.blocker}><strong>Separate authorization required</strong><p>The inherited account titles differ. This packet needs a separate Letter of Authorization.</p><label className={styles.check}><input type="checkbox" disabled={controlsLocked} checked={letterRequired} onChange={(event) => { setLetterRequired(event.target.checked); changeGeneration(); }} />A separate Letter of Authorization is required for this packet.</label><p className={styles.help}>The generated form marks this requirement; prepare the letter separately. A Letter of Acceptance is a different document.</p></div>}
          {data.scope === "PARTIAL" ? <div className={styles.holdings}><h5>Selected holdings</h5><HoldingTable data={data} positionInstructions={instruction === "MIXED" ? positionInstructions : undefined} />{instruction === "MIXED" && <p className={styles.help}>All shares of each included holding.</p>}<p className={styles.help}>Change selections in Tracker, then refresh here.</p></div> : <details className={styles.notes}><summary>All assets in the delivering account</summary><p className={styles.help}>Recorded holdings: {data.positions.length}. A full transfer includes all assets.</p>{data.positions.length > 0 && <HoldingTable data={data} />}</details>}
          <details className={styles.notes}><summary>Additional requirements</summary>
            {!titleMismatch && <label className={styles.check}><input type="checkbox" disabled={controlsLocked} checked={letterRequired} onChange={(event) => { setLetterRequired(event.target.checked); changeGeneration(); }} />A separate Letter of Authorization is required for this packet.</label>}
            <p className={styles.help}>This marks the requirement; it does not create the letter. A Letter of Acceptance is a different document.</p>
            <dl className={styles.requirements}>{data.requirements.map((requirement, index) => <div key={`${requirement.label}-${index}`}><dt>{requirement.label}</dt><dd>{requirement.value}</dd></div>)}</dl>
            <ul>{data.notices.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </details>
          <label className={`${styles.check} ${styles.finalCheck}`}><input type="checkbox" disabled={controlsLocked || editingDelivering || !reviewAvailable} checked={reviewed} onChange={(event) => { setReviewed(event.target.checked); generateAttempt.current = null; setNotice(null); }} />I verified the delivering title and reviewed both accounts, selected holdings and transfer instructions.</label>
          {missingReason && !busy && <p className={styles.nextAction}>{missingReason}</p>}
          <button type="button" className={styles.primary} disabled={!canGenerate} onClick={() => void generate()}>{busy === "generate" ? "Generating and archiving…" : "Generate form"}</button>
          <p className={styles.help}>Creates an archived PDF for human review. Nothing is signed or submitted.</p>
        </>}
      </section>
    </>}
    {!loading && !data && failure !== "forbidden" && failure !== "disabled" && <button type="button" className={styles.button} onClick={() => void refresh()}>Refresh details</button>}
    {createdDocument && <button type="button" className={styles.button} disabled={Boolean(busy) || editingScope} onClick={() => { setCreatedDocument(null); void refresh(); }}>Prepare another form</button>}
    {history.length > 0 && <details className={styles.history}><summary>Previous forms · {history.length}</summary><ul>{history.map((document) => <li key={document.id}><a className={styles.link} href={documentHref(recordId, document.id)} target="_blank" rel="noopener noreferrer">{document.filename}</a><span className={styles.meta}>{document.createdBy} · {dateLabel(document.createdAt)}</span></li>)}</ul></details>}
    <div className={styles.footer}><a className={styles.link} href={EXTERNAL_APPS.acatTracking} target="_blank" rel="noopener noreferrer">Open Transfer Tracker ↗</a>{data && <span className={styles.meta}>Checked {dateLabel(data.checkedAt)}</span>}</div>
  </div>;
}

function FormDisclosure({ recordId, defaultOpen, onScopeChanged }: { recordId: string; defaultOpen: boolean; onScopeChanged?: (scope: "FULL" | "PARTIAL") => void }) {
  const [open, setOpen] = useState(defaultOpen);
  return <details className={styles.disclosure} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Prepare transfer form</summary>
    {open && <FormSession recordId={recordId} onScopeChanged={onScopeChanged} />}
  </details>;
}

export function TransferFormPanel({ recordId, defaultOpen = false, onScopeChanged }: { recordId: string; defaultOpen?: boolean; onScopeChanged?: (scope: "FULL" | "PARTIAL") => void }) {
  return <FormDisclosure key={recordId} recordId={recordId} defaultOpen={defaultOpen} onScopeChanged={onScopeChanged} />;
}
