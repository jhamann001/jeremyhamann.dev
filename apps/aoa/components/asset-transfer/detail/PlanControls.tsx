"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { approveFundingPlan, recordAppAuthorization } from "@/app/(authenticated)/asset-transfer/actions";
import { FUNDING_TYPES, FUNDING_TYPE_LABEL, type FundingType, type TransferDecisionChoice } from "@/lib/data/transfer-types";
import type { FundingPlanApprovalMode, FundingPlanDraftInput } from "@/lib/data/transfer-plan-approval";
import { WorkspaceDialog, FormTransferContext } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import { Badge, btnClass, cash } from "@/components/asset-transfer/workspace/ui";
import { routeCopy } from "./detail-model";
import type { PlanHolding } from "./load-detail";

export type PlanControlProps = {
  transferId: string;
  fundingType: FundingType | null;
  holdings: PlanHolding[];
  baseVersion: number;
  approvalMode: FundingPlanApprovalMode;
  canEdit: boolean;
  canApprove: boolean;
  approved: boolean;
  submitted: boolean;
  contextTitle: string;
  contextDetail: string;
  contextLine: string;
  /** The paperwork records are on, so a full ACAT can record app authorization. */
  authorizationAvailable: boolean;
  appAuthorized: boolean;
};

type Authorization = "app" | "paper";

type Choice = "in_kind" | "leave" | "undecided";

function initialChoice(holding: PlanHolding): Choice {
  if (holding.isTransferring != null) return holding.isTransferring ? "in_kind" : "leave";
  if (holding.decision === "LEAVE_GIFT") return "leave";
  return holding.decision === "UNDECIDED" ? "undecided" : "in_kind";
}

function draftInput(props: PlanControlProps, fundingType: FundingType | null, choices: Record<string, Choice>, note: string): FundingPlanDraftInput {
  const decisionOf = (choice: Choice): TransferDecisionChoice => (choice === "leave" ? "LEAVE_GIFT" : choice === "undecided" ? "UNDECIDED" : "BRING_IN");
  return {
    approvalMode: props.approvalMode,
    baseVersion: props.baseVersion,
    fundingType,
    basisDecisions: props.holdings.filter(holding => holding.decisionId).map(holding => ({
      decisionId: holding.decisionId as string, decision: decisionOf(choices[holding.key] ?? initialChoice(holding)),
    })),
    partialPositions: props.holdings.filter(holding => holding.isTransferring != null).map(holding => ({
      symbol: holding.symbol, isTransferring: (choices[holding.key] ?? initialChoice(holding)) !== "leave",
    })),
    note,
  };
}

/** Mockup "Approve funding plan": approves the saved plan as it stands. */
export function ApprovePlanButton(props: PlanControlProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const disabled = pending || !props.canApprove || props.approved || props.fundingType == null;
  return (
    <div>
      <button type="button" className={btnClass({ primary: true })} data-ui="review" disabled={disabled}
        onClick={() => startTransition(async () => {
          setError(null);
          const result = await approveFundingPlan(props.transferId, draftInput(props, props.fundingType, {}, ""));
          if (!result.ok) { setError(result.errors[0]?.message ?? "The funding plan could not be approved."); return; }
          router.refresh();
        })}>
        {pending ? "Approving…" : props.approved ? "Funding plan approved" : "Approve funding plan"}
      </button>
      {error ? <p className="upload-error" role="alert">{error}</p> : null}
    </div>
  );
}

export function EditPlanDialog(props: PlanControlProps) {
  const title = props.canEdit ? "Edit asset mapping & funding plan" : "Current funding plan";
  return (
    <WorkspaceDialog title={title} trigger={props.submitted || !props.canEdit ? "View funding plan" : "Edit mapping & plan"}
      context={<FormTransferContext title={props.contextTitle} detail={props.contextDetail} />}>
      {close => <PlanForm {...props} close={close} />}
    </WorkspaceDialog>
  );
}

function PlanForm(props: PlanControlProps & { close: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [fundingType, setFundingType] = useState<FundingType | null>(props.fundingType);
  const [choices, setChoices] = useState<Record<string, Choice>>(() => Object.fromEntries(props.holdings.map(holding => [holding.key, initialChoice(holding)])));
  const [note, setNote] = useState("");
  const [authorization, setAuthorization] = useState<Authorization>(props.appAuthorized ? "app" : "paper");
  const [errors, setErrors] = useState<string[]>([]);
  const full = fundingType === "ACAT_FULL";
  const showAuthorization = full && props.authorizationAvailable;
  const recordAuthorization = showAuthorization && authorization === "app" && !props.appAuthorized;
  const cashOnly = fundingType === "ACH" || fundingType === "WIRE";
  const effective = (holding: PlanHolding): Choice => (full ? "in_kind" : choices[holding.key] ?? "in_kind");
  const moving = props.holdings.filter(holding => effective(holding) !== "leave");
  const left = props.holdings.filter(holding => effective(holding) === "leave");
  const selectedValue = moving.reduce((sum, holding) => sum + (holding.value ?? 0), 0);
  const readOnly = !props.canEdit;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly) return;
    setErrors([]);
    startTransition(async () => {
      const result = await approveFundingPlan(props.transferId, draftInput(props, fundingType, full ? {} : choices, note));
      if (!result.ok) { setErrors(result.errors.map(error => error.message)); return; }
      if (recordAuthorization) {
        const recorded = await recordAppAuthorization(props.transferId);
        if (!recorded.ok) {
          setErrors(["The plan was saved, but the app authorization was not recorded. Record it from the paperwork step."]);
          router.refresh();
          return;
        }
      }
      router.refresh();
      props.close();
    });
  };

  return (
    <form id="funding-plan-form" onSubmit={submit}>
      <p><strong>{props.contextLine}</strong> · Current plan v{props.baseVersion}</p>
      <p>{readOnly
        ? props.submitted ? "This movement has already been initiated. The submitted plan is retained." : "Operations edits and approves the funding plan during Decision."
        : "Choose how the assets move and how much of the account to include."}</p>
      <div className="twocol">
        <label className="field"><span>Movement method</span>
          <select name="fundingType" value={fundingType ?? ""} disabled={readOnly} required onChange={event => setFundingType((event.target.value || null) as FundingType | null)}>
            <option value="">Choose a funding method</option>
            {FUNDING_TYPES.map(type => <option key={type} value={type}>{FUNDING_TYPE_LABEL[type]}</option>)}
          </select>
        </label>
        <label className="field"><span>Transfer scope</span>
          <select name="scope" disabled value={full ? "full" : cashOnly ? "cash" : "selected"}>
            <option value="full">Full account</option>
            <option value="selected">Selected holdings</option>
            <option value="cash">Cash only</option>
          </select>
        </label>
      </div>
      {showAuthorization ? (
        <label className="field" id="plan-authorization-field"><span>Authorization for this full ACAT</span>
          <select name="authorization" id="plan-authorization" value={authorization} disabled={readOnly || props.appAuthorized}
            onChange={event => setAuthorization(event.target.value as Authorization)}>
            <option value="app">Client authorization through the app</option>
            <option value="paper">Signed transfer paperwork</option>
          </select>
          <small id="plan-authorization-note">{props.appAuthorized
            ? "Client app authorization is recorded for this transfer. Both full ACAT paths are submitted through the Apex API."
            : "Both full ACAT paths are submitted through the Apex API."}</small>
        </label>
      ) : null}
      <fieldset className="plan-assets">
        <legend>Asset mapping · what moves</legend>
        <p className="small">Choose an instruction for each holding. The saved plan uses these same selections.</p>
        <p className="small" id="plan-holding-help">{full
          ? "Full ACAT includes the entire account as held. Individual holdings cannot be left behind."
          : cashOnly ? "ACH and wire move existing cash only. Securities remain at the source account."
            : "Leave behind excludes a holding from this movement. It does not hold up the included assets."}</p>
        {props.holdings.length ? props.holdings.map(holding => {
          const choice = effective(holding);
          return (
            <div className="plan-asset-row" data-mapping-holding={holding.key} key={holding.key}>
              <div>
                <div className="asset-pick"><span><strong>{holding.symbol}</strong> · {holding.description}<small>Mapped: {cash(holding.value)}</small>
                  <small>{holding.ineligible ? "Not eligible for in-kind ACAT" : "Eligible for in-kind ACAT"}</small></span></div>
                <div className="asset-move-status"><Badge tone={choice === "leave" ? "neutral" : "progress"}>{choice === "leave" ? "Stays at source" : "Included to move"}</Badge></div>
              </div>
              <div className="asset-treatment">
                <label className="field"><span>Instruction for {holding.symbol}</span>
                  <select name={`treatment:${holding.key}`} aria-label={`Instruction for ${holding.symbol}`} value={choice} disabled={readOnly || full}
                    onChange={event => setChoices(current => ({ ...current, [holding.key]: event.target.value as Choice }))}>
                    {full ? <option value="in_kind">Transfer in kind · full account</option> : (
                      <>
                        <option value="in_kind">Transfer in kind</option>
                        <option value="leave">Leave behind</option>
                        {holding.decisionId ? <option value="undecided">Not decided yet</option> : null}
                      </>
                    )}
                  </select>
                </label>
                <small>{choice === "leave" ? "Left behind; does not hold up this transfer." : choice === "undecided" ? "Decide before approval." : "Transfer in kind"}</small>
              </div>
            </div>
          );
        }) : <p className="small">No mapped holdings yet. Link the asset map or record holding decisions before approving a partial plan.</p>}
      </fieldset>
      <div className="plan-preview">
        <p><strong>{cash(selectedValue)} selected to move</strong>{left.length ? ` · Stays at contra: ${left.map(holding => holding.symbol).join(", ")}` : " · All mapped positions included"}</p>
        <details><summary>Workflow requirements</summary><p>{routeCopy(fundingType)}</p></details>
      </div>
      {readOnly ? (
        <div className="row" style={{ marginTop: 16 }}><button className="btn" type="button" onClick={props.close}>Close</button></div>
      ) : (
        <>
          <label className="field"><span>Approval note (optional)</span>
            <textarea name="note" maxLength={500} value={note} placeholder="Add context that should travel with this approved version."
              onChange={event => setNote(event.target.value)} />
          </label>
          {errors.length ? <p className="upload-error" role="alert">{errors.join(" · ")}</p> : null}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn primary" type="submit" disabled={pending || fundingType == null}>{pending ? "Saving…" : "Save and approve funding plan"}</button>
            <button className="btn" type="button" onClick={props.close}>Cancel</button>
          </div>
          <p className="small">Saving approves this plan as the next version. Earlier versions stay in history.</p>
        </>
      )}
    </form>
  );
}
