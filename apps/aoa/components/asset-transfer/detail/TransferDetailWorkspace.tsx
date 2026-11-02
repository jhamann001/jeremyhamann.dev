import { Suspense, type ReactNode } from "react";
import { DemoRecordLink } from "@/components/demo/DemoRecordLink";
import { otherDemoLinks } from "@/lib/demo/links";
import type { WorkspaceView } from "@/lib/navigation/transfer-query";
import { FUNDING_TYPE_LABEL } from "@/lib/data/transfer-types";
import { easternToday } from "@/lib/transfers/eastern-day";
import { canRecordOperationsOnlyTransferFact } from "@/lib/data/transfer-write";
import { DECISION_OWNER_LABEL } from "@/lib/data/decision-case-shared";
import { accountMatchBlocks } from "@/lib/transfers/intake-gates";
import { paperworkTitlesComplete } from "@/lib/data/transfer-paperwork-store";
import { transferToFormValues } from "@/components/transfers/transfer-form";
import { householdHref, viewHref } from "@/components/asset-transfer/views/view-helpers";
import { WorkspaceShell, WORKSPACE_PAGES } from "@/components/asset-transfer/workspace/WorkspaceShell";
import { FormTransferContext } from "@/components/asset-transfer/workspace/WorkspaceDialog";
import { Badge, BtnLink, WorkflowSection, WorkingAs, cash, cx } from "@/components/asset-transfer/workspace/ui";
import { StatementAccountSection } from "@/components/asset-transfer/intake/StatementAccountSection";
import { ReviewDownload } from "@/components/asset-transfer/paperwork/ReviewDownload";
import { MailingSection } from "@/components/asset-transfer/mailing/MailingSection";
import { MailingHistoryPanel } from "@/components/asset-transfer/mailing/MailingHistoryPanel";
import { ReceiptPanel } from "@/components/asset-transfer/receipt/ReceiptPanel";
import { ChannelsPanel } from "@/components/asset-transfer/channels/ChannelsPanel";
import { FollowUpPanel } from "@/components/asset-transfer/follow-up/FollowUpPanel";
import { TransferFeeReview, TransferFeeReviewLoading } from "@/components/asset-transfer/follow-up/TransferFeeReview";
import { OutcomesPanel } from "@/components/asset-transfer/outcomes/OutcomesPanel";
import {
  FUNDING_STAGE_LABELS, fundingBarInstructions, fundingStageNumber, historyEvents, instructionSummary, isAcat, lastFour,
  mappingRows, notSubmittedText, outcomeDescription, outcomeSummary, outcomeTerminal, planApprovalLabel, relatedOpen,
  routeCopy, routeText, scopeLabel, sectionOpen, sectionStatus, submittedLabel, trackingDate, displayTime, workflowGuide,
  type DetailFacts, type OutcomeSummary, type RejectionState,
} from "./detail-model";
import type { TransferDetailWorkspaceData } from "./load-detail";
import { HashSectionOpener, OpenSectionButton, SectionLink } from "./SectionNav";
import { TaskPanel } from "./TaskPanel";
import { UpdateTransferDialog, type UpdateTransferProps } from "./UpdateTransferDialog";
import { EditRecordDialog } from "./EditRecordDialog";
import { ApprovePlanButton, EditPlanDialog, type PlanControlProps } from "./PlanControls";
import { ChangeFundingMethodDialog } from "./ChangeFundingMethodDialog";
import { recordedFundingMethod } from "@/lib/data/transfer-funding-method-change";
import {
  ClientRequestDialog, ReceivingAccounts, ResumeTransferButton, SyncFlagActions, TransferExceptions, type ExceptionCase,
} from "./DetailActions";
import { LinkedAcatStatus, StatusPill, type StatusPillInput } from "./LinkedAcatStatus";
import { linkedHoldingsAllowed } from "@/lib/data/transfer-linked-holdings";
import { TransferLinkedHoldingsLoading, TransferLinkedHoldingsSummary } from "@/components/asset-transfer/linked-holdings/TransferLinkedHoldings";
import { ListBackLink } from "@/components/navigation/ListBackLink";
import { AssetMapPicker, LinkedRecordsDialog } from "@/components/asset-transfer/connections/LinkedRecords";
import { canReviewAssetMapLinks } from "@/lib/data/asset-map-review-authz";
import { canReadCustodianLibrary } from "@/lib/data/custodian-library-contract";
import { assetMapTransferLinkEnabled } from "@/lib/flags";

export type DetailShellContext = { from: WorkspaceView; scope?: string };

function detailFacts(data: TransferDetailWorkspaceData, outcome: OutcomeSummary, rejection: RejectionState, historyCount: number): DetailFacts {
  const { transfer } = data.detail;
  const paperwork = data.paperwork;
  const accountMatchOk = paperwork != null && data.route != null && !accountMatchBlocks(
    true, data.route,
    paperwork.latestAccountMatch?.delivering_account_type ?? null,
    paperwork.latestAccountMatch?.receiving_account_type ?? null,
    paperworkTitlesComplete(paperwork.latestFormReview),
  );
  return {
    stage: transfer.stage,
    fundingType: transfer.funding_type,
    route: data.route,
    outcome: outcome.status,
    statementAccepted: paperwork?.latestStatement?.accepted === true,
    accountMatchOk,
    planApproved: transfer.funding_plan_approved_at != null && transfer.funding_plan_version > 0,
    sentPacket: paperwork?.sentPacketRecorded ?? false,
    returnedSignature: paperwork?.returnedSignatureRecorded ?? false,
    appAuthorization: paperwork?.appAuthorizationRecorded ?? false,
    submitted: data.receiptRecords?.latestSubmission != null || transfer.stage === "IN_TRANSFER",
    rejection,
    openFollowUpTasks: data.tasks.filter(task => task.section === "related-work" && task.status !== "Completed").length,
    historyCount,
  };
}

function activeRejection(data: TransferDetailWorkspaceData) {
  const latest = data.followUpRecords?.rejections[0] ?? null;
  if (!latest) return null;
  return latest.state !== "accepted" || data.followUpRecords?.resubmissionOpen ? latest : null;
}

/** The flag-on transfer detail, composed as a plain element tree so section mounts stay inspectable. */
function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function renderTransferDetailWorkspace(data: TransferDetailWorkspaceData, shell: DetailShellContext) {
  const { transfer, accounts } = data.detail;
  const { connections } = data;
  const clientName = connections.client.name;
  const householdName = connections.client.householdName;
  const isOps = canRecordOperationsOnlyTransferFact(data.role);
  const outcome = outcomeSummary(data.outcomeRecords?.outcomes);
  const terminal = outcomeTerminal(outcome.status);
  const rejection = activeRejection(data);
  const events = historyEvents({
    audit: data.history,
    stageChanges: data.outcomeRecords?.stageChanges ?? [],
    corrections: data.outcomeRecords?.corrections ?? [],
    outcomes: data.outcomeRecords?.outcomes ?? [],
  });
  const facts = detailFacts(data, outcome, rejection?.state ?? null, events.length);
  const guide = workflowGuide(facts);
  const stageNumber = fundingStageNumber(transfer.stage);
  const submission = data.receiptRecords?.latestSubmission ?? null;
  const tracking = data.receiptRecords?.latestTracking ?? null;
  const acat = isAcat(transfer.funding_type);
  const funded = transfer.stage === "FUNDED";

  const institution = connections.custodian?.name ?? (transfer.transferring_firm?.trim() || "Delivering firm not recorded");
  const sourceType = transfer.asset_map_account_type ?? transfer.source_account_type ?? data.paperwork?.latestAccountMatch?.delivering_account_type ?? "Account type not recorded";
  const sourceLast4 = lastFour(transfer.asset_map_account_number) ?? transfer.source_account_last4 ?? null;
  const receivingType = data.derivedReceiving?.registrationType ?? transfer.receiving_account_type ?? data.paperwork?.latestAccountMatch?.receiving_account_type ?? "Receiving account not confirmed";
  const receivingMasked = data.derivedReceiving?.apexAccountMasked ?? (data.derivedReceiving?.status === "TO_OPEN" ? "To open" : null);
  const route = routeText(transfer.funding_type, data.route);
  const contextDetail = `${institution}${sourceLast4 ? ` •••• ${sourceLast4}` : ""} → Apex`;
  const contextLine = `${clientName} · ${route}`;
  const contextTitle = `${clientName} · ${data.displayValue > 0 ? cash(data.displayValue) : "Value pending"}`;
  const panelContext = { title: contextTitle, detail: contextDetail };
  const mappedValue = data.holdings.reduce((sum, holding) => sum + (holding.marketValue ?? 0), 0);
  const approval = planApprovalLabel(facts);
  const scope = scopeLabel(transfer.funding_type);
  const planEditable = data.canWrite && data.canApprove && (transfer.stage === "DECISION" || data.legacyPlanReview);
  const planProps: PlanControlProps = {
    transferId: transfer.id,
    fundingType: transfer.funding_type,
    holdings: data.planHoldings,
    baseVersion: transfer.funding_plan_version,
    approvalMode: data.legacyPlanReview ? "LEGACY_IN_TRANSFER_REVIEW" : "PREPARATION",
    canEdit: planEditable,
    canApprove: planEditable,
    approved: facts.planApproved && !data.legacyPlanReview,
    submitted: submission != null || transfer.stage !== "DECISION",
    contextTitle,
    contextDetail,
    contextLine,
    authorizationAvailable: data.paperwork != null,
    appAuthorized: facts.appAuthorization,
  };

  const trackingAvailable = data.canChangeStage && outcome.status === "active";
  const outcomeAvailable = data.canWrite && !terminal && (submission == null || isOps);
  const updateProps: UpdateTransferProps = {
    transferId: transfer.id,
    contextTitle,
    contextDetail,
    referenceLine: submission ? `${clientName} · ${submission.controlNumber}` : contextLine,
    stage: transfer.stage,
    trackingAvailable,
    trackingFieldsAvailable: isOps && submission != null && transfer.stage === "IN_TRANSFER",
    outcomeAvailable,
    explanation: trackingAvailable ? null
      : funded ? "Funding is verified. Receipt corrections remain in Movement."
        : outcome.status !== "active" ? "Resume the deferred transfer before updating tracking."
          : "Your role can view this transfer's tracking.",
    isOps,
    submitted: submission != null,
    trackingStage: tracking?.trackingStage ?? null,
    expectedCompletionOn: tracking?.expectedCompletionOn ?? null,
  };

  const pillInput: StatusPillInput = { stage: transfer.stage, outcome: outcome.status, outcomeLabel: outcome.label, trackingStage: tracking?.trackingStage ?? null };
  const acatLinked = !data.isDrs && Boolean(transfer.acat_record_id || transfer.acat_transfer_id);
  const completedOn = funded ? trackingDate(transfer.stage_entered_at?.toISOString()) : "";
  const exceptionCases: ExceptionCase[] = data.decisionCases.map(item => ({
    id: item.id,
    question: item.question,
    open: item.status !== "RESOLVED",
    blocking: item.blocksTransfer,
    owner: DECISION_OWNER_LABEL[item.ownerTeam as keyof typeof DECISION_OWNER_LABEL] ?? item.ownerTeam,
    resolution: item.resolutionSummary,
    version: item.version,
  }));
  const openTasks = data.tasks.filter(task => task.status !== "Completed").length;
  const linkedHoldings = linkedHoldingsAllowed(data.role);
  const prerequisites = [
    facts.statementAccepted ? null : "Accept a current statement",
    facts.accountMatchOk ? null : "Confirm the account types and registered titles",
  ].filter((item): item is string => item != null);

  return (
    <WorkspaceShell label="Transfer">
      <HashSectionOpener />
      <div className="backline row between">
        {shell.from === "mailing" ? <ListBackLink scope={shell.scope ?? ""} detailHref={`/asset-transfer/${transfer.id}`}
          fallback={viewHref({ view: "mailing" })} className="btn quiet">← {WORKSPACE_PAGES.mailing}</ListBackLink> :
        <BtnLink quiet href={shell.from === "household" ? householdHref(transfer.household_sf_id ? `household:${transfer.household_sf_id}` : null) : viewHref({ view: shell.from })}>
          ← {shell.from === "household" && householdName ? householdName : WORKSPACE_PAGES[shell.from]}
        </BtnLink>}
        <WorkingAs role={data.role} />
      </div>
      <header className="detail-title"><div><div className="kicker">Asset transfer</div><h1>{clientName}</h1>
        {householdName ? <p className="small">{householdName}</p> : null}</div></header>

      <section className="transfer-identity" aria-label="Transfer account identity">
        <div className="transfer-identity-value">
          <span className="kicker">{facts.planApproved ? "Planned" : "Proposed"} transfer value</span>
          <strong>{data.displayValue > 0 ? cash(data.displayValue) : "Awaiting asset mapping"}</strong>
          {mappedValue > 0 && Math.abs(mappedValue - data.displayValue) > 0.005 ? <small>{cash(mappedValue)} source statement value</small> : null}
        </div>
        <div className="transfer-identity-account">
          <span className="kicker">From</span><strong>{institution}</strong>
          <span>{sourceType}{sourceLast4 ? <> <b>•••• {sourceLast4}</b></> : null}</span>
        </div>
        <span className="transfer-identity-arrow" aria-hidden="true">→</span>
        <div className="transfer-identity-account">
          <span className="kicker">To · Apex</span>
          <strong>{receivingType}{receivingMasked ? <> <b>{receivingMasked}</b></> : null}</strong>
        </div>
        <div className="transfer-identity-meta">
          <span className="transfer-deal-ref">{clientName} · Deal · {data.linkedDeal ? data.linkedDeal.sf_deal_id ?? data.linkedDeal.id : "Not linked"} · {transfer.id}</span>
          {acatLinked && transfer.acat_record_id ? (
            <DemoRecordLink href={otherDemoLinks.trackerRecord(transfer.acat_record_id)} demo="Transfer Tracker" />
          ) : null}
        </div>
        <div className="transfer-identity-plan" aria-label="Funding plan summary">
          <div className="transfer-plan-heading">
            <span className="kicker">{facts.planApproved ? "Current" : "Proposed"} funding plan</span>
            <span className={cx("transfer-plan-status", approval.attention && "needs-attention")}>Plan version {transfer.funding_plan_version} · {approval.text}</span>
            <SectionLink target="mapping" className="transfer-plan-link">View funding plan ↓</SectionLink>
          </div>
          <div className="transfer-plan-path"><strong>{route}</strong>{scope ? <span className="transfer-plan-scope">{scope}</span> : null}</div>
          <p className="transfer-plan-instructions">{fundingBarInstructions(transfer.funding_type, data.holdings)}</p>
        </div>
        <section className={cx("transfer-tracker", rejection && rejection.state !== "accepted" && "has-rejection")} id="transfer-progress" aria-labelledby="transfer-progress-title">
          <div className="row between tracker-heading">
            <div className="tracker-status-heading">
              <dl className="transfer-current-status">
                <dt>Current transfer status</dt>
                {acatLinked ? (
                  <Suspense fallback={<StatusPill input={pillInput} acatStatus={null} />}>
                    <LinkedAcatStatus acatRecordId={transfer.acat_record_id} acatTransferId={transfer.acat_transfer_id} input={pillInput} />
                  </Suspense>
                ) : <StatusPill input={pillInput} acatStatus={null} />}
              </dl>
              <h2 id="transfer-progress-title">Stage {stageNumber} of 3 · {FUNDING_STAGE_LABELS[stageNumber - 1]}</h2>
            </div>
            <div className="row" role="group" aria-label="Transfer actions">
              <EditRecordDialog transferId={transfer.id} values={transferToFormValues(transfer)} canEdit={data.canWrite}
                contextTitle={contextTitle} contextDetail={contextDetail} contextLine={contextLine} />
              <LinkedRecordsDialog transferId={transfer.id} canEdit={data.canWrite} client={connections.directoryClient}
                recordedClientName={`${transfer.client_first_name} ${transfer.client_last_name}`.trim()}
                dealReference={data.linkedDeal ? data.linkedDeal.sf_deal_id ?? data.linkedDeal.id : transfer.deal_id}
                custodian={connections.custodian} recordedFirm={transfer.transferring_firm}
                canChooseCustodian={canReadCustodianLibrary(data.role) && transfer.stage === "DECISION"}
                context={<FormTransferContext title={contextTitle} detail={contextDetail} />} />
              {terminal ? null : <UpdateTransferDialog {...updateProps} />}
            </div>
          </div>
          <ol className="transfer-stages" aria-label="Funding lifecycle stages" data-funding-stage={transfer.stage}>
            {FUNDING_STAGE_LABELS.map((label, index) => (
              <li key={label} className={index + 1 < stageNumber ? "done" : index + 1 === stageNumber ? "current" : undefined}
                aria-current={index + 1 === stageNumber ? "step" : undefined}>
                <span className="milestone-number" aria-hidden="true">{index + 1 < stageNumber ? "✓" : index + 1}</span><span>{label}</span>
              </li>
            ))}
          </ol>
          <dl className="tracking-facts transfer-key-dates" aria-label="Key transfer dates">
            <div><dt>Client requested</dt><dd>{transfer.client_requested_on ? trackingDate(isoDay(transfer.client_requested_on)) : "Not recorded"}
              {transfer.client_requested_on && transfer.client_request_source ? <small>{transfer.client_request_source}</small> : <small>Original request date not captured.</small>}
              {data.canRecordClientService ? (
                <ClientRequestDialog transferId={transfer.id} requestedOn={transfer.client_requested_on ? isoDay(transfer.client_requested_on) : null}
                  source={transfer.client_request_source ?? null} context={<FormTransferContext title={contextTitle} detail={contextDetail} />} />
              ) : null}
            </dd></div>
            <div><dt>{submittedLabel(transfer.funding_type, rejection != null)}</dt><dd>{submission ? trackingDate(submission.submittedOn) : notSubmittedText(transfer.funding_type)}</dd></div>
            <div><dt>{acat ? "Actual completion" : "Assets received"}</dt><dd>{completedOn || "Pending"}
              {!funded && tracking?.expectedCompletionOn ? <small><span>Expected completion</span> · {trackingDate(tracking.expectedCompletionOn)} · Estimated</small> : null}
            </dd></div>
          </dl>
          {transfer.stage !== "DECISION" && transfer.funding_type !== "ACH" ? (
            <dl className="tracking-summary" aria-label="Transfer tracking reference">
              <div><dt>{rejection || acat ? "Control number" : "Submission reference"}</dt><dd>{submission?.controlNumber ?? "Not recorded"}</dd></div>
            </dl>
          ) : null}
        </section>
      </section>

      {outcome.status !== "active" ? (
        <section className={`lifecycle-banner ${outcome.status}`} aria-label="Transfer outcome">
          <div className="row between"><strong>{outcome.label}</strong></div>
          <p>{outcomeDescription(outcome.status)}</p>
          {outcome.reason ? <p><b>Reason:</b> {outcome.reason}</p> : null}
          {outcome.followUpOn ? <p><b>Follow up:</b> {trackingDate(outcome.followUpOn)}</p> : null}
          {outcome.outcomeOn ? <p><b>Outcome date:</b> {trackingDate(outcome.outcomeOn)}</p> : null}
          {outcome.recordedAt ? <small>Recorded outcome · {displayTime(outcome.recordedAt)}</small> : null}
          <div className="row">
            {outcome.status === "deferred"
              ? <ResumeTransferButton transferId={transfer.id} disabled={!data.canWrite || (submission != null && !isOps)}
                  title={submission != null && !isOps ? "Operations resumes a submitted transfer" : undefined} />
              : <BtnLink tiny href="/asset-transfer/new">Start a new transfer</BtnLink>}
            <SectionLink target="history" className="btn quiet tiny">View history ↓</SectionLink>
          </div>
          {outcome.previous.length ? (
            <details><summary>Previous transfer outcomes ({outcome.previous.length})</summary>
              {outcome.previous.map(entry => <p key={entry.recordedAt}>{entry.outcome}{entry.reason ? ` · ${entry.reason}` : ""} · {displayTime(entry.recordedAt)}{entry.resumed ? " · resumed" : ""}</p>)}
            </details>
          ) : null}
        </section>
      ) : null}

      {data.archived ? (
        <div className="notice" role="note"><strong>Removed from the board · read-only</strong><p>{data.archivedReason ?? "This transfer was removed from the board."} Its records remain available.</p></div>
      ) : null}
      {data.syncFlagNote ? (
        <div className="notice" role="alert"><strong>Needs review · {data.syncFlagNote}</strong>
          <p>Keep this transfer and dismiss the flag, or remove it from the board.</p>
          {data.canWrite ? <SyncFlagActions transferId={transfer.id} archiveEnabled={data.archiveEnabled} /> : null}
        </div>
      ) : null}

      {rejection ? (
        <div className={cx("rejection-panel", rejection.state === "accepted" && "resolved")} role="note" aria-label="ACAT rejection">
          <div className="row between">
            <strong>{rejection.state === "accepted" ? "Rejection resolved · prepare resubmission" : rejection.state === "awaiting_review" ? "ACAT rejected · response ready for Ops" : "ACAT rejected · follow-up needed"}</strong>
            <Badge tone={rejection.state === "accepted" ? "completed" : "blocked"}>{rejection.state === "accepted" ? "Resolved" : rejection.state === "awaiting_review" ? "Ops approval needed" : rejection.followUpOwner}</Badge>
          </div>
          {rejection.reason ? <p><b>Reason{rejection.code ? ` · ${rejection.code}` : ""}:</b> {rejection.reason}</p> : null}
          <p><b>Next step · {rejection.followUpOwner}:</b> Record the follow-up response in Follow-up & history.</p>
          <small>Rejected {rejection.rejectedOn ? trackingDate(rejection.rejectedOn) : displayTime(rejection.recordedAt)}{submission ? ` · Control number ${submission.controlNumber}` : ""}</small>
          {rejection.response ? <p><b>Response:</b> {rejection.response}</p> : null}
          <div className="row" style={{ marginTop: 12 }}>
            <SectionLink target="followups" className="btn">{rejection.state === "awaiting_review" ? "Review rejection resolution" : "Record follow-up response"}</SectionLink>
            <SectionLink target="intake" className="btn quiet tiny">Review / correct transfer details ↓</SectionLink>
          </div>
          <p className="small">{rejection.state === "accepted" ? "The normal statement, account, mapping, authorization, and Ops review checks still apply." : "Update any affected statement, account details, funding plan, or paperwork below. Independent work can continue."}</p>
        </div>
      ) : null}

      <div className="workflow-guide">
        <div><div className="kicker">Next step</div><strong>{guide.title}</strong><p>{guide.text}</p></div>
        <div className="row">
          <OpenSectionButton primary target={guide.id}>Open current step ↓</OpenSectionButton>
          {guide.id === "paperwork" && transfer.funding_type && !facts.planApproved ? <OpenSectionButton target="mapping">Open funding plan approval</OpenSectionButton> : null}
        </div>
      </div>

      <div className="linksbar">
        <SectionLink target="intake">Statement & accounts</SectionLink>
        <SectionLink target="mapping">Asset mapping & plan</SectionLink>
        <SectionLink target="paperwork">Movement</SectionLink>
        <SectionLink target="related-work">Follow-up & history</SectionLink>
      </div>

      {funded ? (
        <div className="notice success"><strong>Funding complete · {cash(data.displayValue)} verified as received</strong>
          <p>{openTasks} internal or follow-up {openTasks === 1 ? "task remains" : "tasks remain"}. Funding completion does not close these tasks.</p></div>
      ) : outcome.status === "active" && transfer.stage === "DECISION" && prerequisites.length > 1 ? (
        <div className="notice"><strong>Resolve prerequisites before preparing this movement</strong><p>{prerequisites.join(" · ")}</p></div>
      ) : null}

      <div className="detailgrid">
        <div>
          <WorkflowSection id="intake" kicker="01 · Source evidence" title="Statement & account checks"
            description="Use the statement and actual account registration to establish the working facts."
            status={sectionStatus(facts, "intake")} open={sectionOpen(guide, "intake")}>
            <div className="sectionbody">
              <div className="workflow-source row"><span className="source-label">FeeStore intake + Asset Transfer</span></div>
              {linkedHoldings ? (
                <Suspense fallback={<TransferLinkedHoldingsLoading />}>
                  <TransferLinkedHoldingsSummary identity={data.identity} transfer={transfer} contextTitle={contextTitle} contextDetail={contextDetail} />
                </Suspense>
              ) : null}
              <div className="twocol">
                <div className="account"><div className="kicker">Delivering account</div><strong>{institution}</strong>
                  <p>{sourceType}{sourceLast4 ? ` •••• ${sourceLast4}` : ""}</p></div>
                <div className="account"><div className="kicker">Receiving account · Apex</div><strong>{receivingType}</strong>
                  <p>{data.derivedReceiving ? (data.derivedReceiving.status === "OPEN" ? `Open · ${data.derivedReceiving.apexAccountMasked ?? "number masked"}` : "To open at Apex") : "Matched from the recorded account-type check"}</p></div>
              </div>
              {assetMapTransferLinkEnabled() ? (
                <AssetMapPicker transferId={transfer.id}
                  canLink={data.canWrite && canReviewAssetMapLinks(data.role) && transfer.stage === "DECISION"}
                  hrqjSbevsbySbin8={data.linkedDeal?.account_last4 ?? transfer.source_account_last4 ?? null}
                  current={transfer.asset_map_custodian ? {
                    custodian: transfer.asset_map_custodian,
                    accountNumberMasked: sourceLast4 && transfer.asset_map_account_number ? `••••${sourceLast4}` : null,
                    accountType: transfer.asset_map_account_type,
                  } : null}
                  context={<FormTransferContext title={contextTitle} detail={contextDetail} />} />
              ) : null}
              <StatementAccountSection identity={data.identity} transfer={transfer} accounts={accounts} canRecord={data.canRecordClientService} bare transferContext={panelContext} />
              <ReceivingAccounts transferId={transfer.id} accounts={accounts} canWrite={data.canWrite} reconciled={connections.receiving} />
            </div>
          </WorkflowSection>

          <WorkflowSection id="mapping" kicker="02 · What moves and how" title="Asset mapping & funding plan"
            description="Bring the existing mapped positions and movement instructions into this record."
            status={sectionStatus(facts, "mapping")} open={sectionOpen(guide, "mapping")}>
            <div className="sectionbody">
              <div className="workflow-source row">
                <div className="row" role="group" aria-label="Funding plan actions"><EditPlanDialog {...planProps} />
                  {data.canWrite && data.canApprove && !planEditable ? <ChangeFundingMethodDialog transferId={transfer.id} stage={transfer.stage}
                    fundingType={recordedFundingMethod(transfer)} planVersion={transfer.funding_plan_version}
                    methodRevision={transfer.funding_method_revision ?? 0} hasAcatLink={Boolean(transfer.acat_record_id || transfer.acat_transfer_id)}
                    contextTitle={contextTitle} contextDetail={contextDetail} /> : null}</div>
              </div>
              <div className="row between"><span className="small">{data.holdings.length
                ? <>Statement value <strong>{cash(mappedValue)}</strong> · Selected to move <strong>{cash(data.displayValue)}</strong></>
                : "Awaiting asset mapping · no source balance assumed"}</span></div>
              <div className="tablewrap">
                <table>
                  <thead><tr><th>Asset / quantity</th><th>Mapping finding</th><th>Movement / quantity</th><th className="money">Statement value</th></tr></thead>
                  <tbody>
                    {mappingRows(transfer.funding_type, data.holdings).map(row => (
                      <tr key={row.symbol}>
                        <td><strong>{row.symbol}</strong><small>{row.description}</small></td>
                        <td>{row.finding}{row.findingNote ? <small>{row.findingNote}</small> : null}</td>
                        <td><strong className="mapped-movement-quantity">{row.movement}</strong>
                          <Badge tone={row.included ? "progress" : "neutral"}>{row.included ? "Included" : "Left behind"}</Badge><small>{row.instruction}</small></td>
                        <td className="money">{cash(row.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="route">
                <div className="kicker">{facts.planApproved ? "Current" : "Proposed"} funding plan · version {transfer.funding_plan_version}</div>
                <strong>{route}</strong>
                <p>{instructionSummary(transfer.funding_type, data.holdings)}</p>
                <details><summary>Workflow requirements</summary><p>{routeCopy(transfer.funding_type)}</p></details>
              </div>
              <div className="row between">
                <div>
                  {facts.planApproved && !data.legacyPlanReview
                    ? <Badge tone="completed">{`Funding plan approved · version ${transfer.funding_plan_version}`}</Badge>
                    : <Badge tone="waiting">Funding plan approval needed</Badge>}
                  <p className="small" style={{ marginTop: 8 }}>Approval covers the current statement, account checks, mapping, and funding plan.</p>
                </div>
                <ApprovePlanButton {...planProps} />
              </div>
              {!isOps && !facts.planApproved ? <p className="small" style={{ marginTop: 10 }}>Ops approves the funding plan first; CS can then generate the paperwork.</p> : null}
              {data.fundingMethodHistory.length ? (
                <details className="plan-history"><summary>Previous funding plans ({data.fundingMethodHistory.length})</summary>
                  {data.fundingMethodHistory.map(entry => (
                    <article className="subtle" key={entry.id}>
                      <strong>Version {entry.basePlanVersion} · {entry.previousFundingType ? FUNDING_TYPE_LABEL[entry.previousFundingType] : "No method"} → {entry.fundingType ? FUNDING_TYPE_LABEL[entry.fundingType] : "No method"}</strong>
                      <p>{entry.reason}</p>
                      <p>{entry.changedBy} · {displayTime(entry.changedAt)}</p>
                    </article>
                  ))}
                </details>
              ) : null}
              <details><summary>Applicable custodian requirements</summary><p>{routeCopy(transfer.funding_type)}</p></details>
            </div>
          </WorkflowSection>

          <WorkflowSection id="paperwork" kicker="03 · Movement" title="Movement"
            status={sectionStatus(facts, "paperwork")} open={sectionOpen(guide, "paperwork")}>
            <div className="sectionbody">
              <div className="workflow-source row"><span className="source-label">Funding plan + movement records</span></div>
              {data.paperworkProps ? <ReviewDownload {...data.paperworkProps} bare transferContext={panelContext} /> : (
                <div className="subtle"><strong>{transfer.funding_type ? "Movement records are not available" : "Choose the funding method first"}</strong>
                  <p>{transfer.funding_type ? "Paperwork and submission steps appear here once movement records are enabled." : "The funding method in the funding plan decides which paperwork and submission steps apply."}</p></div>
              )}
              {data.isDrs ? (
                <div className="subtle"><strong>DRS service request</strong>
                  <p>{data.drsTasks.filter(task => task.status === "DONE").length} of {data.drsTasks.length} DRS steps complete. Work each step from Tasks.</p></div>
              ) : null}
              {data.channelKind && data.channelRecords ? (
                <ChannelsPanel transferId={transfer.id} kind={data.channelKind} canRecord={data.canRecordClientService} records={data.channelRecords} bare transferContext={panelContext} />
              ) : null}
              <MailingSection identity={data.identity} transferId={transfer.id} canRecord={data.canRecordClientService} bare transferContext={panelContext} />
              {data.receiptProps ? <ReceiptPanel {...data.receiptProps} trackerControlNumber={connections.trackerControlNumber} bare transferContext={panelContext} /> : null}
            </div>
          </WorkflowSection>

          <details className="section related-work related-checklist" id="related-work" data-workflow-section="related-work" open={relatedOpen(guide)}>
            <summary className="sectionhead"><div><h2>Follow-up & history</h2></div></summary>
            <div className="related-work-body">
              <div id="followups" data-workflow-section="followups" className="followup-checklist">
                {data.followUpRecords ? (
                  <FollowUpPanel transferId={transfer.id} isAcat={data.receiptFundingType != null}
                    canRecordOperations={data.canRecordOperations} canRespond={data.canRecordClientService} records={data.followUpRecords} bare transferContext={panelContext}
                    feeReview={<Suspense fallback={<TransferFeeReviewLoading />}><TransferFeeReview identity={data.identity} transfer={transfer} legacyEntries={data.followUpRecords.feeReimbursements} /></Suspense>}
                    feeRequests={connections.feeRequests} tradeRequests={connections.tradeRequests} />
                ) : null}
                {data.slackCloseout ? (
                  <FollowupCheck title="Slack closeout" tone={data.slackCloseout.done >= data.slackCloseout.total ? "completed" : "waiting"}
                    status={`${data.slackCloseout.done}/${data.slackCloseout.total} complete`}>
                    {data.slackCloseout.status} · completed in the Slack closeout thread.
                  </FollowupCheck>
                ) : null}
                <TransferExceptions transferId={transfer.id} cases={exceptionCases} canWrite={data.canWrite} />
              </div>
              <WorkflowSection id="history" title="Activity" related status={sectionStatus(facts, "history")} open={false}
                description="The audit log for this transfer only: who recorded what, and when.">

                <div className="sectionbody">
                  {data.outcomeRecords ? <OutcomesPanel transferId={transfer.id} canRecord={data.canWrite} records={data.outcomeRecords} bare transferContext={panelContext} /> : null}
                  {events.length ? (
                    <ol className="timeline">
                      {events.map(event => <li key={event.key}><small>{displayTime(event.at)} · {event.actor}</small><p>{event.text}</p></li>)}
                    </ol>
                  ) : <p className="small">No recorded events yet.</p>}
                </div>
              </WorkflowSection>
              <MailingHistoryPanel identity={data.identity} transferId={transfer.id} />
            </div>
          </details>
        </div>
        <aside className="aside">
          <TaskPanel transferId={transfer.id} tasks={data.tasks} contextLine={contextLine} canWrite={data.canWrite} role={data.role}
            stage={transfer.stage} methodChangePending={transfer.drs_method_change_pending ?? false} paused={data.outcomeRecords?.paused ?? false}
            today={easternToday()} roster={connections.roster.length ? connections.roster : undefined} />
        </aside>
      </div>
    </WorkspaceShell>
  );
}

function FollowupCheck({ title, tone, status, children }: { title: string; tone: "completed" | "waiting"; status: string; children: ReactNode }) {
  return (
    <article className="followup-check">
      <div className="followup-check-copy">
        <div className="followup-check-heading"><strong>{title}</strong><Badge tone={tone}>{status}</Badge></div>
        <p>{children}</p>
      </div>
    </article>
  );
}
