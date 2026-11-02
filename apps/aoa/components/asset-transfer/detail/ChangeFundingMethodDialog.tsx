"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { changeFundingMethod, prepareFundingMethodChange } from "@/app/(authenticated)/asset-transfer/funding-method-actions";
import { fundingRouteFamily, type FundingMethodChangePreparation } from "@/lib/data/transfer-funding-method-change";
import { FUNDING_TYPES, FUNDING_TYPE_LABEL, stageLabel, type FundingType, type TransferDecisionChoice, type TransferStage } from "@/lib/data/transfer-types";
import { WorkspaceDialog, FormTransferContext } from "@/components/asset-transfer/workspace/WorkspaceDialog";

export type ChangeFundingMethodProps = {
  transferId: string;
  stage: TransferStage;
  fundingType: FundingType | null;
  planVersion: number;
  methodRevision: number;
  hasAcatLink: boolean;
  contextTitle: string;
  contextDetail: string;
};

/** Edit plan after Decision: an Ops method revision (or a recorded correction once Funded) over the existing change action. */
export function ChangeFundingMethodDialog(props: ChangeFundingMethodProps) {
  const funded = props.stage === "FUNDED";
  return (
    <WorkspaceDialog title={funded ? "Correct recorded funding method" : "Change funding method"} trigger={funded ? "Correct method" : "Change method"}
      context={<FormTransferContext title={props.contextTitle} detail={props.contextDetail} />}>
      {close => <ChangeFundingMethodForm {...props} close={close} />}
    </WorkspaceDialog>
  );
}

function ChangeFundingMethodForm({ close, ...props }: ChangeFundingMethodProps & { close: () => void }) {
  const router = useRouter();
  const funded = props.stage === "FUNDED";
  const [fundingType, setFundingType] = useState<FundingType | "">("");
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [data, setData] = useState<FundingMethodChangePreparation | null>(null);
  const [loading, setLoading] = useState(false);
  const [basis, setBasis] = useState<Record<string, TransferDecisionChoice>>({});
  const [positions, setPositions] = useState<Record<string, boolean>>({});
  const partial = !funded && fundingType === "ACAT_PARTIAL";
  const missingPositions = partial && (!data || data.source === "none");
  const blocked = pending || !fundingType || !reason.trim() || !reviewed || missingPositions || (partial && loading);

  const load = async () => {
    setLoading(true);
    setErrors([]);
    try {
      const result = await prepareFundingMethodChange(props.transferId);
      if (result.ok) {
        setData(result);
        setBasis(Object.fromEntries(result.basisDecisions.map(row => [row.decisionId, row.decision])));
        setPositions(Object.fromEntries(result.partialPositions.map(row => [row.symbol, row.isTransferring])));
      } else setErrors(result.errors.map(error => error.message));
    } catch {
      setErrors(["The funding instructions could not be loaded. Try again."]);
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    if (blocked || !fundingType) return;
    setPending(true);
    setErrors([]);
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
          basisDecisions: data.basisDecisions.map(row => ({ decisionId: row.decisionId, decision: basis[row.decisionId] ?? row.decision })),
          partialPositions: data.partialPositions.map(row => ({ symbol: row.symbol, isTransferring: positions[row.symbol] ?? row.isTransferring })),
        } : {}),
      });
      if (!result.ok) { setErrors(result.errors.map(error => error.message)); setReviewed(false); return; }
      router.refresh();
      close();
    } catch {
      setErrors(["The change could not be confirmed. Refresh the transfer to check its saved method before trying again."]);
      setReviewed(false);
    } finally {
      setPending(false);
    }
  };

  const routeChanges = fundingType && (fundingRouteFamily(props.fundingType) !== fundingRouteFamily(fundingType)
    || fundingType === "ACAT_PARTIAL" || (props.fundingType === "ACAT_PARTIAL" && fundingType === "ACAT_FULL"));
  return (
    <form id="funding-method-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p>{funded
        ? "Record how this transfer was funded. Its approved plan and completed work stay intact."
        : "Review the revised instructions and approve the funding method for this transfer."}</p>
      <p><strong>Current method: {props.fundingType ? FUNDING_TYPE_LABEL[props.fundingType] : "Not selected"}</strong> · {stageLabel(props.stage)} · Plan v{props.planVersion}</p>
      <label className="field"><span>New movement method</span>
        <select name="fundingType" required value={fundingType} disabled={pending} onChange={event => {
          const method = event.target.value as FundingType | "";
          setFundingType(method); setReviewed(false); setErrors([]);
          if (!funded && method === "ACAT_PARTIAL" && !data && !loading) void load();
        }}>
          <option value="">Choose a method</option>
          {FUNDING_TYPES.map(method => <option key={method} value={method} disabled={method === props.fundingType}>{FUNDING_TYPE_LABEL[method]}</option>)}
        </select>
      </label>
      <label className="field"><span>Reason for the change</span>
        <textarea name="reason" required maxLength={500} value={reason} disabled={pending}
          placeholder="For example: Expected a wire; the deposit arrived by ACH." onChange={event => { setReason(event.target.value); setReviewed(false); }} />
      </label>
      {partial && loading ? <p className="small" role="status">Loading current funding instructions…</p> : null}
      {partial && !loading && data ? (
        <fieldset className="plan-assets" disabled={pending}>
          <legend>Asset mapping · what moves</legend>
          {data.source === "none" ? <p className="small">Link an asset map or add position decisions before changing to ACAT-Partial.</p>
            : data.source === "asset-map" ? data.partialPositions.map(row => (
              <label className="check" key={row.symbol}>
                <input type="checkbox" checked={positions[row.symbol] ?? row.isTransferring}
                  onChange={event => { setPositions(current => ({ ...current, [row.symbol]: event.target.checked })); setReviewed(false); }} />
                <span>Transfer {row.symbol} in kind</span>
              </label>
            )) : data.basisDecisions.map(row => (
              <label className="field" key={row.decisionId}><span>Instruction for {row.symbol}</span>
                <select value={basis[row.decisionId] ?? row.decision}
                  onChange={event => { setBasis(current => ({ ...current, [row.decisionId]: event.target.value as TransferDecisionChoice })); setReviewed(false); }}>
                  <option value="UNDECIDED">Not decided yet</option><option value="BRING_IN">Transfer in kind</option><option value="LEAVE_GIFT">Leave behind</option>
                </select>
              </label>
            ))}
        </fieldset>
      ) : null}
      {fundingType ? (
        <div className="notice">
          <strong>Review affected work</strong>
          <ul>
            {funded ? <>
              <li>The recorded method changes to {FUNDING_TYPE_LABEL[fundingType]}. The saved approval stays unchanged.</li>
              <li>The transfer stays Funded. Completed tasks, account links and exceptions stay as they are.</li>
            </> : <>
              <li>A new approved plan uses {FUNDING_TYPE_LABEL[fundingType]}. Earlier approvals remain in history.</li>
              <li>The transfer stays {stageLabel(props.stage)}. Its owner, links and exceptions stay as they are.</li>
              <li>{routeChanges
                ? "Funding initiation and cash-in-flight checks reset. Complete the new method's workflow or confirm actual initiation before advancing."
                : "Existing readiness and funding-initiation checks stay unchanged. Confirm that they still apply."}</li>
              {fundingType === "DRS" ? <li>DRS tasks start again for this plan. Earlier task statuses stay in the change history.</li> : null}
              {fundingType === "ACAT_PARTIAL" ? <li>Partial-ACAT execution tasks start again for the reviewed instructions.</li> : null}
            </>}
            {props.hasAcatLink ? <li>The existing ACAT link stays attached. Check that it still belongs to this transfer.</li> : null}
            <li>This change does not submit, cancel or change instructions at a custodian.</li>
          </ul>
        </div>
      ) : null}
      <label className="check">
        <input type="checkbox" checked={reviewed} disabled={pending || !fundingType || (partial && loading)} onChange={event => setReviewed(event.target.checked)} />
        <span>{funded ? "I reviewed the correction and existing links." : "I reviewed the instructions, tasks, readiness checks and existing links."}</span>
      </label>
      {errors.length ? <p className="upload-error" role="alert">{errors.join(" ")}</p> : null}
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" type="submit" disabled={blocked}>{pending ? "Saving…" : funded ? "Save correction" : "Review and approve change"}</button>
        <button className="btn" type="button" onClick={close} disabled={pending}>Cancel</button>
      </div>
    </form>
  );
}
