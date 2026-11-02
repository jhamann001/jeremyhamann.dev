import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getTransfer } from "@/lib/data/transfer-detail";
import { getFundingMethodCorrections } from "../funding-method-actions";
import { recordedFundingMethod } from "@/lib/data/transfer-funding-method-change";
import { listDecisionCasesForTransfer } from "@/lib/data/decision-cases";
import { getCedarRidgeUserIdForLinkedReads } from "@/lib/data/clients";
import {
  canApproveFundingPlan,
  canRecordClientServiceTransferFact,
  canRecordOperationsOnlyTransferFact,
  canWriteTransfers,
} from "@/lib/data/transfer-write";
import { canSeeUnlinkedAcats } from "@/lib/data/acat-lane";
import { gateStatus, type GateStatus } from "@/lib/data/transfer-basis";
import { DRS_TASKS, drsTasksForStage, drsWorkflowGate } from "@/lib/data/drs-workflow";
import { getDrsWorkflowTasks } from "@/lib/data/drs-workflow-store";
import { daysInStage } from "@/lib/data/transfer-stage";
import {
  stageLabel,
  visibleTasks,
  stageChecklistTasks,
  resolveTaskDone,
  resolveTransferValue,
  STAGE_ORDER,
} from "@/lib/data/transfer-types";
import { getTransferContext } from "@/lib/data/transfer-context";
import { dealsForHousehold, getDeal } from "@/lib/data/deals";
import {
  getAssignedAssetMapDetail,
  getPartialAcatPositions,
} from "@/lib/data/transfer-asset-map";
import { getDerivedReceivingAccount } from "@/lib/data/receiving-account-match";
import {
  assetMapTransferLinkEnabled,
  assetTransferWorkspaceEnabled,
  paperworkRecordsEnabled,
  checklistStageGateEnabled,
  initialFundingCheckEnabled,
  slackCloseoutEnabled,
  transferArchiveActionEnabled,
} from "@/lib/flags";
import { archivedReasonLabel, syncFlagLabel } from "@/lib/data/transfer-archive";
import { getSlackCloseout } from "@/lib/data/transfers";
import { usd } from "@/lib/format";
import { Card, CardBody, CardHeader, Pill } from "@/components/ui";
import { GateStepper } from "@/components/transfers/GateStepper";
import { TransferToolbar } from "@/components/transfers/TransferToolbar";
import { TransferChecklist } from "@/components/transfers/TransferChecklist";
import { StageChecklistCard } from "@/components/transfers/StageChecklistCard";
import { ReceivingAccountsCard } from "@/components/transfers/ReceivingAccountsCard";
import { InitialFundingCoverage } from "@/components/transfers/InitialFundingCoverage";
import { DecisionChecklistCard } from "@/components/transfers/DecisionChecklistCard";
import { DrsWorkflowCard } from "@/components/transfers/DrsWorkflowCard";
import { TransferPlanDraftProvider } from "@/components/transfers/TransferPlanDraftProvider";
import { TransferPlanPositionsCard } from "@/components/transfers/TransferPlanPositionsCard";
import { InstructionList } from "@/components/asset-transfer/mapping/InstructionList";
import type { EligibilityHolding } from "@/lib/transfers/holding-eligibility";
import { TransferPlanApprovalFooter } from "@/components/transfers/TransferPlanApprovalFooter";
import { SlackCloseoutCard } from "@/components/transfers/SlackCloseoutCard";
import { AcatLinkCta } from "@/components/transfers/AcatLinkCta";
import { TransferArchiveButton } from "@/components/transfers/TransferArchiveButton";
import { SyncFlagDismissButton } from "@/components/transfers/SyncFlagDismissButton";
import { TemperatureCard } from "@/components/transfers/TemperatureCard";
import { FundingPictureCard } from "@/components/transfers/FundingPictureCard";
import { BackToBoardLink } from "@/components/transfers/BackToBoardLink";
import { LinkedDecisionCases } from "@/components/transfers/LinkedDecisionCases";
import { TransferDetailSection } from "@/components/transfers/TransferDetailSection";
import { TransferOverviewSummary } from "@/components/transfers/TransferOverviewSummary";
import { FundingMethodChange, FundingMethodHistory, FundingMethodInitiation } from "@/components/transfers/FundingMethodChange";
import { AcatStatusSection } from "@/components/transfers/AcatStatusSection";
import { CrmIdField } from "@/components/crm";
import { StatementAccountSection } from "@/components/asset-transfer/intake/StatementAccountSection";
import { ReviewDownload, type ReviewDownloadProps } from "@/components/asset-transfer/paperwork/ReviewDownload";
import { getPaperworkRecords, paperworkTitlesComplete } from "@/lib/data/transfer-paperwork-store";
import { apexAccountsForClient } from "@/lib/data/account-aum";
import { manualRouteForms, routeLabel } from "@/lib/transfers/route-label";
import { accountMatchBlocks, statementBlocks } from "@/lib/transfers/intake-gates";
import { MailingSection } from "@/components/asset-transfer/mailing/MailingSection";
import { ReceiptPanel, type ReceiptPanelProps } from "@/components/asset-transfer/receipt/ReceiptPanel";
import { getReceiptRecords, submissionBlockers } from "@/lib/transfers/receipt";
import { ChannelsPanel, type ChannelKind } from "@/components/asset-transfer/channels/ChannelsPanel";
import { getChannelRecords } from "@/lib/transfers/channels";
import { FollowUpPanel } from "@/components/asset-transfer/follow-up/FollowUpPanel";
import { getFollowUpRecords } from "@/lib/transfers/follow-up";
import { OutcomesPanel } from "@/components/asset-transfer/outcomes/OutcomesPanel";
import { getOutcomeRecords } from "@/lib/transfers/outcomes";
import { crmIdentityIdForSource, crmRouteSource } from "@/lib/crm/resolve";
import { canViewCrmId } from "@/lib/crm/visibility";
import { loadTransferDetailWorkspace } from "@/components/asset-transfer/detail/load-detail";
import { parseFromView } from "@/components/asset-transfer/detail/detail-model";
import { renderTransferDetailWorkspace } from "@/components/asset-transfer/detail/TransferDetailWorkspace";
import styles from "./page.module.css";

// /asset-transfer/[id] — the transfer record detail, the domain's write
// surface (WO ticket, TDD §6). Detail is a ROUTE, not an overlay (locked
// decision 5). RLS-scoped `getTransfer` (see lib/data/transfer-detail.ts —
// the declared T3 seam file, zero overlap with T2's transfers.ts); unknown
// id → notFound. VIEWER gets zero write affordances; the DB policies police
// the actions regardless (ADR-4).

export default async function TransferDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/");

  const role = (session.user as { role?: string }).role ?? "VIEWER";
  const identity = { role, email: session.user.email ?? null };
  const canWriteRole = canWriteTransfers(role);

  const { id } = await params;
  const detail = await getTransfer(identity, id);
  if (!detail) notFound();
  if (assetTransferWorkspaceEnabled()) {
    const query = searchParams ? await searchParams : {};
    const workspace = await loadTransferDetailWorkspace(identity, role, detail);
    return renderTransferDetailWorkspace(workspace, { from: parseFromView(query.from), scope: session.navigationScope ?? "" });
  }
  const { transfer, tasks, decisions, accounts } = detail;
  const fundingMethodHistory = canApproveFundingPlan(role)
    ? await getFundingMethodCorrections(transfer.id) : [];
  const isDrs = transfer.funding_type === "DRS";
  const drsTasks = isDrs ? await getDrsWorkflowTasks(identity, transfer.id) : [];
  const linkedDecisionCases = await listDecisionCasesForTransfer(identity, transfer.id);
  const openExceptions = linkedDecisionCases.filter((item) => item.status !== "RESOLVED");
  const blockingExceptions = openExceptions.filter((item) => item.blocksTransfer).length;
  const crmId = canViewCrmId(role)
    ? await crmIdentityIdForSource(
        identity,
        "TRANSFER",
        crmRouteSource("TRANSFER"),
        transfer.id,
      )
    : null;

  // Archived (soft-deleted) transfers still LOAD — deep links, ACAT "View
  // transfer →", audit trails — but are READ-ONLY: every write affordance on
  // this page keys off `canWrite`, so folding `!archived` into it kills the
  // toolbar controls, task toggles, decision/account/position writes, the edit
  // link, and the ACAT-link CTA in one place (the deals D7 detail posture).
  // The DB would reject writes to a vanished-from-board record anyway; this
  // keeps the UI honest.
  const archived = transfer.archived_at != null;
  const canWrite = canWriteRole && !archived;
  const canLinkAcat = !isDrs && canSeeUnlinkedAcats(role) && !archived &&
    transfer.stage !== "FUNDED" && !(transfer.acat_record_id || transfer.acat_transfer_id);
  const archivedReason = archivedReasonLabel(
    transfer.archived_reason,
    transfer.archived_by,
  );

  // Needs-review banner (transfer-syncflag-surface): the reconciler's sync_flag
  // (uncommitted_review / orphan_review) surfaces as a warning banner with the
  // two resolutions the flag+manual-button design intends — archive, or dismiss
  // and keep. The ARCHIVED banner wins: an archived transfer is already off the
  // board, so its (now moot) review flag is not stacked on top.
  const syncFlagNote = archived ? null : syncFlagLabel(transfer.sync_flag);

  // The DECISION checklist is trimmed (owner 2026-07-20) and the decision-
  // worksheet items show only for a partial ACAT — done at render (append-only
  // ADR-3: rows are hidden, never deleted). Filter ONCE and feed the same list
  // to the stepper, the done-count, and the checklist so all three agree.
  // CHECKLIST_STAGE_GATE: render the checklist in the readiness-card UI, hide the
  // standalone Decision Readiness card, and gate stage advance on checklist
  // completion. When ON, the checklist is SCOPED TO THE CURRENT STAGE
  // (stageChecklistTasks) — a transfer accumulates earlier-stage tasks, and only
  // the current stage's own tasks should show/gate. When OFF, today's
  // visibleTasks (DECISION trim only).
  const checklistGate = checklistStageGateEnabled();
  const shownTasks = checklistGate
    ? stageChecklistTasks(transfer.stage, tasks, transfer.funding_type)
    : visibleTasks(transfer.stage, tasks, transfer.funding_type);
  const days = daysInStage(transfer.stage_entered_at);

  // Slack closeout status (SLACK_TRANSFER_CLOSEOUT) — null when the flag is off
  // or the transfer never reached IN_TRANSFER (no closeout seeded). Read-only mirror
  // of what ops complete in Slack; the checklist itself lives there, not here.
  const slackCloseout = !isDrs && slackCloseoutEnabled()
    ? await getSlackCloseout(identity, id)
    : null;

  // T4 composition inputs (ticket): temperature through the Phase E mock
  // seam (ADR-10 — null hides the card); the REAL deals rollup through the
  // RLS-scoped additive seam when the transfer carries a household (ADR-9 —
  // null renders the funding card's no-household empty state).
  const context = getTransferContext(transfer.client_sf_id);
  const deals = transfer.household_sf_id
    ? await dealsForHousehold(identity, transfer.household_sf_id)
    : null;
  // Slice 5: the LINKED deal (by deal_id) drives the funding picture's Deal row,
  // else the household rollup falls back. REUSE getDeal (RLS-scoped, coerces the
  // Decimal amount) — no new read seam. A DB read like dealsForHousehold above;
  // the SLOW tracker call (asset map) is deferred separately, below.
  const linkedDeal = transfer.deal_id
    ? await getDeal(identity, transfer.deal_id)
    : null;
  // deal-card mirror S2: resolve the synced tasks' done from the linked deal
  // (override_done ?? deal flag ?? own done) so the checklist, the done-count,
  // and the gate stepper all show the SAME state the board card counts. Done
  // AFTER linkedDeal is fetched (it supplies the mirrored flags).
  const dealFlags = linkedDeal
    ? { statements: linkedDeal.statements, asset_mapped: linkedDeal.asset_mapped }
    : null;
  // The card's headline Value follows the linked deal's amount LIVE (deal owns
  // the amount — see resolveTransferValue). A deal-amount edit shows here on the
  // next load without the transfer-sync cron; no linked deal → the stored value.
  const displayValue = resolveTransferValue(transfer.value, linkedDeal?.amount ?? null);
  const resolvedTasks = shownTasks.map((t) => ({
    ...t,
    done: resolveTaskDone(t, dealFlags),
  }));
  let gates = gateStatus({
    stage: transfer.stage,
    tasks: resolvedTasks,
    decisions,
    accounts,
  });
  if (isDrs) {
    const inputs = {
      fundingPlanComplete: transfer.funding_plan_complete,
      fundingPlanVersion: transfer.funding_plan_version,
      tasks: drsTasks,
      blockingExceptions,
      archived,
      methodChangePending: transfer.drs_method_change_pending ?? false,
    };
    const preparation = drsWorkflowGate({ ...inputs, from: "DECISION", to: "IN_TRANSFER" });
    const inTransfer = drsWorkflowGate({ ...inputs, from: "IN_TRANSFER", to: "FUNDED" });
    const currentIndex = STAGE_ORDER.indexOf(transfer.stage);
    gates = STAGE_ORDER.map((stage, index): GateStatus => {
      const requirements = stage === "DECISION" ? preparation : inTransfer;
      const unmet = requirements.unmet;
      const complete = stage === "DECISION"
        ? "DRS plan approved, Client Service documents and account confirmed, Operations instructions approved and request submitted to Apex"
        : "Apex confirmed the assets moved; no blocking exceptions";
      return {
        stage, label: stageLabel(stage),
        state: index < currentIndex ? "done" : index === currentIndex ? "now" : "todo",
        satisfied: unmet.length === 0,
        gate: unmet.length ? unmet.join("; ") : complete,
      };
    });
  }
  const doneCount = resolvedTasks.filter((t) => t.done).length;
  // Assigned-map detail for the hub's Mapping-account expansion (#186 triple;
  // flag-gated). A LOCAL indexed Postgres read — same awaited-in-shell class as
  // dealsForHousehold above; only the EXTERNAL tracker call is deferred (PR #133).
  const assignedMapDetail =
    assetMapTransferLinkEnabled() &&
    transfer.asset_map_folder_id &&
    transfer.asset_map_custodian
      ? await getAssignedAssetMapDetail(identity, {
          folderId: transfer.asset_map_folder_id,
          custodian: transfer.asset_map_custodian,
          accountNumber: transfer.asset_map_account_number,
          accountType: transfer.asset_map_account_type,
        })
      : null;
  // Load the linked account's positions while Operations is drafting in DECISION
  // as well as after a partial ACAT is approved. That lets changing Full →
  // Partial reveal the real asset-map choices immediately without persisting the
  // funding-type click first.
  const legacyPlanReview = transfer.stage === "IN_TRANSFER" &&
    transfer.funding_plan_version === 0 && transfer.funding_type !== "DRS" && !transfer.archived_at;
  const partialPositions =
    (transfer.stage === "DECISION" ||
      transfer.funding_type === "ACAT_PARTIAL") &&
    assetMapTransferLinkEnabled() &&
    transfer.asset_map_folder_id &&
    transfer.asset_map_custodian
      ? await getPartialAcatPositions(identity, {
          transferId: transfer.id,
          folderId: transfer.asset_map_folder_id,
          custodian: transfer.asset_map_custodian,
          accountNumber: transfer.asset_map_account_number,
          accountType: transfer.asset_map_account_type,
        })
      : null;
  const workspaceEnabled = assetTransferWorkspaceEnabled();
  const paperwork = workspaceEnabled && paperworkRecordsEnabled()
    ? await getPaperworkRecords(identity, transfer.id)
    : null;
  const route = paperwork && transfer.funding_type
    ? routeLabel(transfer.funding_type, paperwork.appAuthorizationRecorded)
    : null;
  let paperworkProps: ReviewDownloadProps | null = null;
  if (paperwork && route) {
    const intakeBlocked = statementBlocks(workspaceEnabled, paperwork.latestStatement) ||
      accountMatchBlocks(
        workspaceEnabled,
        route,
        paperwork.latestAccountMatch?.delivering_account_type ?? null,
        paperwork.latestAccountMatch?.receiving_account_type ?? null,
        paperworkTitlesComplete(paperwork.latestFormReview),
      );
    const canGenerate = transfer.funding_plan_approved_at != null && !intakeBlocked && !archived;
    const apexRows = transfer.client_sf_id ? await apexAccountsForClient(identity, transfer.client_sf_id) : [];
    paperworkProps = {
      transferId: transfer.id,
      route,
      clientId: transfer.client_sf_id,
      accounts: apexRows
        .filter((account) => account.custodianAccountId?.trim() && account.apexAccountNumber?.trim())
        .map((account) => ({
          accountId: account.custodianAccountId,
          maskedAccountNumber: `••••${(account.apexAccountNumber as string).replace(/\W/g, "").slice(-4)}`,
          accountType: account.accountType || "Account type unavailable",
          status: account.accountStatus || "",
        })),
      latestFormReview: paperwork.latestFormReview,
      canGenerate,
      canDownload: canGenerate && paperwork.latestFormReview?.reviewed === true,
      canRecord: canWrite && canRecordClientServiceTransferFact(role),
      manualForms: route === "Manual · custodian-library process" ? manualRouteForms(transfer.transferring_firm) : [],
      records: {
        sentPacketRecorded: paperwork.sentPacketRecorded,
        returnedSignatureRecorded: paperwork.returnedSignatureRecorded,
        mailedPaperworkRecorded: paperwork.mailedPaperworkRecorded,
      },
      drsTicket: route === "DRS · Apex service request"
        ? {
            clientName: `${transfer.client_first_name} ${transfer.client_last_name}`,
            transferringFirm: transfer.transferring_firm,
            fundingPlanVersion: transfer.funding_plan_version,
            sourceAccountSuffix: (transfer.asset_map_account_number ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(-4) || "account",
            returnedSignatureRecorded: paperwork.returnedSignatureRecorded,
          }
        : null,
    };
  }
  const receiptFundingType = transfer.funding_type === "ACAT_FULL" || transfer.funding_type === "ACAT_PARTIAL"
    ? transfer.funding_type
    : null;
  const followUpRecords = paperwork ? await getFollowUpRecords(identity, transfer.id) : null;
  const outcomeRecords = paperwork ? await getOutcomeRecords(identity, transfer.id) : null;
  const receiptProps: ReceiptPanelProps | null = paperwork && receiptFundingType
    ? {
        resubmissionOpen: followUpRecords?.resubmissionOpen ?? false,
        transferId: transfer.id,
        stage: transfer.stage,
        canRecord: canWrite && !archived && canRecordOperationsOnlyTransferFact(role),
        submissionBlockers: submissionBlockers(transfer, receiptFundingType, paperwork),
        records: await getReceiptRecords(identity, transfer.id),
      }
    : null;
  const channelKind: ChannelKind | null = !paperwork
    ? null
    : transfer.funding_type === "CHECK"
      ? "check"
      : transfer.funding_type === "ACH"
        ? "ach"
        : transfer.funding_type === "ACAT_FULL" && paperwork.appAuthorizationRecorded
          ? "linked"
          : null;
  const channelRecords = channelKind ? await getChannelRecords(identity, transfer.id) : null;
  const eligibilityHoldings: EligibilityHolding[] = partialPositions
    ? partialPositions.map((position) => ({
        symbol: position.symbol,
        description: position.description,
        marketValue: position.marketValue,
        decision: decisions.find((decision) => decision.symbol === position.symbol)?.decision ?? null,
        isTransferring: position.isTransferring,
        ineligible: position.ineligible,
        cannotTransferInKind: position.ineligible,
      }))
    : decisions.map((decision) => ({
        symbol: decision.symbol,
        description: decision.description,
        marketValue: decision.value,
        decision: decision.decision,
      }));
  // SERVER-SIDE join key for the hub's Trade-requests row (S4) — the transfer
  // client's raw cedar_ridge_user_id (client_sf_id → mirror.client.sf_id →
  // cedar_ridge_user_id), RLS-scoped. Held as a local const, passed only to the
  // (server) FundingPictureCard → TradeRequestsSection; never rendered, never on
  // TransferRow. Null (→ no row) when the transfer has no client or the client
  // has no id — a DB read of the same class as dealsForHousehold above.
  const tradeRequestUserId = transfer.client_sf_id
    ? await getCedarRidgeUserIdForLinkedReads(identity, transfer.client_sf_id)
    : null;

  // Derived receiving account (S6): when a mapping account is linked, its
  // registration type implies a receiving Apex account — resolve whether the
  // client already holds an open one, or it still needs opening. Sourced from
  // the Warehouse accounts+AUM feed (client_account_aum) matched by the transfer's
  // client_sf_id (owner decision 2026-07-21) — the one live feed, no n8n dep.
  const derivedReceiving =
    assetMapTransferLinkEnabled() &&
    transfer.asset_map_folder_id &&
    transfer.asset_map_account_type &&
    transfer.client_sf_id
      ? await getDerivedReceivingAccount(identity, {
          clientSfId: transfer.client_sf_id,
          accountType: transfer.asset_map_account_type,
        })
      : null;

  return (
    <>
      <BackToBoardLink scope={session.navigationScope ?? ""} className={styles.backLink} />

      {/* Archived notice (feat/transfer-archive-falloff) — mirrors DealDetail's
          "Removed from the pipeline" banner; the reason stamp maps to friendly
          text (archivedReasonLabel). The record stays readable below. */}
      {archived && (
        <p className={styles.archivedNote} role="status">
          Removed from the board{" "}
          {transfer.archived_at?.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
          {archivedReason ? ` — ${archivedReason}` : ""} — kept for the audit
          trail; this record is read-only.
        </p>
      )}

      {/* Needs-review banner (transfer-syncflag-surface) — the archivedNote
          idiom in warning tone. Shown whenever the reconciler stamped
          sync_flag on a live transfer; the resolution affordances sit inside
          it: the existing archive button (its own flag gate, exactly as the
          page-bottom render) and the dismiss-and-keep action. VIEWERs see the
          banner text only. */}
      {syncFlagNote && (
        <div className={styles.reviewNote} role="status">
          <p className={styles.reviewText}>
            <strong className={styles.reviewLabel}>Needs review</strong> —{" "}
            {syncFlagNote}
          </p>
          {canWrite && (
            <div className={styles.reviewActions}>
              <SyncFlagDismissButton transferId={transfer.id} />
              {transferArchiveActionEnabled() && (
                <TransferArchiveButton transferId={transfer.id} />
              )}
            </div>
          )}
        </div>
      )}

      <div className={styles.toolbar}>
        <TransferToolbar
          transferId={transfer.id}
          stage={transfer.stage}
          ownerKind={transfer.owner_kind}
          ownerName={transfer.owner_name}
          canWrite={canWrite}
          canChangeStage={canWrite && (!isDrs || canApproveFundingPlan(role))}
        />
      </div>

      {/* The 320px rail exists only for the Temperature card; with no context
          (every real client until Phase E ships) it would render empty and
          strand the space — so the grid collapses to one column instead. */}
      <div className={context ? styles.columns : styles.columnsSingle}>
        <div className={styles.main}>
          <Card>
            <CardBody>
              <div className={styles.head}>
                <div>
                  <h1 className={styles.name}>
                    {transfer.client_first_name} {transfer.client_last_name}
                  </h1>
                  {transfer.household_name && (
                    <p className={styles.household}>
                      {transfer.household_name}
                      {transfer.household_sf_id
                        ? ` · ${transfer.household_sf_id}`
                        : ""}
                    </p>
                  )}
                  {crmId ? <CrmIdField value={crmId} /> : null}
                </div>
                <Pill tone={transfer.stage === "FUNDED" ? "green" : "blue"} dot>
                  {stageLabel(transfer.stage)}
                </Pill>
              </div>

              <div className={styles.figures}>
                <div className={styles.figure}>
                  <span className={styles.figureLabel}>Value</span>
                  <span className={styles.figureValue}>
                    {usd(displayValue)}
                  </span>
                </div>
                <div className={styles.figure}>
                  <span className={styles.figureLabel}>Stage</span>
                  <span className={styles.figureValue}>
                    {stageLabel(transfer.stage)}
                  </span>
                </div>
                <div className={styles.figure}>
                  <span className={styles.figureLabel}>Days in stage</span>
                  <span className={styles.figureValue}>{days}</span>
                </div>
                {route && (
                  <div className={styles.figure}>
                    <span className={styles.figureLabel}>Route</span>
                    <span className={styles.figureValue}>{route}</span>
                  </div>
                )}
              </div>

              <TransferOverviewSummary
                transfer={transfer}
                receiving={derivedReceiving}
                nextTask={isDrs
                  ? drsTasksForStage(transfer.stage, transfer.drs_method_change_pending ?? false).find((task) => !drsTasks.some((row) => row.taskKey === task.taskKey && row.status === "DONE"))?.title ?? null
                  : resolvedTasks.find((task) => !task.done)?.title ?? null}
                openExceptions={openExceptions.length}
                blockingExceptions={blockingExceptions}
                fundingMethodControl={canWrite && canApproveFundingPlan(role) ? <FundingMethodChange
                  transferId={transfer.id}
                  stage={transfer.stage}
                  fundingType={recordedFundingMethod(transfer)}
                  planVersion={transfer.funding_plan_version}
                  methodRevision={transfer.funding_method_revision ?? 0}
                  hasAcatLink={Boolean(transfer.acat_record_id || transfer.acat_transfer_id)}
                /> : undefined}
                assetMapEnabled={assetMapTransferLinkEnabled()}
                assetMapUnavailable={Boolean(
                  assetMapTransferLinkEnabled() && transfer.asset_map_folder_id &&
                  transfer.asset_map_custodian && !assignedMapDetail
                )}
              />

              {transfer.funding_route_change_pending && transfer.stage !== "FUNDED" && (
                <FundingMethodInitiation
                  transferId={transfer.id}
                  stage={transfer.stage}
                  fundingType={transfer.funding_type}
                  planVersion={transfer.funding_plan_version}
                  methodRevision={transfer.funding_method_revision ?? 0}
                  hasAcatLink={Boolean(transfer.acat_record_id || transfer.acat_transfer_id)}
                  canWrite={canWrite && canApproveFundingPlan(role)}
                />
              )}
              <div className={styles.stepper}>
                <GateStepper gates={gates} />
              </div>
            </CardBody>
          </Card>

          {/* A compact live status stays visible even with the details closed.
              Both consumers use the SAME request-memoized tracker reader;
              unavailable / bad-link outcomes must not disappear in a drawer. */}
          {!isDrs && ((transfer.acat_record_id || transfer.acat_transfer_id) ? (
            <Suspense fallback={<p className={styles.sourceNote}>Loading linked ACAT status…</p>}>
              <AcatStatusSection
                acatRecordId={transfer.acat_record_id}
                acatTransferId={transfer.acat_transfer_id}
                summaryOnly
              />
            </Suspense>
          ) : (
            <p className={styles.sourceNote}>No live ACAT linked. Linked records are available below.</p>
          ))}

          {assetTransferWorkspaceEnabled() && (
            <StatementAccountSection
              identity={identity}
              transfer={transfer}
              accounts={accounts}
              canRecord={canWrite && canRecordClientServiceTransferFact(role)}
            />
          )}

          {fundingMethodHistory.length > 0 && (
            <TransferDetailSection
              id="transfer-funding-method-history"
              title="Funding method history"
              description="Saved method changes, reasons and approval revisions"
              meta={`${fundingMethodHistory.length} ${fundingMethodHistory.length === 1 ? "change" : "changes"}`}
            >
              <CardBody><FundingMethodHistory entries={fundingMethodHistory} /></CardBody>
            </TransferDetailSection>
          )}
          <TransferPlanDraftProvider
            key={`funding-plan-${transfer.funding_plan_version}-${transfer.funding_method_revision ?? 0}`}
            transferId={transfer.id}
            initialFundingType={transfer.funding_type}
            initialBasisDecisions={decisions.map((decision) => ({
              decisionId: decision.id,
              decision: decision.decision,
            }))}
            initialPartialPositions={(partialPositions ?? []).map((position) => ({
              symbol: position.symbol,
              isTransferring: position.isTransferring,
            }))}
            canEdit={
              canWrite &&
              transfer.stage === "DECISION" &&
              canApproveFundingPlan(role)
            }
            canApprove={canWrite && (transfer.stage === "DECISION" || legacyPlanReview) && canApproveFundingPlan(role)}
            approvalMode={legacyPlanReview ? "LEGACY_IN_TRANSFER_REVIEW" : "PREPARATION"}
            planComplete={transfer.funding_plan_complete}
            approvedVersion={transfer.funding_plan_version}
            approvedAt={transfer.funding_plan_approved_at?.toISOString() ?? null}
            approvedBy={transfer.funding_plan_approved_by}
          >
          {/* Presentation only: preserve the hub's controls and independent
              streaming boundaries, including the full tracker detail. */}
          <TransferDetailSection
            id="transfer-information"
            title="Information & linked records"
            description="Deal, asset map, account details, tracker history and trade requests"
          >
          <section className={styles.hub} aria-label="Full funding picture">
            <FundingPictureCard
              transfer={transfer}
              deal={linkedDeal}
              deals={deals}
              assignedMapDetail={assignedMapDetail}
              tradeRequestUserId={tradeRequestUserId}
              canWrite={canWrite}
              canLinkAcat={canLinkAcat}
              canLinkAssetMap={canWrite && transfer.stage === "DECISION" && canApproveFundingPlan(role)}
            />
            {canLinkAcat && <AcatLinkCta transferId={transfer.id} />}
          </section>
          </TransferDetailSection>

          {(transfer.stage === "DECISION" || legacyPlanReview || transfer.funding_type === "ACAT_PARTIAL") && (
          <TransferDetailSection
            id="transfer-funding-plan"
            initiallyOpen={legacyPlanReview}
            title="Funding plan & positions"
            description="Review the funding method, transfer scope and saved approval"
            meta={transfer.funding_plan_complete
              ? transfer.funding_plan_version > 0 ? `Approved · version ${transfer.funding_plan_version}` : "Legacy completion — approval needed"
              : "Not approved"}
          >

          {/* Decision-stage readiness (ticket Slice 2) — the funding rail +
              the three gate booleans + cash_in_flight. UNFLAGGED baseline (§2):
              additive card; its booleans are inert until S3's flagged
              DECISION→IN_TRANSFER hard gate consumes them. Shown only for
              DECISION-stage transfers. */}
          {/* Flag CHECKLIST_STAGE_GATE ON hides the standalone readiness card —
              its role moves into the checklist below (rendered in this card's
              UI, gating stage advance). OFF → today's readiness card. */}
          {(transfer.stage === "DECISION" || legacyPlanReview) && (
            <Card>
              <CardHeader>
                {checklistGate || isDrs || legacyPlanReview ? "Funding plan" : "Decision readiness"}
              </CardHeader>
              <CardBody>
                <DecisionChecklistCard
                  transferId={transfer.id}
                  accountsOpenedAtApex={transfer.accounts_opened_at_apex}
                  fundingInitiated={transfer.funding_initiated}
                  cashInFlight={transfer.cash_in_flight}
                  canWrite={canWrite}
                  showReadiness={!checklistGate && !isDrs && !legacyPlanReview}
                  eligibilityEnabled={workspaceEnabled}
                  eligibilityHoldings={eligibilityHoldings}
                />
              </CardBody>
            </Card>
          )}

          {workspaceEnabled && (
            <InstructionList holdings={eligibilityHoldings} enabled={workspaceEnabled} />
          )}
          {/* Keep the draft-aware component mounted: switching to partial must
              reveal its positions before any approval is saved. */}
          <TransferPlanPositionsCard
            positions={partialPositions}
            decisions={decisions}
          />
          <TransferPlanApprovalFooter />
          </TransferDetailSection>
          )}

          {isDrs && (
            <TransferDetailSection
              id="transfer-drs-workflow"
              title="DRS workflow"
              description="Client Service preparation, Operations submission and confirmation, and follow-up"
              meta={`${drsTasks.filter((task) => task.status === "DONE").length}/${DRS_TASKS.length} complete`}
              initiallyOpen
            >
              <CardBody>
                <DrsWorkflowCard
                  transferId={transfer.id}
                  stage={transfer.stage}
                  tasks={drsTasks}
                  role={role}
                  canWrite={canWrite}
                  planComplete={transfer.funding_plan_complete}
                  fundingPlanVersion={transfer.funding_plan_version}
                  methodChangePending={transfer.drs_method_change_pending ?? false}
                />
              </CardBody>
            </TransferDetailSection>
          )}

          {assetTransferWorkspaceEnabled() && (
            <MailingSection
              identity={identity}
              transferId={transfer.id}
              canRecord={canWrite && canRecordClientServiceTransferFact(role)}
            />
          )}

          {paperworkProps && (
            <TransferDetailSection
              id="transfer-paperwork"
              title="Paperwork"
              description="Generate, review and download the transfer form"
            >
              <Card>
                <CardBody>
                  <ReviewDownload {...paperworkProps} />
                </CardBody>
              </Card>
            </TransferDetailSection>
          )}

          {followUpRecords && (
            <TransferDetailSection
              id="transfer-follow-up"
              title="Follow-up, residual and rejection"
              description="Fee reimbursement, the linked investment request, residuals and ACAT rejections"
            >
              <Card>
                <CardBody>
                  <FollowUpPanel
                    transferId={transfer.id}
                    isAcat={receiptFundingType != null}
                    canRecordOperations={canWrite && !archived && canRecordOperationsOnlyTransferFact(role)}
                    canRespond={canWrite && !archived && canRecordClientServiceTransferFact(role)}
                    records={followUpRecords}
                  />
                </CardBody>
              </Card>
            </TransferDetailSection>
          )}

          {outcomeRecords && (
            <TransferDetailSection
              id="transfer-outcomes"
              title="Outcome and history"
              description="Declined, deferred, canceled or purged movements, stage changes and corrections"
            >
              <Card>
                <CardBody>
                  <OutcomesPanel
                    transferId={transfer.id}
                    canRecord={canWrite}
                    records={outcomeRecords}
                  />
                </CardBody>
              </Card>
            </TransferDetailSection>
          )}

          {channelKind && channelRecords && (
            <TransferDetailSection
              id="transfer-channels"
              title="Check, ACH and linked account"
              description="Client-initiated movements and check tickets"
            >
              <Card>
                <CardBody>
                  <ChannelsPanel
                    transferId={transfer.id}
                    kind={channelKind}
                    canRecord={canWrite && !archived && canRecordClientServiceTransferFact(role)}
                    records={channelRecords}
                  />
                </CardBody>
              </Card>
            </TransferDetailSection>
          )}

          {receiptProps && (
            <TransferDetailSection
              id="transfer-receipt"
              title="Submission and receipt"
              description="Log the submission, track progress and confirm the assets received"
            >
              <Card>
                <CardBody>
                  <ReceiptPanel {...receiptProps} />
                </CardBody>
              </Card>
            </TransferDetailSection>
          )}

          <TransferDetailSection
            id="transfer-exceptions"
            title="Transfer exceptions"
            description="Only issues that need clarification or a separate resolution"
            meta={`${openExceptions.length} open · ${blockingExceptions} blocking`}
            initiallyOpen={openExceptions.length > 0}
          >
            <CardBody>
              <LinkedDecisionCases
                cases={linkedDecisionCases}
                transferId={transfer.id}
                canWrite={canWrite}
              />
            </CardBody>
          </TransferDetailSection>

          {!isDrs && <TransferDetailSection
            id="transfer-checklist"
            title={checklistGate ? "Stage checklist" : "To-do checklist"}
            description="Existing transfer steps and completion controls"
            meta={`${doneCount}/${shownTasks.length} complete`}
          >
            <CardBody>
              {checklistGate ? (
                <StageChecklistCard
                  transferId={transfer.id}
                  tasks={resolvedTasks}
                  canWrite={canWrite}
                />
              ) : (
                <TransferChecklist
                  transferId={transfer.id}
                  tasks={resolvedTasks}
                  canWrite={canWrite}
                />
              )}
            </CardBody>
          </TransferDetailSection>}

          {/* Slack closeout (SLACK_TRANSFER_CLOSEOUT) — read-only mirror of the
              post-funding checklist that ops complete in Slack: the full
              per-item list (owner ask 2026-07-24), not just the count. Rendered
              only once seeded (transfer reached IN_TRANSFER with the flag on). */}
          {slackCloseout && (
            <TransferDetailSection
              id="transfer-closeout"
              title="Slack closeout"
              description="Post-transfer checklist tracked in Slack"
              meta={`${slackCloseout.done}/${slackCloseout.total} complete`}
            >
              <CardBody>
                <SlackCloseoutCard closeout={slackCloseout} />
              </CardBody>
            </TransferDetailSection>
          )}
          </TransferPlanDraftProvider>

          <TransferDetailSection
            id="transfer-receiving-accounts"
            title="Receiving accounts"
            description="Synced account match and existing account-opening controls"
            meta={`${accounts.filter((account) => account.status === "OPEN").length}/${accounts.length} recorded accounts open${derivedReceiving?.status === "OPEN" ? " · synced match found" : ""}`}
          >
            <CardBody>
              <ReceivingAccountsCard
                transferId={transfer.id}
                accounts={accounts}
                canWrite={canWrite}
                derived={derivedReceiving}
                fundingCoverage={
                  initialFundingCheckEnabled() &&
                  tradeRequestUserId &&
                  derivedReceiving?.status === "OPEN" &&
                  derivedReceiving.apexAccountMasked ? (
                    <Suspense fallback={null}>
                      <InitialFundingCoverage
                        cedarRidgeUserId={tradeRequestUserId}
                        accountLast4={derivedReceiving.apexAccountMasked}
                      />
                    </Suspense>
                  ) : null
                }
              />
            </CardBody>
          </TransferDetailSection>

          {/* Manual soft-archive (flag TRANSFER_ARCHIVE_ACTION) — detail page
              ONLY, never on board cards. Write roles, non-archived records;
              `canWrite` already folds in !archived. The action re-gates flag +
              role + RLS server-side regardless. When the needs-review banner is
              up, THAT is the one home for the button (a resolution affordance)
              — never two archive buttons on one page. */}
          {transferArchiveActionEnabled() && canWrite && !syncFlagNote && (
            <TransferArchiveButton transferId={transfer.id} />
          )}
        </div>

        {/* T4 composition column (ticket, TDD §6). Temperature (Phase E mock
            seam). Rendered only WITH context — the wrapper grid collapses to a
            single column otherwise (owner 2026-07-24: no stranded rail). The
            Pending-nudge card was removed (owner 2026-07-21); pending_nudge
            still surfaces as the summary row + the edit form. */}
        {context && (
          <aside className={styles.side} data-t4-slot>
            <TemperatureCard context={context} />
          </aside>
        )}
      </div>
    </>
  );
}
