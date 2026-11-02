import type { Identity } from "@/lib/rls";
import type { TransferDetail } from "@/lib/data/transfer-detail";
import { getFundingMethodCorrections } from "@/app/(authenticated)/asset-transfer/funding-method-actions";
import { listDecisionCasesForTransfer, type DecisionCaseRow } from "@/lib/data/decision-cases";
import {
  canApproveFundingPlan,
  canRecordClientServiceTransferFact,
  canRecordOperationsOnlyTransferFact,
  canWriteTransfers,
} from "@/lib/data/transfer-write";
import { getDrsWorkflowTasks } from "@/lib/data/drs-workflow-store";
import type { DrsWorkflowTaskRow } from "@/lib/data/drs-workflow";
import { resolveTaskDone, resolveTransferValue } from "@/lib/data/transfer-types";
import { getDeal } from "@/lib/data/deals";
import type { DealRow } from "@/lib/data/deal-types";
import { getPartialAcatPositions } from "@/lib/data/transfer-asset-map";
import { getDerivedReceivingAccount, type DerivedReceivingAccount } from "@/lib/data/receiving-account-match";
import {
  assetMapTransferLinkEnabled,
  paperworkRecordsEnabled,
  slackCloseoutEnabled,
  transferArchiveActionEnabled,
} from "@/lib/flags";
import { archivedReasonLabel, syncFlagLabel } from "@/lib/data/transfer-archive";
import { getSlackCloseout, type SlackCloseoutStatus } from "@/lib/data/transfers";
import type { ReviewDownloadProps } from "@/components/asset-transfer/paperwork/ReviewDownload";
import { getPaperworkRecords, paperworkTitlesComplete, type PaperworkPageRecords } from "@/lib/data/transfer-paperwork-store";
import { apexAccountsForClient } from "@/lib/data/account-aum";
import { manualRouteForms, routeLabel, type RouteLabel } from "@/lib/transfers/route-label";
import { accountMatchBlocks, statementBlocks } from "@/lib/transfers/intake-gates";
import type { ReceiptPanelProps } from "@/components/asset-transfer/receipt/ReceiptPanel";
import { getReceiptRecords, submissionBlockers, type ReceiptRecords } from "@/lib/transfers/receipt";
import type { ChannelKind } from "@/components/asset-transfer/channels/ChannelsPanel";
import { getChannelRecords, type ChannelRecords } from "@/lib/transfers/channels";
import { getFollowUpRecords, type FollowUpRecords } from "@/lib/transfers/follow-up";
import { getOutcomeRecords, type OutcomeRecords } from "@/lib/transfers/outcomes";
import type { EligibilityHolding } from "@/lib/transfers/holding-eligibility";
import { effectiveTaskStatus } from "@/lib/transfers/workspace-queue";
import { getWorkspaceDetailRecords, type WorkspaceHistoryEntry } from "@/lib/data/transfer-workspace-detail";
import type { FundingMethodCorrectionRow } from "@/lib/data/transfer-funding-method-change";
import { getPartialAcatTasks } from "@/lib/data/partial-acat-workspace-tasks";
import { partialAcatWorkspaceTask } from "@/lib/transfers/partial-acat-queue";
import { getTransferConnections } from "@/lib/data/transfer-connections";
import type { TransferConnections } from "@/lib/transfers/connections";
import { drsTaskStatus, taskSection, teamLabel, type DetailTask } from "./detail-model";

export type PlanHolding = {
  key: string;
  symbol: string;
  description: string;
  value: number | null;
  ineligible: boolean;
  decisionId: string | null;
  decision: string | null;
  isTransferring: boolean | null;
};

export type TransferDetailWorkspaceData = {
  identity: Identity;
  role: string;
  detail: TransferDetail;
  canWrite: boolean;
  canApprove: boolean;
  canRecordClientService: boolean;
  canRecordOperations: boolean;
  canChangeStage: boolean;
  archived: boolean;
  archivedReason: string | null;
  syncFlagNote: string | null;
  archiveEnabled: boolean;
  isDrs: boolean;
  displayValue: number;
  linkedDeal: DealRow | null;
  tasks: DetailTask[];
  drsTasks: DrsWorkflowTaskRow[];
  decisionCases: DecisionCaseRow[];
  holdings: EligibilityHolding[];
  planHoldings: PlanHolding[];
  partialPositionsLoaded: boolean;
  legacyPlanReview: boolean;
  paperwork: PaperworkPageRecords | null;
  route: RouteLabel | null;
  paperworkProps: ReviewDownloadProps | null;
  receiptRecords: ReceiptRecords | null;
  receiptProps: ReceiptPanelProps | null;
  receiptFundingType: "ACAT_FULL" | "ACAT_PARTIAL" | null;
  followUpRecords: FollowUpRecords | null;
  outcomeRecords: OutcomeRecords | null;
  channelKind: ChannelKind | null;
  channelRecords: ChannelRecords | null;
  derivedReceiving: DerivedReceivingAccount | null;
  slackCloseout: SlackCloseoutStatus | null;
  fundingMethodHistory: FundingMethodCorrectionRow[];
  history: WorkspaceHistoryEntry[];
  connections: TransferConnections;
};

/** The flag-on detail's reads. Section props are built exactly as the flag-off page builds them. */
export async function loadTransferDetailWorkspace(identity: Identity, role: string, detail: TransferDetail): Promise<TransferDetailWorkspaceData> {
  const { transfer, tasks, decisions } = detail;
  const archived = transfer.archived_at != null;
  const canWrite = canWriteTransfers(role) && !archived;
  const isDrs = transfer.funding_type === "DRS";
  const canApprove = canApproveFundingPlan(role);

  // Sequential like the flag-off page: parallel RLS transactions contend for the pool and can expire.
  const extras = await getWorkspaceDetailRecords(identity, transfer.id);
  const drsTasks: DrsWorkflowTaskRow[] = isDrs ? await getDrsWorkflowTasks(identity, transfer.id) : [];
  const decisionCases = await listDecisionCasesForTransfer(identity, transfer.id);
  const linkedDeal = transfer.deal_id ? await getDeal(identity, transfer.deal_id) : null;
  const fundingMethodHistory: FundingMethodCorrectionRow[] = canApprove ? await getFundingMethodCorrections(transfer.id) : [];
  const connections = await getTransferConnections(identity, transfer, detail.accounts, linkedDeal);

  const dealFlags = linkedDeal ? { statements: linkedDeal.statements, asset_mapped: linkedDeal.asset_mapped } : null;
  const meta = new Map(extras.taskMeta.map(row => [row.id, row]));
  const partialRows = isDrs ? [] : await getPartialAcatTasks(identity, transfer.id);
  const partialTasks: DetailTask[] = partialRows.flatMap(row => {
    const queued = partialAcatWorkspaceTask(row, transfer.funding_type, archived);
    if (!queued?.team) return [];
    return [{
      id: row.id, kind: "partial-acat" as const, title: row.title, status: queued.status, owner: queued.team,
      section: taskSection(row.title), done: row.status === "DONE", completedAt: row.completedAt, completedBy: row.completedBy,
      assignedTo: null, followUpOn: null,
      partialAcat: {
        status: row.status, priority: row.priority, updatedAt: row.updatedAt,
        fundingPlanVersion: transfer.funding_plan_version, fundingMethodRevision: transfer.funding_method_revision ?? 0,
      },
    }];
  });
  const detailTasks: DetailTask[] = isDrs
    ? drsTasks.map(task => ({
        id: task.id, kind: "drs", title: task.title, status: drsTaskStatus(task.status), owner: teamLabel(task.ownerTeam),
        section: taskSection(task.title), done: task.status === "DONE", completedAt: task.completedAt, completedBy: task.completedBy,
        assignedTo: null, followUpOn: null,
        drs: { taskKey: task.taskKey, status: task.status, priority: task.priority, updatedAt: task.updatedAt, fundingPlanVersion: task.fundingPlanVersion, ownerTeam: task.ownerTeam },
      }))
    : [...tasks.map(task => {
        const done = resolveTaskDone(task, dealFlags);
        const stored = meta.get(task.id);
        return {
          id: task.id, kind: "checklist" as const, title: task.title, status: effectiveTaskStatus(done, stored?.status ?? "Ready"),
          owner: teamLabel(stored?.team ?? null), section: taskSection(task.title), done,
          completedAt: task.completed_at?.toISOString() ?? null, completedBy: task.completed_by,
          assignedTo: stored?.assigned_to ?? null, followUpOn: stored?.follow_up_on?.toISOString().slice(0, 10) ?? null,
        };
      }), ...partialTasks];

  const legacyPlanReview = transfer.stage === "IN_TRANSFER" &&
    transfer.funding_plan_version === 0 && transfer.funding_type !== "DRS" && !transfer.archived_at;
  const partialPositions =
    (transfer.stage === "DECISION" || transfer.funding_type === "ACAT_PARTIAL") &&
    assetMapTransferLinkEnabled() && transfer.asset_map_folder_id && transfer.asset_map_custodian
      ? await getPartialAcatPositions(identity, {
          transferId: transfer.id,
          folderId: transfer.asset_map_folder_id,
          custodian: transfer.asset_map_custodian,
          accountNumber: transfer.asset_map_account_number,
          accountType: transfer.asset_map_account_type,
        })
      : null;
  const holdings: EligibilityHolding[] = partialPositions
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
  const planHoldings: PlanHolding[] = partialPositions
    ? partialPositions.map(position => ({
        key: `position:${position.symbol}`, symbol: position.symbol, description: position.description ?? "Mapped position",
        value: position.marketValue, ineligible: position.ineligible, decisionId: null, decision: null, isTransferring: position.isTransferring,
      }))
    : decisions.map(decision => ({
        key: `decision:${decision.id}`, symbol: decision.symbol, description: decision.description ?? "Mapped position",
        value: decision.value, ineligible: false, decisionId: decision.id, decision: decision.decision, isTransferring: null,
      }));

  const paperwork = paperworkRecordsEnabled() ? await getPaperworkRecords(identity, transfer.id) : null;
  const route = paperwork && transfer.funding_type
    ? routeLabel(transfer.funding_type, paperwork.appAuthorizationRecorded)
    : null;
  let paperworkProps: ReviewDownloadProps | null = null;
  if (paperwork && route) {
    const intakeBlocked = statementBlocks(true, paperwork.latestStatement) ||
      accountMatchBlocks(
        true,
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
      manualForms: route === "Manual · custodian-library process" && transfer.delivering_custodian_id
        ? manualRouteForms(connections.custodian?.name ?? transfer.transferring_firm)
        : [],
      records: {
        sentPacketRecorded: paperwork.sentPacketRecorded,
        returnedSignatureRecorded: paperwork.returnedSignatureRecorded,
        mailedPaperworkRecorded: paperwork.mailedPaperworkRecorded,
      },
      drsTicket: route === "DRS · Apex service request"
        ? {
            clientName: connections.client.name,
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
  const receiptRecords = paperwork ? await getReceiptRecords(identity, transfer.id) : null;
  const receiptProps: ReceiptPanelProps | null = paperwork && receiptFundingType && receiptRecords
    ? {
        resubmissionOpen: followUpRecords?.resubmissionOpen ?? false,
        transferId: transfer.id,
        stage: transfer.stage,
        canRecord: canWrite && !archived && canRecordOperationsOnlyTransferFact(role),
        submissionBlockers: submissionBlockers(transfer, receiptFundingType, paperwork),
        records: receiptRecords,
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

  const derivedReceiving =
    assetMapTransferLinkEnabled() && transfer.asset_map_folder_id && transfer.asset_map_account_type && transfer.client_sf_id
      ? await getDerivedReceivingAccount(identity, { clientSfId: transfer.client_sf_id, accountType: transfer.asset_map_account_type })
      : null;
  const slackCloseout = !isDrs && slackCloseoutEnabled() ? await getSlackCloseout(identity, transfer.id) : null;

  return {
    identity, role, detail, canWrite, canApprove,
    canRecordClientService: canWrite && canRecordClientServiceTransferFact(role),
    canRecordOperations: canWrite && canRecordOperationsOnlyTransferFact(role),
    canChangeStage: canWrite && (!isDrs || canApprove),
    archived,
    archivedReason: archivedReasonLabel(transfer.archived_reason, transfer.archived_by),
    syncFlagNote: archived ? null : syncFlagLabel(transfer.sync_flag),
    archiveEnabled: transferArchiveActionEnabled(),
    isDrs,
    displayValue: resolveTransferValue(transfer.value, linkedDeal?.amount ?? null),
    linkedDeal,
    tasks: detailTasks,
    drsTasks,
    decisionCases,
    holdings,
    planHoldings,
    partialPositionsLoaded: partialPositions != null,
    legacyPlanReview,
    paperwork,
    route,
    paperworkProps,
    receiptRecords,
    receiptProps,
    receiptFundingType,
    followUpRecords,
    outcomeRecords,
    channelKind,
    channelRecords,
    derivedReceiving,
    slackCloseout,
    fundingMethodHistory,
    history: extras.history,
    connections,
  };
}
