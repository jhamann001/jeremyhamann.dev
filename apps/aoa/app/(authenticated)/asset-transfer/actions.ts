"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { withUserScope, type Identity } from "@/lib/rls";
import {
  writeAudit,
  TRANSFER_CREATE,
  TRANSFER_UPDATE,
  TRANSFER_STAGE_CHANGE,
  TRANSFER_TASK_TOGGLE,
  TRANSFER_FUNDING_PLAN_APPROVE,
  TRANSFER_ACCOUNT_STATUS,
  TRANSFER_ASSET_MAP_LINK,
  TRANSFER_ASSET_MAP_UNLINK,
  TRANSFER_ARCHIVE,
  TRANSFER_SYNC_FLAG_DISMISS,
} from "@/lib/audit";
import {
  validateTransferInput,
  type TransferValidationError,
} from "@/lib/data/transfer-validate";
import {
  DEFAULT_TASKS,
  TRANSFER_ACCOUNT_STATUSES,
  TRANSFER_OWNERS,
  TRANSFER_STAGES,
  STAGE_ORDER,
  SYNCED_TASK_DEAL_FLAG,
  resolveTaskDone,
  stageChecklistTasks,
  missingStageChecklistRows,
  type FundingType,
  type TransferAccountStatus,
  type TransferDecisionChoice,
  type TransferOwner,
  type TransferStage,
} from "@/lib/data/transfer-types";
import { gateStatus } from "@/lib/data/transfer-basis";
import { stageChangeWarnings } from "@/lib/data/transfer-stage";
import {
  acatLinkedFromIds,
  hardGateBlock,
  checklistGateBlock,
  fundingRouteChangeGate,
} from "@/lib/data/transfer-gate";
import {
  transferDealSourcedRedesignEnabled,
  assetMapTransferLinkEnabled,
  checklistStageGateEnabled,
  slackCloseoutEnabled,
  transferArchiveActionEnabled,
  assetTransferWorkspaceEnabled,
  paperworkRecordsEnabled,
} from "@/lib/flags";
import {
  canApproveFundingPlan,
  canRecordClientServiceTransferFact,
  canRecordOperationsOnlyTransferFact,
  canWriteTransfers,
} from "@/lib/data/transfer-write";
import {
  acceptStatement,
  accountMatchBlocks,
  saveAccountMatch,
  statementBlocks,
} from "@/lib/transfers/intake-gates";
import {
  paperworkTitlesComplete,
  readPaperworkRecords,
} from "@/lib/data/transfer-paperwork-store";
import { formTitleVersion, routeLabel } from "@/lib/transfers/route-label";
import { recordClientRequest, type ClientRequestInput, type ClientRequestResult } from "@/lib/transfers/client-request";
import {
  overlappingTransfer, validateConnectedIntake,
  type ConnectedIntake, type ConnectedIntakeInput,
} from "@/lib/transfers/new-transfer-intake";
import {
  clientIntakeRows,
  openApexReceivingOptions,
  readApexAccountRows,
  readAssetMapSourceFacts,
  readCustodianOption,
  readDealOptions,
  readDirectoryClient,
  readTaskOwnerRoster,
  reconcileReceivingAccounts,
  getClientTradeRequests,
} from "@/lib/data/transfer-connections";
import { readClientFeeRequests } from "@/lib/data/acat-reimbursement";
import { saveMailing, updateMailingLegs, type MailingError, type MailingLegInput } from "@/lib/transfers/mailing";
import { validateTaskFollowUp, type TaskFollowUpError, type TaskFollowUpInput } from "@/lib/transfers/task-follow-up";
import {
  confirmArrival,
  logOperationsSubmission,
  receiptBlocksFunded,
  receiptRecordsEnabled,
  saveTrackingUpdate,
  type ReceiptFieldError,
  type ReceiptInput,
  type ReceiptTransfer,
  type SubmissionInput,
  type TrackingInput,
} from "@/lib/transfers/receipt";
import {
  channelRecordsEnabled,
  recordAchInitiation,
  recordCheckTicket,
  type AchInitiationInput,
  type ChannelFieldError,
  type ChannelTransfer,
  type ChannelWriteResult,
  type CheckTicketInput,
} from "@/lib/transfers/channels";
import {
  acceptRejectionResolution,
  followUpRecordsEnabled,
  linkInvestmentRequest,
  recordAcatRejection,
  type RejectionInput,
  recordFeeReimbursement,
  readLatestRejection,
  recordResidual,
  rejectionBlocksFunded,
  saveRejectionResponse,
  type FollowUpFieldError,
  type FollowUpTransfer,
  type FollowUpWriteResult,
} from "@/lib/transfers/follow-up";
import {
  PREPARATION_PAUSED,
  keepPriorAssignment,
  outcomeRecordsEnabled,
  preparationPausedFor,
  recordCorrection,
  recordOutcome,
  recordStageChange,
  resumeTransfer,
  type OutcomeWriteResult,
} from "@/lib/transfers/outcomes";
import {
  compareReceipt,
  expectedReceiptLines,
  parseReceiptCsv,
  type ExpectedReceiptLine,
  type ReceiptLineDraft,
} from "@/lib/transfers/receipt-compare";
import { demoMode } from "@/lib/demo/mode";
import {
  eligibilityColumns,
  fullAcatRefused,
  FULL_ACAT_REFUSED_MESSAGE,
} from "@/lib/transfers/holding-eligibility";
import { MANUAL_ARCHIVE_REASON } from "@/lib/data/transfer-archive";
import { SLACK_CLOSEOUT_TEMPLATE } from "@/lib/data/slack-closeout-template";
import {
  postCloseoutWebhook,
  type CloseoutWebhookInput,
} from "@/lib/slack/closeout-webhook";
import {
  getAssetMapApprovalSnapshot,
  getAssignedAssetMapDetail,
  getPartialAcatPositions,
  listAssignableAssetMapAccounts,
  resolveAssignableAssetMapAccount,
  type AssetMapAccountOption,
  type AssignableAssetMapAccountKey,
} from "@/lib/data/transfer-asset-map";
import { canReviewAssetMapLinks } from "@/lib/data/asset-map-review-authz";
import {
  fundingPlanInvalidation,
  normalizeFundingPlanNote,
  partialAcatInstructionsChanged,
  validateFundingPlanApproval,
  type FundingPlanDraftInput,
} from "@/lib/data/transfer-plan-approval";
import { lockTransferPlan } from "@/lib/data/transfer-plan-lock";
import { DRS_TASKS, drsWorkflowGate } from "@/lib/data/drs-workflow";
import {
  readDrsWorkflowTasks,
  syncDrsWorkflowTasks,
} from "@/lib/data/drs-workflow-store";
import {
  syncPartialAcatExecutionTasks,
  PARTIAL_ACAT_EXECUTION_TASKS,
} from "@/lib/data/decision-case-workflow";
import {
  AcatStatusError,
  getAcatStatus,
  getAcatStatusByRecordId,
} from "@/lib/data/acat-status";
import {
  LINK_ERRORS,
  normalizeAcatTransferId,
  setManualAcatLinkWithinScope,
  planAcatLinkChange,
} from "@/lib/data/acat-link";
import {
  diffTransferInput,
  toTransferInput,
  transferToFormValues,
  type TransferFormValues,
} from "@/components/transfers/transfer-form";
import { scheduleCrmIdentityReconciliation } from "@/lib/crm/post-commit-signal";

// T3 server actions (WO ticket) — the transfer domain's write surface, the
// deals D3 posture carried verbatim:
//  - identity ALWAYS comes from auth(), never from the client;
//  - every action is ONE withUserScope transaction, so the Postgres RLS write
//    policies police it — a VIEWER session cannot write even if the UI
//    misbehaves (the DB rejection surfaces as a clean form error, never 500);
//  - writeAudit runs in the SAME transaction as the row write (ADR-5): a
//    failed write leaves no orphan audit row, a failed audit rolls back;
//  - validation (the FROZEN validateTransferInput) fails BEFORE any write:
//    no row, no audit row;
//  - both human stage-change paths enforce saved approval, blocking decisions
//    and enabled readiness gates. DRS has its own Operations-owned workflow.
//    Successful changes audit transfer.stage_change {from, to} and reset
//    stage_entered_at (ADR-2); rejected changes write nothing;
//  - nothing here deletes anything (uncheck instead — ADR-3).

export type TransferActionResult = {
  ok: false;
  errors: TransferValidationError[];
};

/** ATW-02 intake recorded alongside an edit (flag `ASSET_TRANSFER_WORKSPACE`). */
export type TransferIntakeInput = {
  statementAccepted?: boolean;
  deliveringAccountType?: string;
  receivingAccountType?: string;
};

const INTAKE_REJECTED: TransferActionResult = {
  ok: false,
  errors: [{ field: "intake", message: "Your role cannot record statement or account-type checks." }],
};

const STATEMENT_BLOCKS_MAPPING: TransferActionResult = {
  ok: false,
  errors: [{ field: "form", message: "Accept the latest statement before linking an asset map." }],
};

const ACCOUNT_MATCH_REFUSED: TransferActionResult = {
  ok: false,
  errors: [{ field: "stage", message: "The delivering and receiving account types must match before this movement is submitted." }],
};

/**
 * setStage's gate rejection: the transition was refused with NO write or audit. `unmet`
 * lists the human-readable conditions still outstanding. Distinct from the
 * `{ ok: false, errors }` DB/validation failure and from the soft `warnings`
 * success — the toolbar renders each differently.
 */
export type StageBlockedResult = {
  ok: false;
  blocked: true;
  unmet: string[];
};

/** setStage succeeds with (possibly empty) soft-gate warnings. */
export type StageActionResult =
  | TransferActionResult
  | StageBlockedResult
  | { ok: true; warnings: string[] };

// Generic non-field failure the form/toolbar renders as a banner. An RLS
// rejection and a vanished row deliberately look the same to the caller.
const WRITE_REJECTED: TransferActionResult = {
  ok: false,
  errors: [
    {
      field: "form",
      message:
        "Save failed — the database rejected the change. The record may not exist, or your role may not have permission to write transfers.",
    },
  ],
};

const PAUSED_REJECTED: TransferActionResult = {
  ok: false,
  errors: [{ field: "form", message: PREPARATION_PAUSED }],
};

class PreparationPausedError extends Error {}

/** ATW-10 AC-76: an unresumed outcome pauses preparation actions. */
async function refuseWhilePaused(tx: Prisma.TransactionClient, transferId: string): Promise<void> {
  if (await preparationPausedFor(tx, transferId, outcomeRecordsEnabled())) throw new PreparationPausedError();
}

/** ATW-10 hard refusals that the unbound stage change keeps (AC-76, AC-84, AC-104). */
async function unboundStageRefusal(
  tx: Prisma.TransactionClient,
  current: { id: string; funding_type: string | null; funding_plan_approved_at: Date | null },
  to: TransferStage,
): Promise<StageBlockedResult | null> {
  if (await preparationPausedFor(tx, current.id, true)) {
    return { ok: false, blocked: true, unmet: [PREPARATION_PAUSED] };
  }
  if (to !== "FUNDED" || (current.funding_type !== "ACAT_FULL" && current.funding_type !== "ACAT_PARTIAL")) return null;
  const latestReceipt = await tx.transferReceipt.findFirst({
    where: { transfer_id: current.id },
    orderBy: { version: "desc" },
    select: { partial: true },
  });
  if (receiptBlocksFunded(true, latestReceipt)) {
    return { ok: false, blocked: true, unmet: [FUNDED_REQUIRES_RECEIPT] };
  }
  if (rejectionBlocksFunded(true, await readLatestRejection(tx, current.id), current.funding_plan_approved_at)) {
    return { ok: false, blocked: true, unmet: [FUNDED_REQUIRES_REAPPROVAL] };
  }
  return null;
}

const FUNDED_REQUIRES_RECEIPT = "Confirm the full arrival before marking this transfer Funded.";
const FUNDED_REQUIRES_REAPPROVAL = "Approve the revised funding plan before marking this transfer Funded.";

async function identityFromSession(): Promise<Identity> {
  const session = await auth();
  if (!session?.user) redirect("/");
  return {
    role: (session.user as { role?: string }).role ?? "VIEWER",
    email: session.user.email ?? null,
  };
}

function revalidateTransfer(id?: string): void {
  revalidatePath("/asset-transfer");
  if (id) revalidatePath(`/asset-transfer/${id}`);
}

const STAGE_GATE_INCLUDE = {
  tasks: { select: { title: true, done: true, override_done: true, sort_order: true } },
  decision_cases: {
    where: { status: { in: ["OPEN", "SNOOZED"] }, blocks_transfer: true },
    select: { id: true, question: true },
  },
} satisfies Prisma.TransferInclude;

type StageGateTransfer = Prisma.TransferGetPayload<{ include: typeof STAGE_GATE_INCLUDE }>;

type StageGateResult = {
  blocked: StageBlockedResult | null;
  dealFlags: { statements: boolean; asset_mapped: boolean } | null;
  softWarnings: string[];
};

/**
 * Both the toolbar and edit form must enforce the same current stage gates.
 * With `soft` (ATW-10 unbound stage change, AC-92, AC-93) the gates the
 * presentation does not bind become warnings; the DRS role refusal and the
 * non-writer refusal stay hard.
 */
async function stageTransitionGate(
  tx: Prisma.TransactionClient,
  current: StageGateTransfer,
  to: TransferStage,
  identity: Identity,
  soft = false,
): Promise<StageGateResult> {
  const from = current.stage as TransferStage;
  const softWarnings: string[] = [];
  const unbound = (
    unmet: string[],
    dealFlags: StageGateResult["dealFlags"],
  ): StageGateResult | null => {
    if (!soft) return { blocked: { ok: false, blocked: true, unmet }, dealFlags, softWarnings };
    softWarnings.push(...unmet);
    return null;
  };
  if (current.archived_at) {
    const result = unbound(["Archived transfers are read-only."], null);
    if (result) return result;
  }
  // DRS is a separate securities-transfer workflow. Its required work and
  // Apex confirmations govern advancement independently of legacy flags.
  if (current.funding_type === "DRS") {
    if (!canApproveFundingPlan(identity.role)) {
      return {
        blocked: {
          ok: false as const,
          blocked: true as const,
          unmet: ["Operations must record DRS stage changes."],
        },
        dealFlags: null,
        softWarnings,
      };
    }
    const tasks = await readDrsWorkflowTasks(tx, {
      transferId: current.id,
      fundingPlanVersion: current.funding_plan_version,
    });
    const gate = drsWorkflowGate({
      from,
      to,
      fundingPlanComplete: current.funding_plan_complete,
      fundingPlanVersion: current.funding_plan_version,
      tasks,
      blockingExceptions: current.decision_cases?.length ?? 0,
      methodChangePending: current.drs_method_change_pending,
    });
    if (gate.blocked) {
      const result = unbound(gate.unmet, null);
      if (result) return result;
    }
    return { blocked: null, dealFlags: null, softWarnings };
  }
  if (!canWriteTransfers(identity.role)) {
    return {
      blocked: { ok: false as const, blocked: true as const, unmet: ["Your role cannot change transfer stages."] },
      dealFlags: null,
      softWarnings,
    };
  }
  const forward = STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(from);
  // Preparation checklist facts and soft warnings share one linked-deal
  // lookup. Other stages have no synced checklist titles and use raw task state.
  const dealFlags =
    from === "DECISION" && current.deal_id
      ? await tx.deal.findUnique({
          where: { id: current.deal_id },
          select: { statements: true, asset_mapped: true },
        })
    : null;

  // A reviewed route change cannot reuse initiation facts from the old rail.
  // Partial execution is verified through its own work; other non-DRS routes
  // require the explicit new-method initiation confirmation action.
  let revisedPartialReady = false;
  if (forward && current.funding_route_change_pending) {
    const required = to === "FUNDED" ? PARTIAL_ACAT_EXECUTION_TASKS : PARTIAL_ACAT_EXECUTION_TASKS.slice(0, 2);
    const tasks = current.funding_type === "ACAT_PARTIAL" ? await tx.decisionTask.findMany({ where: {
      transfer_id: current.id, decision_id: null,
      source_key: { in: required.map((task) => `asset-transfer:${current.id}:standard-partial-acat:${task.key}`) },
    } }) : [];
    const gate = fundingRouteChangeGate({
      transferId: current.id, pending: true, fundingType: current.funding_type,
      acatLinked: acatLinkedFromIds(current.acat_transfer_id, current.acat_record_id), from, to, tasks,
    });
    if (gate.blocked) {
      const result = unbound(gate.unmet, dealFlags);
      if (result) return result;
    } else {
      revisedPartialReady = true;
    }
  }

  // Blocking judgments apply to every forward move, including a skipped stage
  // and later-stage completion. Checklist completion cannot resolve a case.
  if (
    forward &&
    (current.decision_cases?.length ?? 0) > 0
  ) {
    const result = unbound(
      current.decision_cases.map((decision) => `Resolve Decision Center item: ${decision.question}`),
      dealFlags,
    );
    if (result) return result;
  }

  // Approval is independent of readiness flags and checklist completion.
  // A legacy completion boolean is not a versioned approval at any forward
  // boundary. Operations must explicitly approve older In transfer plans
  // before they become Funded; no historical approval is inferred or backfilled.
  if (forward && (
    !current.funding_plan_complete ||
    !Number.isInteger(current.funding_plan_version) || current.funding_plan_version < 1
  )) {
    const message = from === "DECISION"
      ? "Approve the current funding plan before advancing."
      : current.funding_plan_version > 0 && !current.funding_plan_complete
        ? "Operations must review the invalidated funding plan. Return this transfer to Preparation and approve the current plan before advancing."
        : "Operations must review and approve the current funding plan before marking this transfer Funded.";
    const result = unbound([message], dealFlags);
    if (result) return result;
  }

  // Checklist-as-gate takes precedence over legacy readiness facts only.
  // Approval and blocking decisions above remain independent requirements.
  // Blocks a FORWARD move while any VISIBLE,
  // RESOLVED task of the `from` stage is open; the same visible+resolved set
  // the detail checklist shows, so UI and gate never disagree. Vacuously
  // satisfied when the stage has no visible tasks (never hard-block a transfer
  // with no checklist for its stage).
  if (checklistStageGateEnabled()) {
    const visResolved = stageChecklistTasks(
      from,
      current.tasks,
      current.funding_type as FundingType | null,
    ).map((t) => ({ title: t.title, done: resolveTaskDone(t, dealFlags) }));
    const gate = checklistGateBlock(from, to, visResolved);
    if (gate.blocked) {
      const result = unbound(gate.unmet, dealFlags);
      if (result) return result;
    }
  }

  // Legacy readiness applies on every Decision exit when enabled and the
  // checklist gate is disabled. Skipping In transfer cannot bypass it.
  // `acat_linked` is the #151 reconciliation:
  // both link columns are BY CONSTRUCTION real, unique tracker ids (the
  // only writer is the hardened AcatLinkPicker / acat-link.ts path, which
  // refuses blanks/placeholders and is backed by the two partial unique
  // indexes), so the derivation is the pure `acatLinkedFromIds` null-check
  // — record id (primary, covers UUID-less "N/A" records) OR legacy UUID —
  // NOT `acat_transfer_id.trim() !== "" && !== "N/A"`.
  if (
    !checklistStageGateEnabled() &&
    transferDealSourcedRedesignEnabled() &&
    from === "DECISION" &&
    forward
  ) {
    const acat_linked = acatLinkedFromIds(
      current.acat_transfer_id,
      current.acat_record_id,
    );
    const gate = hardGateBlock(
      {
        accounts_opened_at_apex: current.accounts_opened_at_apex,
        funding_plan_complete: current.funding_plan_complete,
        funding_initiated: revisedPartialReady || current.funding_initiated,
        cash_in_flight: current.cash_in_flight,
        funding_type: current.funding_type as FundingType | null,
        acat_linked,
      },
      from,
      to,
    );
    if (gate.blocked) {
      // The transition never happened: NO transfer.update, NO writeAudit.
      const result = unbound(gate.unmet, dealFlags);
      if (result) return result;
    }
  }

  return { blocked: null, dealFlags, softWarnings };
}

// ---------------------------------------------------------------------------
// Either-id ACAT routing (fix/acat-link-either-id). The edit form's free-text
// ACAT field used to write VERBATIM into acat_transfer_id (the Apex UUID
// column) — pasting a tracker RECORD id there stored a cuid in the UUID
// column, the detail page's by-UUID read 404'd, and the linked ACAT silently
// "disappeared". Now the submitted value is SHAPE-ROUTED and VERIFIED against
// the tracker BEFORE any write (fail closed — an unverified id is never
// stored):
//   • non-UUID shape → getAcatStatusByRecordId → acat_record_id (+ the
//     record's real UUID when the projection carries one, D2-normalized);
//   • UUID shape     → getAcatStatus → acat_transfer_id (acat_record_id is
//     left as stored);
//   • blank          → explicit unlink: BOTH columns cleared;
//   • unchanged (matches EITHER stored column) → no tracker call, no write.
// The verification runs OUTSIDE the write transaction (never an external HTTP
// call inside a tx); in dev, ACAT_FIXTURE=1 serves the bundled fixtures so the
// flow works offline. The two partial unique indexes backstop duplicate-link
// races — a lost race throws P2002, mapped to the friendly "already linked"
// error below (the acat-tracking classifyWriteError posture).
// ---------------------------------------------------------------------------

type AcatLinkColumns = {
  acat_record_id: string | null;
  acat_transfer_id: string | null;
};

type AcatLinkResolution =
  | { ok: true; link: AcatLinkColumns | null } // null = unchanged, don't touch
  | { ok: false; errors: TransferValidationError[] };

async function resolveAcatLink(
  submitted: string,
  stored: AcatLinkColumns,
): Promise<AcatLinkResolution> {
  const plan = planAcatLinkChange(submitted, stored);
  if (plan.kind === "unchanged") return { ok: true, link: null };
  if (plan.kind === "clear") {
    return { ok: true, link: { acat_record_id: null, acat_transfer_id: null } };
  }
  try {
    if (plan.kind === "verify_record") {
      const status = await getAcatStatusByRecordId(plan.id);
      if (!status) return { ok: false, errors: [LINK_ERRORS.ACAT_NOT_FOUND] };
      return {
        ok: true,
        link: {
          acat_record_id: plan.id,
          // The by-record projection carries acatTransferId; store it only
          // when REAL (D2 — ""/"N/A"/placeholders normalize to null).
          acat_transfer_id: normalizeAcatTransferId(status.acatTransferId),
        },
      };
    }
    const status = await getAcatStatus(plan.id);
    if (!status) return { ok: false, errors: [LINK_ERRORS.ACAT_NOT_FOUND] };
    return {
      ok: true,
      link: {
        // A genuine relink-by-UUID must CLEAR any stored record id: reads are
        // record-id-first, so a stale record id would WIN and keep showing the
        // OLD ACAT after a verified save — the exact wrong-ACAT class this fix
        // exists to kill. The by-UUID projection carries no record id to
        // substitute (re-linking via the picker restores one).
        acat_record_id: null,
        // Store the tracker's canonical id when it echoes one (case-variant
        // input would otherwise miss the UUID-keyed board-chip lookup).
        acat_transfer_id: normalizeAcatTransferId(status.acatTransferId) ?? plan.id,
      },
    };
  } catch (e) {
    // AcatStatusError (401/5xx/transport) — the data layer already logged a
    // static marker. Fail CLOSED: friendly field error, nothing written.
    // Anything else is a PROGRAMMING error — rethrow so it stays loud instead
    // of masquerading as "tracker unreachable".
    if (e instanceof AcatStatusError) {
      return { ok: false, errors: [LINK_ERRORS.ACAT_UNVERIFIED] };
    }
    throw e;
  }
}

/** Map a caught transfer-write error: P2002 on the partial ACAT unique indexes
 *  (a lost duplicate-link race) → the friendly "already linked" field error;
 *  anything else keeps the generic WRITE_REJECTED posture. */
class ManualAcatLinkRejected extends Error {
  constructor(readonly result: TransferActionResult) { super("manual_acat_link_rejected"); }
}

function transferWriteErrorResult(e: unknown): TransferActionResult {
  if (e instanceof ManualAcatLinkRejected) return e.result;
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === "P2002"
  ) {
    return { ok: false, errors: [LINK_ERRORS.ACAT_ALREADY_LINKED] };
  }
  return WRITE_REJECTED;
}

/**
 * Create an APP-sourced transfer and seed the chosen stage's DEFAULT_TASKS
 * checklist (ADR-3) — row + tasks + transfer.create audit in one transaction.
 */
export async function createTransfer(
  values: TransferFormValues,
  intake?: ConnectedIntakeInput,
): Promise<TransferActionResult | void> {
  const identity = await identityFromSession();

  const input = toTransferInput(values);
  const result = validateTransferInput(input);
  if (!result.ok) return { ok: false, errors: result.errors }; // no row, no audit
  if (intake && (!assetTransferWorkspaceEnabled() || !canWriteTransfers(identity.role))) return WRITE_REJECTED;
  if (!intake && assetTransferWorkspaceEnabled()) {
    return { ok: false, errors: [{ field: "client", message: "Choose a client from the client directory." }] };
  }
  if (intake && (typeof intake.clientSfId !== "string" || !intake.clientSfId.trim())) {
    return { ok: false, errors: [{ field: "client", message: "Choose a client from the client directory." }] };
  }

  // Either-id ACAT routing: shape-detect + verify the submitted id against the
  // tracker BEFORE the write (nothing stored yet, so both columns compare as
  // null). A 404/unreachable verification fails the whole create — no row.
  const acat = await resolveAcatLink(values.acat_transfer_id, {
    acat_record_id: null,
    acat_transfer_id: null,
  });
  if (!acat.ok) return { ok: false, errors: acat.errors };
  const acatLink = acat.link ?? {
    acat_record_id: null,
    acat_transfer_id: null,
  };

  let created: { ok: true; id: string } | { ok: false; errors: { field: string; message: string }[] };
  try {
    created = await withUserScope(identity, async (tx) => {
      let plan: ConnectedIntake | null = null;
      let assetMapKey: AssignableAssetMapAccountKey | null = null;
      let linked: { client: NonNullable<Awaited<ReturnType<typeof readDirectoryClient>>>; deal: { id: string; sfDealId: string | null; amount: number } | null } | null = null;
      if (intake) {
        const client = await readDirectoryClient(tx, intake.clientSfId);
        if (!client) return { ok: false as const, errors: [{ field: "client", message: "Choose a client from the client directory." }] };
        const dealId = typeof intake.dealId === "string" ? intake.dealId.trim() : "";
        const deal = dealId ? (await readDealOptions(tx, client.sfId, client.householdSfId)).find((option) => option.id === dealId) ?? null : null;
        if (dealId && !deal) return { ok: false as const, errors: [{ field: "dealId", message: "Choose one of this client's open deals." }] };
        if (deal?.linkedTransferId) {
          return { ok: false as const, errors: [{ field: "dealId", message: `That deal is already linked to transfer ${deal.linkedTransferId}.` }] };
        }
        if (deal?.clientSfId && deal.clientSfId.slice(0, 15).toUpperCase() !== client.sfId.slice(0, 15).toUpperCase()) {
          return { ok: false as const, errors: [{ field: "dealId", message: "That deal belongs to a different client." }] };
        }
        const assetMapId = intake.sourceMode === "asset_map" && typeof intake.assetMapAccountId === "string" ? intake.assetMapAccountId.trim() : "";
        const assetMap = assetMapId && assetMapTransferLinkEnabled() && canReviewAssetMapLinks(identity.role)
          ? await readAssetMapSourceFacts(tx, assetMapId, { clientSfId: client.sfId, householdSfId: client.householdSfId })
          : null;
        const custodianId = typeof intake.deliveringCustodianId === "string" ? intake.deliveringCustodianId.trim() : "";
        const custodian = custodianId ? await readCustodianOption(tx, custodianId) : null;
        const rows = await clientIntakeRows(tx, client.sfId, client.firstName, client.lastName);
        const valid = validateConnectedIntake(intake, {
          clientName: client.name,
          deal,
          assetMap: assetMap?.facts ?? null,
          apexReceiving: openApexReceivingOptions(await readApexAccountRows(tx, client.sfId)),
          custodian,
        });
        if (!valid.ok) return { ok: false as const, errors: valid.errors };
        const { institution, type, last4, title } = valid.value.source;
        const overlap = institution && last4 ? overlappingTransfer(rows, { institution, type: type ?? "", last4, title: title ?? "" }) : null;
        if (overlap) {
          return { ok: false as const, errors: [{ field: "sourceMode", message:
            `Transfer ${overlap} is already moving this source account. Complete or stop it before opening another.` }] };
        }
        plan = valid.value;
        assetMapKey = intake.sourceMode === "asset_map" ? assetMap?.key ?? null : null;
        linked = { client, deal: deal ? { id: deal.id, sfDealId: deal.sfDealId, amount: deal.amount } : null };
      }
      const transfer = await tx.transfer.create({
        data: {
          ...(plan ? {
            transferring_firm: plan.source.institution,
            delivering_custodian_id: plan.custodianId,
            source_account_type: plan.source.type,
            source_account_last4: plan.source.last4,
            source_account_title: plan.source.title || null,
            receiving_account_type: plan.receiving.type || null,
            receiving_account_title: plan.receiving.title || null,
            funding_type: plan.fundingType,
            accounts: { create: [{
              label: plan.receiving.label,
              status: plan.receiving.open ? "OPEN" as const : "TO_OPEN" as const,
              opened_at: plan.receiving.open ? new Date() : null,
            }] },
          } : {}),
          ...(linked?.deal ? { deal_id: linked.deal.id, deal_sf_id: linked.deal.sfDealId } : {}),
          ...(assetMapKey ? {
            asset_map_folder_id: assetMapKey.sourceFolderId,
            asset_map_custodian: assetMapKey.custodian,
            asset_map_account_number: assetMapKey.accountNumber,
            asset_map_account_type: assetMapKey.accountType,
          } : {}),
          source: input.source,
          client_first_name: linked ? linked.client.firstName || linked.client.name : input.client_first_name,
          client_last_name: linked ? linked.client.lastName : input.client_last_name,
          client_sf_id: linked ? linked.client.sfId : input.client_sf_id ?? null,
          household_name: linked ? linked.client.householdName : input.household_name ?? null,
          household_sf_id: linked ? linked.client.householdSfId : input.household_sf_id ?? null,
          value: linked?.deal ? linked.deal.amount : input.value,
          stage: input.stage,
          owner_kind: input.owner_kind,
          owner_name: input.owner_name ?? null,
          next_step: input.next_step ?? null,
          next_step_owner: input.next_step_owner ?? null,
          pending_nudge: input.pending_nudge ?? null,
          created_by: identity.email,
          updated_by: identity.email,
          // stage_entered_at: DB default now() — the record enters its
          // starting stage at creation (days-in-stage derives from it).
          tasks: {
            create: DEFAULT_TASKS[input.stage].map((title, i) => ({
              title,
              sort_order: i,
            })),
          },
        },
      });
      if (acatLink.acat_record_id != null || acatLink.acat_transfer_id != null) {
        const linked = await setManualAcatLinkWithinScope(tx, identity, {
          transferId: transfer.id,
          expectedVersion: transfer.acat_link_version,
          expectedRecordId: null,
          expectedTransferUuid: null,
          recordId: acatLink.acat_record_id,
          acatTransferId: acatLink.acat_transfer_id,
        });
        // Returning a failure here would commit the already-created row.
        if (!linked.ok) throw new ManualAcatLinkRejected(linked);
      }
      await writeAudit(tx, identity, {
        action: TRANSFER_CREATE,
        entityType: "transfer",
        entityId: transfer.id,
        detail: {
          stage: input.stage,
          value: input.value,
          source: input.source,
          ...(plan ? { fundingType: plan.fundingType, receivingAccountOpen: plan.receiving.open } : {}),
          ...(assetMapKey ? { assetMapFolderId: assetMapKey.sourceFolderId, assetMapLast4: plan?.source.last4 ?? null } : {}),
        },
      });
      return { ok: true as const, id: transfer.id };
    });
  } catch (e) {
    // VIEWER (or any non-write role) hits the RLS INSERT policy here; a lost
    // duplicate-ACAT race hits the partial unique index (P2002 → friendly).
    return transferWriteErrorResult(e);
  }
  if (!created.ok) return { ok: false, errors: created.errors };
  const createdId = created.id;

  // The transfer + audit have committed. Signal the idempotent reconciler only
  // now; the callback runs after the response and never extends the write tx.
  scheduleCrmIdentityReconciliation("transfer_action");
  revalidateTransfer(createdId);
  redirect(`/asset-transfer/${createdId}`);
}

/**
 * Edit-form update — read + diff + write + audit in ONE user-scoped
 * transaction. Emits transfer.update {changes}; when the stage differs, also
 * resets stage_entered_at and emits transfer.stage_change {from,to}. Stage
 * changes enforce the same decision/readiness gates as the toolbar.
 */
/** Fields the workspace takes from linked records; a typed edit cannot replace them. */
const LINKED_RECORD_FIELDS = [
  "client_first_name", "client_last_name", "client_sf_id", "household_name", "household_sf_id",
  "deal_id", "deal_sf_id", "transferring_firm",
] as const;

export async function updateTransfer(
  id: string,
  values: TransferFormValues,
  intake?: TransferIntakeInput,
): Promise<TransferActionResult | void> {
  const identity = await identityFromSession();

  // Pre-pass validation BEFORE any tracker call (source is pinned in-tx, but
  // toTransferInput always yields the legal "APP", so this rejects exactly the
  // same field errors as the in-tx validation below).
  const preCheck = validateTransferInput(toTransferInput(values));
  if (!preCheck.ok) return { ok: false, errors: preCheck.errors };

  // Either-id ACAT routing: read the STORED link, then plan + verify OUTSIDE
  // the write transaction (an external HTTP call must never ride a tx — the
  // ingest 5s-timeout lesson). An unchanged value makes NO tracker call.
  let stored: (AcatLinkColumns & { acat_link_version: number }) | null;
  try {
    stored = await withUserScope(identity, (tx) =>
      tx.transfer.findUnique({
        where: { id },
        select: { acat_record_id: true, acat_transfer_id: true, acat_link_version: true },
      }),
    );
  } catch {
    return WRITE_REJECTED;
  }
  if (!stored) return WRITE_REJECTED;
  const acat = await resolveAcatLink(values.acat_transfer_id, stored);
  if (!acat.ok) return { ok: false, errors: acat.errors }; // fail closed: no write
  const acatLink = acat.link; // null = unchanged → the columns stay untouched

  let outcome: TransferActionResult | undefined;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, id);
      const current = await tx.transfer.findUnique({
        where: { id },
        include: STAGE_GATE_INCLUDE,
      });
      if (!current) return WRITE_REJECTED;

      if (
        current.acat_link_version !== stored.acat_link_version ||
        current.acat_record_id !== stored.acat_record_id ||
        current.acat_transfer_id !== stored.acat_transfer_id
      ) {
        return {
          ok: false as const,
          errors: [{ field: "acat_transfer_id", message: "The ACAT link changed while you were editing. Refresh and review the current link." }],
        };
      }

      const before = toTransferInput(
        transferToFormValues({
          ...current,
          value: Number(current.value),
          source: current.source as "APP" | "IMPORT",
          stage: current.stage as TransferStage,
          owner_kind: current.owner_kind as TransferOwner,
        }),
      );
      before.source = current.source as "APP" | "IMPORT"; // never rewritten
      const input = toTransferInput(values);
      input.source = before.source;

      const result = validateTransferInput(input);
      if (!result.ok) return { ok: false as const, errors: result.errors };

      // The ACAT field is verification-ROUTED, not a verbatim column write:
      // drop its raw form diff (the field shows record-id-first, so a naive
      // string diff would be wrong for legacy rows) and rebuild the audit
      // entries for BOTH link columns from the verified resolution vs the
      // row's actual stored values — only the columns that really change.
      const changes: ReturnType<typeof diffTransferInput> & {
        acat_record_id?: { from: string | null; to: string | null };
      } = diffTransferInput(before, input);
      delete changes.acat_transfer_id;
      if (acatLink) {
        if (current.acat_record_id !== acatLink.acat_record_id) {
          changes.acat_record_id = {
            from: current.acat_record_id,
            to: acatLink.acat_record_id,
          };
        }
        if (current.acat_transfer_id !== acatLink.acat_transfer_id) {
          changes.acat_transfer_id = {
            from: current.acat_transfer_id,
            to: acatLink.acat_transfer_id,
          };
        }
      }
      const workspaceGates = assetTransferWorkspaceEnabled();
      if (workspaceGates) {
        const linked = LINKED_RECORD_FIELDS.filter((field) => field in changes);
        if (linked.length) {
          return {
            ok: false as const,
            errors: linked.map((field) => ({ field, message: "Link this from the client directory, a deal or the custodian library instead of typing it." })),
          };
        }
      }
      if (intake && workspaceGates) {
        if (!canRecordClientServiceTransferFact(identity.role)) return INTAKE_REJECTED;
        if (intake.statementAccepted !== undefined) {
          await acceptStatement(tx, identity, id, intake.statementAccepted, workspaceGates);
        }
        if (intake.deliveringAccountType !== undefined && intake.receivingAccountType !== undefined) {
          await saveAccountMatch(
            tx, identity, id, intake.deliveringAccountType, intake.receivingAccountType, workspaceGates,
          );
        }
      }

      if (Object.keys(changes).length === 0) return undefined; // no-op: no write, no audit noise

      const stageChanged = before.stage !== input.stage;
      const latestMatch = workspaceGates
        ? await tx.transferAccountMatch.findFirst({
            where: { transfer_id: id },
            orderBy: [{ created_at: "desc" }, { id: "desc" }],
            select: { delivering_account_type: true, receiving_account_type: true },
          })
        : null;
      const paperwork = workspaceGates && paperworkRecordsEnabled() && current.funding_type
        ? await readPaperworkRecords(tx, id)
        : null;
      const route = paperwork && current.funding_type
        ? routeLabel(current.funding_type, paperwork.appAuthorizationRecorded)
        : "";
      const titlesComplete = paperwork ? paperworkTitlesComplete(paperwork.latestFormReview) : false;
      const matchBlocked = accountMatchBlocks(
        workspaceGates,
        route,
        latestMatch?.delivering_account_type ?? null,
        latestMatch?.receiving_account_type ?? null,
        titlesComplete,
      );
      if (stageChanged && matchBlocked && input.stage !== "DECISION") return ACCOUNT_MATCH_REFUSED;
      if (stageChanged) {
        const { blocked } = await stageTransitionGate(
          tx,
          { ...current, ...(acatLink ?? {}) },
          input.stage,
          identity,
        );
        if (blocked) {
          return {
            ok: false as const,
            errors: blocked.unmet.map((message) => ({ field: "stage", message })),
          };
        }
      }
      if (acatLink) {
        const linked = await setManualAcatLinkWithinScope(tx, identity, {
          transferId: id,
          expectedVersion: current.acat_link_version,
          expectedRecordId: current.acat_record_id,
          expectedTransferUuid: current.acat_transfer_id,
          recordId: acatLink.acat_record_id,
          acatTransferId: acatLink.acat_transfer_id,
        });
        // No business fields have been written yet; a rejected guard is inert.
        if (!linked.ok) return linked;
      }
      await tx.transfer.update({
        where: { id },
        data: {
          client_first_name: input.client_first_name,
          client_last_name: input.client_last_name,
          client_sf_id: input.client_sf_id ?? null,
          household_name: input.household_name ?? null,
          household_sf_id: input.household_sf_id ?? null,
          value: input.value,
          stage: input.stage,
          ...(stageChanged ? { stage_entered_at: new Date() } : {}),
          ...(stageChanged && current.funding_route_change_pending && input.stage === "FUNDED"
            ? { funding_route_change_pending: false, drs_method_change_pending: false, funding_initiated: true } : {}),
          owner_kind: input.owner_kind,
          owner_name: input.owner_name ?? null,
          next_step: input.next_step ?? null,
          next_step_owner: input.next_step_owner ?? null,
          pending_nudge: input.pending_nudge ?? null,
          // The guarded manual seam above owns link columns and hold state.
          updated_by: identity.email,
        },
      });

      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: id,
        detail: { changes },
      });
      if (stageChanged) {
        await writeAudit(tx, identity, {
          action: TRANSFER_STAGE_CHANGE,
          entityType: "transfer",
          entityId: id,
          detail: { from: before.stage, to: input.stage },
        });

        // The edit form can change stage without going through setStage. When
        // the stage-checklist feature is live, keep this path from creating a
        // transfer whose current stage has no checklist (the legacy funded-
        // transfer failure mode). Backward moves retain the accumulated tasks;
        // only forward entry appends missing destination defaults.
        if (
          current.funding_type !== "DRS" && checklistStageGateEnabled() &&
          STAGE_ORDER.indexOf(input.stage) > STAGE_ORDER.indexOf(before.stage)
        ) {
          const toSeed = missingStageChecklistRows(
            id,
            input.stage,
            current.tasks,
          );
          if (toSeed.length > 0) {
            await tx.transferTask.createMany({ data: toSeed });
          }
        }
      }
      return undefined;
    });
  } catch (e) {
    // VIEWER's UPDATE matches no row under the RLS write policy (P2025);
    // a lost duplicate-ACAT race hits a partial unique index (P2002 →
    // friendly "already linked").
    return transferWriteErrorResult(e);
  }
  if (outcome) return outcome;

  revalidateTransfer(id);
  redirect(`/asset-transfer/${id}`);
}

/**
 * Stage transition — shared approval, exception and readiness gates with the
 * edit form. Backward moves preserve approval and accumulated work. Resets
 * stage_entered_at, audits transfer.stage_change {from,to}, and returns the
 * unmet-gate warnings for the toolbar's advisory banner.
 */
export async function setStage(
  id: string,
  to: TransferStage,
): Promise<StageActionResult> {
  const identity = await identityFromSession();
  if (!TRANSFER_STAGES.includes(to)) return WRITE_REJECTED;

  let result: StageActionResult;
  // Slack closeout (SLACK_TRANSFER_CLOSEOUT): captured ONLY when a NEW closeout
  // is seeded below, so an IN_TRANSFER re-entry neither re-seeds nor re-posts.
  // Fired AFTER the tx commits (ADR-4) — a webhook failure must not roll back the move.
  let closeoutPayload: CloseoutWebhookInput | null = null;
  try {
    result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, id);
      const current = await tx.transfer.findUnique({
        where: { id },
        include: {
          ...STAGE_GATE_INCLUDE,
          decisions: { select: { decision: true } },
          accounts: { select: { status: true } },
        },
      });
      if (!current) return WRITE_REJECTED;

      const from = current.stage as TransferStage;
      if (from === to) return { ok: true as const, warnings: [] }; // no-op

      const unboundStage = outcomeRecordsEnabled();
      const { blocked, dealFlags, softWarnings } = await stageTransitionGate(tx, current, to, identity, unboundStage);
      if (blocked) return blocked;
      if (unboundStage) {
        const refused = await unboundStageRefusal(tx, current, to);
        if (refused) return refused;
      }

      // deal-card mirror S2: resolve the synced tasks' done from the linked deal
      // (override_done ?? deal flag ?? done) so the advance warning matches the
      // checklist + board card. Reuses `dealFlags` fetched above.
      const resolvedTasks = current.tasks.map((t) => ({
        done: resolveTaskDone(t, dealFlags),
      }));

      // SOFT gates (ADR-2, locked): compute the advisory warnings from the
      // same structured data the GateStepper renders — then move anyway.
      const gateWarnings = current.funding_type === "DRS" ? [] : stageChangeWarnings(
        gateStatus({
          stage: from,
          tasks: resolvedTasks,
          decisions: current.decisions as { decision: TransferDecisionChoice }[],
          accounts: current.accounts as { status: TransferAccountStatus }[],
        }),
        from,
        to,
      );
      const warnings = [...new Set([...softWarnings, ...gateWarnings])];

      await tx.transfer.update({
        where: { id },
        data: {
          stage: to,
          stage_entered_at: new Date(), // reset on EVERY transition (ADR-2)
          ...(current.funding_route_change_pending && to === "FUNDED"
            ? { funding_route_change_pending: false, drs_method_change_pending: false, funding_initiated: true } : {}),
          updated_by: identity.email,
        },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_STAGE_CHANGE,
        entityType: "transfer",
        entityId: id,
        detail: { from, to },
      });
      if (unboundStage) await recordStageChange(tx, id, from, to);

      // Checklist-as-gate (CHECKLIST_STAGE_GATE): seed the DESTINATION stage's
      // default checklist on a forward move so the stage the transfer just
      // entered has something to gate on (tasks are otherwise seeded only at
      // create). Idempotent by title (skip any the transfer already carries);
      // append after the current max sort_order. No per-task audit — matches
      // createTransfer, and the stage-change audit above records the move.
      if (
        current.funding_type !== "DRS" && checklistStageGateEnabled() &&
        STAGE_ORDER.indexOf(to) > STAGE_ORDER.indexOf(from)
      ) {
        const toSeed = missingStageChecklistRows(id, to, current.tasks);
        if (toSeed.length > 0) {
          await tx.transferTask.createMany({ data: toSeed });
        }
      }

      // Slack closeout (SLACK_TRANSFER_CLOSEOUT): on entry into IN_TRANSFER, seed
      // the per-transfer closeout checklist (idempotent — skip if one already
      // exists, so a re-entry doesn't duplicate or re-post). Only on the
      // not-exists branch do we set closeoutPayload, which the post-commit block
      // below sends to n8n. `current` carries every transfer scalar (no explicit
      // select), so the payload builds from it directly.
      if (current.funding_type !== "DRS" && slackCloseoutEnabled() && from !== "IN_TRANSFER" && to === "IN_TRANSFER") {
        const existingCloseout = await tx.transferSlackCloseout.findUnique({
          where: { transfer_id: id },
          select: { id: true },
        });
        if (!existingCloseout) {
          await tx.transferSlackCloseout.create({ data: { transfer_id: id } });
          await tx.transferSlackItem.createMany({
            data: SLACK_CLOSEOUT_TEMPLATE.map((it) => ({
              transfer_id: id,
              item_key: it.item_key,
              label: it.label,
              sort: it.sort,
            })),
          });
          closeoutPayload = {
            transfer: {
              id,
              client_name:
                `${current.client_first_name} ${current.client_last_name}`.trim(),
              household_name: current.household_name,
              amount: Number(current.value),
              owner_kind: current.owner_kind,
              owner_name: current.owner_name,
            },
            checklist: SLACK_CLOSEOUT_TEMPLATE.map((it) => ({
              item_key: it.item_key,
              label: it.label,
              sort: it.sort,
              group: it.group,
              note: it.note,
            })),
            about: { householdSfId: current.household_sf_id, clientSfId: current.client_sf_id },
          };
        }
      }
      return { ok: true as const, warnings };
    });
  } catch {
    return WRITE_REJECTED;
  }

  if (result.ok) revalidateTransfer(id);
  // Post-commit, fire-and-forget (ADR-4): only when a NEW closeout was seeded.
  // postCloseoutWebhook never throws (logs internally), so it cannot affect the
  // committed stage move or this action's result.
  if (result.ok && closeoutPayload) await postCloseoutWebhook(closeoutPayload);
  return result;
}

/** Set up existing approved DRS records without inventing completed work. */
export async function initializeDrsWorkflow(
  transferId: string,
): Promise<TransferActionResult | { ok: true }> {
  const identity = await identityFromSession();
  if (!canApproveFundingPlan(identity.role) || !identity.email) return WRITE_REJECTED;
  try {
    const result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const current = await tx.transfer.findUnique({ where: { id: transferId } });
      if (!current || current.archived_at || current.funding_type !== "DRS" ||
          !current.funding_plan_complete || current.funding_plan_version < 1) {
        return WRITE_REJECTED;
      }
      const tasks = await readDrsWorkflowTasks(tx, {
        transferId,
        fundingPlanVersion: current.funding_plan_version,
      });
      // AC-37: the service-request record needs the returned signature. Runs
      // before the early return so a later signature still records it once.
      if (assetTransferWorkspaceEnabled() && paperworkRecordsEnabled()) {
        const paperwork = await readPaperworkRecords(tx, transferId);
        if (paperwork.returnedSignatureRecorded && !paperwork.drsServiceRequestRecorded) {
          const row = await tx.transferDrsServiceRequest.create({
            data: { transfer_id: transferId },
            select: { id: true },
          });
          await writeAudit(tx, identity, {
            action: TRANSFER_UPDATE,
            entityType: "transfer",
            entityId: transferId,
            detail: { paperworkRecord: "transfer_drs_service_request", recordId: row.id },
          });
        }
      }
      if (tasks.length === DRS_TASKS.length) return { ok: true as const };
      const drsTaskCount = await syncDrsWorkflowTasks(tx, identity, { transferId });
      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: transferId,
        detail: { drsChecklistInitialized: true, drsTaskCount },
      });
      return { ok: true as const };
    });
    if (result.ok) {
      revalidateTransfer(transferId);
      revalidatePath("/tasks");
    }
    return result;
  } catch {
    return WRITE_REJECTED;
  }
}

// ATW-04 paperwork records (AC-31..AC-35, AC-39). Client Service facts:
// both flags, the ATW-08 role list, an unarchived transfer, one child row and
// a same-transaction audit (ids + table name only; never form titles).
type PaperworkRecordTable =
  | "transfer_form_review"
  | "transfer_sent_packet"
  | "transfer_returned_signature"
  | "transfer_app_authorization"
  | "transfer_mailed_paperwork";

async function recordPaperwork(
  transferId: string,
  table: PaperworkRecordTable,
  insert: (
    tx: Prisma.TransactionClient,
    current: { funding_plan_approved_at: Date | null },
  ) => Promise<{ id: string; detail?: Record<string, boolean> } | null>,
): Promise<TransferActionResult | { ok: true }> {
  const identity = await identityFromSession();
  if (
    !(assetTransferWorkspaceEnabled() && paperworkRecordsEnabled()) ||
    !canRecordClientServiceTransferFact(identity.role) ||
    !identity.email ||
    typeof transferId !== "string" || !transferId.trim()
  ) return WRITE_REJECTED;
  try {
    const result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const current = await tx.transfer.findUnique({
        where: { id: transferId },
        select: { id: true, archived_at: true, funding_plan_approved_at: true },
      });
      if (!current || current.archived_at) return WRITE_REJECTED;
      const row = await insert(tx, current);
      if (!row) return WRITE_REJECTED;
      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: transferId,
        detail: { paperworkRecord: table, recordId: row.id, ...(row.detail ?? {}) },
      });
      return { ok: true as const };
    });
    if (result.ok) revalidateTransfer(transferId);
    return result;
  } catch {
    return WRITE_REJECTED;
  }
}

export type FormReviewInput = {
  reviewed: boolean;
  receivingFormTitle: string;
  sourceFormTitle: string;
  titleOwnersConfirmed: string | null;
  apexAccountId: string;
  formId: string;
};

const FORM_TITLE_MAX = 250;

export async function recordFormReview(
  transferId: string,
  input: FormReviewInput,
): Promise<TransferActionResult | { ok: true }> {
  if (
    !input || typeof input.reviewed !== "boolean" ||
    typeof input.receivingFormTitle !== "string" || typeof input.sourceFormTitle !== "string" ||
    typeof input.apexAccountId !== "string" || typeof input.formId !== "string" ||
    (input.titleOwnersConfirmed !== null && typeof input.titleOwnersConfirmed !== "string")
  ) return WRITE_REJECTED;
  const receiving = input.receivingFormTitle.trim();
  const source = input.sourceFormTitle.trim();
  const apexAccountId = input.apexAccountId.trim();
  const formId = input.formId.trim();
  if (receiving.length > FORM_TITLE_MAX || source.length > FORM_TITLE_MAX || !apexAccountId || !formId) {
    return WRITE_REJECTED;
  }
  const confirmed = input.titleOwnersConfirmed === formTitleVersion(receiving, source)
    ? input.titleOwnersConfirmed
    : null;
  return recordPaperwork(transferId, "transfer_form_review", async (tx, current) => {
    if (!current.funding_plan_approved_at) return null;
    const row = await tx.transferFormReview.create({
      data: {
        transfer_id: transferId,
        reviewed: input.reviewed,
        receiving_form_title: receiving,
        source_form_title: source,
        title_owners_confirmed: confirmed,
        apex_account_id: apexAccountId,
        form_id: formId,
      },
      select: { id: true },
    });
    return { id: row.id, detail: { reviewed: input.reviewed } };
  });
}

export async function recordSentPacket(transferId: string): Promise<TransferActionResult | { ok: true }> {
  return recordPaperwork(transferId, "transfer_sent_packet", async (tx) => {
    const { latestFormReview } = await readPaperworkRecords(tx, transferId);
    if (latestFormReview?.reviewed !== true) return null;
    return tx.transferSentPacket.create({ data: { transfer_id: transferId }, select: { id: true } });
  });
}

export async function recordReturnedSignature(transferId: string): Promise<TransferActionResult | { ok: true }> {
  return recordPaperwork(transferId, "transfer_returned_signature", (tx) =>
    tx.transferReturnedSignature.create({ data: { transfer_id: transferId }, select: { id: true } }));
}

export async function recordAppAuthorization(transferId: string): Promise<TransferActionResult | { ok: true }> {
  return recordPaperwork(transferId, "transfer_app_authorization", (tx) =>
    tx.transferAppAuthorization.create({ data: { transfer_id: transferId }, select: { id: true } }));
}

export async function recordMailedPaperwork(transferId: string): Promise<TransferActionResult | { ok: true }> {
  return recordPaperwork(transferId, "transfer_mailed_paperwork", (tx) =>
    tx.transferMailedPaperwork.create({ data: { transfer_id: transferId }, select: { id: true } }));
}

export type ReceiptActionResult =
  | { ok: true; stageNotice: string | null }
  | { ok: false; errors: ReceiptFieldError[] };

const RECEIPT_TRANSFER_SELECT = {
  id: true,
  stage: true,
  funding_type: true,
  funding_plan_approved_at: true,
  archived_at: true,
} as const;

async function recordOperationsReceiptFact(
  transferId: string,
  write: (
    tx: Prisma.TransactionClient,
    identity: Identity,
    transfer: ReceiptTransfer,
  ) => Promise<{ ok: true; moveTo: TransferStage | null } | { ok: false; errors: ReceiptFieldError[] }>,
): Promise<ReceiptActionResult> {
  const identity = await identityFromSession();
  if (
    !receiptRecordsEnabled() ||
    !canRecordOperationsOnlyTransferFact(identity.role) ||
    !identity.email ||
    typeof transferId !== "string" || !transferId.trim()
  ) return WRITE_REJECTED;
  let result: Awaited<ReturnType<typeof write>>;
  try {
    result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const transfer = await tx.transfer.findUnique({ where: { id: transferId }, select: RECEIPT_TRANSFER_SELECT });
      if (!transfer) return WRITE_REJECTED;
      return write(tx, identity, { ...transfer, funding_type: transfer.funding_type as FundingType | null });
    });
  } catch {
    return WRITE_REJECTED;
  }
  if (!result.ok) return result;
  revalidateTransfer(transferId);
  if (!result.moveTo) return { ok: true, stageNotice: null };
  const moved = await setStage(transferId, result.moveTo);
  if (moved.ok) return { ok: true, stageNotice: null };
  const reasons = "blocked" in moved ? moved.unmet : moved.errors.map((error) => error.message);
  return { ok: true, stageNotice: `Saved. The stage did not change: ${reasons.join("; ")}` };
}

/** AC-46, AC-47: Operations logs the ACAT submission, then the transfer moves to In transfer. */
export async function logTransferSubmission(
  transferId: string,
  input: SubmissionInput,
): Promise<ReceiptActionResult> {
  return recordOperationsReceiptFact(transferId, async (tx, identity, transfer) => {
    const saved = await logOperationsSubmission(tx, identity, transfer, input, true);
    return saved.ok ? { ok: true, moveTo: transfer.stage === "IN_TRANSFER" ? null : "IN_TRANSFER" } : saved;
  });
}

/** AC-48: a tracking update records progress without moving the stage. */
export async function recordTransferTracking(
  transferId: string,
  input: TrackingInput,
): Promise<ReceiptActionResult> {
  return recordOperationsReceiptFact(transferId, async (tx, identity, transfer) => {
    const saved = await saveTrackingUpdate(tx, identity, transfer, input, true);
    return saved.ok ? { ok: true, moveTo: null } : saved;
  });
}

/** AC-50..AC-53, AC-80: saves a receipt version; a verified save moves the transfer to Funded. */
export async function saveTransferReceipt(
  transferId: string,
  input: ReceiptInput,
): Promise<ReceiptActionResult> {
  return recordOperationsReceiptFact(transferId, async (tx, identity, transfer) => {
    const saved = await confirmArrival(tx, identity, transfer, input, true);
    return saved.ok ? { ok: true, moveTo: saved.funded ? "FUNDED" : null } : saved;
  });
}

export type ChannelActionResult =
  | { ok: true }
  | { ok: false; errors: ChannelFieldError[] };

async function recordChannelFact(
  transferId: string,
  write: (tx: Prisma.TransactionClient, identity: Identity, transfer: ChannelTransfer) => Promise<ChannelWriteResult>,
): Promise<ChannelActionResult> {
  const identity = await identityFromSession();
  if (
    !channelRecordsEnabled() ||
    !canRecordClientServiceTransferFact(identity.role) ||
    !identity.email ||
    typeof transferId !== "string" || !transferId.trim()
  ) return WRITE_REJECTED;
  try {
    const result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const transfer = await tx.transfer.findUnique({
        where: { id: transferId },
        select: { id: true, stage: true, funding_type: true, archived_at: true },
      });
      if (!transfer) return WRITE_REJECTED;
      return write(tx, identity, { ...transfer, funding_type: transfer.funding_type as FundingType | null });
    });
    if (!result.ok) return result;
    revalidateTransfer(transferId);
    return { ok: true };
  } catch {
    return WRITE_REJECTED;
  }
}

/** AC-55, AC-56, AC-100: records an Apex check ticket; the cash stays unreceived. */
export async function saveCheckTicket(transferId: string, input: CheckTicketInput): Promise<ChannelActionResult> {
  return recordChannelFact(transferId, (tx, identity, transfer) =>
    recordCheckTicket(tx, identity, transfer, input, true));
}

/** AC-57, AC-58: records the ACH initiation and sets In transfer. */
export async function saveAchInitiation(transferId: string, input: AchInitiationInput): Promise<ChannelActionResult> {
  return recordChannelFact(transferId, (tx, identity, transfer) =>
    recordAchInitiation(tx, identity, transfer, input, true));
}

export type FollowUpActionResult =
  | { ok: true }
  | { ok: false; errors: FollowUpFieldError[] };

async function recordFollowUpFact(
  transferId: string,
  allowed: (role: string | null | undefined) => boolean,
  write: (tx: Prisma.TransactionClient, identity: Identity, transfer: FollowUpTransfer) => Promise<FollowUpWriteResult>,
): Promise<FollowUpActionResult> {
  const identity = await identityFromSession();
  if (
    !followUpRecordsEnabled() ||
    !allowed(identity.role) ||
    !identity.email ||
    typeof transferId !== "string" || !transferId.trim()
  ) return WRITE_REJECTED;
  try {
    const result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const transfer = await tx.transfer.findUnique({
        where: { id: transferId },
        select: { id: true, funding_type: true, archived_at: true },
      });
      if (!transfer) return WRITE_REJECTED;
      return write(tx, identity, { ...transfer, funding_type: transfer.funding_type as FundingType | null });
    });
    if (!result.ok) return result;
    revalidateTransfer(transferId);
    return { ok: true };
  } catch {
    return WRITE_REJECTED;
  }
}

/**
 * AC-62: Operations records reimbursement of an evidenced fee, tied to one of
 * the linked client's Operations fee requests.
 */
export async function saveFeeReimbursement(
  transferId: string,
  input: { evidenced: boolean; feeRequestId: string },
): Promise<FollowUpActionResult> {
  const feeRequestId = typeof input?.feeRequestId === "string" ? input.feeRequestId.trim() : "";
  return recordFollowUpFact(transferId, canRecordOperationsOnlyTransferFact, async (tx, identity, transfer) => {
    const client = await tx.transfer.findUnique({ where: { id: transfer.id }, select: { client_sf_id: true } });
    const offered = client?.client_sf_id ? (await readClientFeeRequests(tx, client.client_sf_id)).requests : [];
    if (!feeRequestId || !offered.some((request) => request.id === feeRequestId)) {
      return { ok: false, errors: [{ field: "feeRequestId", message: "Choose the client's Operations fee request this reimburses." }] };
    }
    return recordFeeReimbursement(tx, identity, transfer, { evidenced: input.evidenced, operationsFeeRequestId: feeRequestId }, true);
  });
}

/** AC-63: links one of the linked client's Trade Requests, shown read-only on the movement. */
export async function saveInvestmentLink(
  transferId: string,
  input: { requestId: string },
): Promise<FollowUpActionResult> {
  const requestId = typeof input?.requestId === "string" ? input.requestId.trim() : "";
  if (!followUpRecordsEnabled() || !requestId || typeof transferId !== "string" || !transferId.trim()) return WRITE_REJECTED;
  const identity = await identityFromSession();
  if (!canRecordOperationsOnlyTransferFact(identity.role)) return WRITE_REJECTED;
  let clientSfId: string | null;
  try {
    clientSfId = await withUserScope(identity, async (tx) =>
      (await tx.transfer.findUnique({ where: { id: transferId }, select: { client_sf_id: true } }))?.client_sf_id ?? null);
  } catch {
    return WRITE_REJECTED;
  }
  const trades = await getClientTradeRequests(identity, clientSfId);
  if (trades.state !== "ready") {
    return { ok: false, errors: [{ field: "requestId", message: trades.state === "unlinked"
      ? "Link the client before linking a Trade Request."
      : "Trade Requests could not be read. Try again." }] };
  }
  if (!trades.requests.some((request) => request.id === requestId)) {
    return { ok: false, errors: [{ field: "requestId", message: "Choose one of the client's Trade Requests." }] };
  }
  return recordFollowUpFact(transferId, canRecordOperationsOnlyTransferFact, (tx, followUpIdentity, transfer) =>
    linkInvestmentRequest(tx, followUpIdentity, transfer, { requestId }, true));
}

/** AC-65, AC-101: a residual tied to a recorded control number. */
export async function saveResidual(
  transferId: string,
  input: { originalControlNumber: string; trackerStage: string },
): Promise<FollowUpActionResult> {
  return recordFollowUpFact(transferId, canRecordOperationsOnlyTransferFact, (tx, identity, transfer) =>
    recordResidual(tx, identity, transfer, input, true));
}

/** AC-67, AC-82, AC-83: records an ACAT rejection and pauses arrival. */
export async function saveAcatRejection(
  transferId: string,
  input: RejectionInput,
): Promise<FollowUpActionResult> {
  return recordFollowUpFact(transferId, canRecordOperationsOnlyTransferFact, (tx, identity, transfer) =>
    recordAcatRejection(tx, identity, transfer, input, true));
}

/** AC-68: the follow-up owner, who may be Client Service, saves the response. */
export async function respondToAcatRejection(
  transferId: string,
  input: { response: string },
): Promise<FollowUpActionResult> {
  return recordFollowUpFact(transferId, canRecordClientServiceTransferFact, (tx, identity, transfer) =>
    saveRejectionResponse(tx, identity, transfer, input, true));
}

/** AC-69: Operations accepts the resolution, reopening the submission path. */
export async function acceptAcatRejection(transferId: string): Promise<FollowUpActionResult> {
  return recordFollowUpFact(transferId, canRecordOperationsOnlyTransferFact, (tx, identity, transfer) =>
    acceptRejectionResolution(tx, identity, transfer, true));
}

export type OutcomeActionResult = FollowUpActionResult;

async function recordOutcomeFact(
  transferId: string,
  write: (
    tx: Prisma.TransactionClient,
    identity: Identity,
    transfer: { id: string; archived_at: Date | null },
  ) => Promise<OutcomeWriteResult>,
): Promise<OutcomeActionResult> {
  const identity = await identityFromSession();
  if (
    !outcomeRecordsEnabled() ||
    !canWriteTransfers(identity.role) ||
    !identity.email ||
    typeof transferId !== "string" || !transferId.trim()
  ) return WRITE_REJECTED;
  try {
    const result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const transfer = await tx.transfer.findUnique({
        where: { id: transferId },
        select: { id: true, archived_at: true },
      });
      if (!transfer) return WRITE_REJECTED;
      return write(tx, identity, transfer);
    });
    if (!result.ok) return result;
    revalidateTransfer(transferId);
    return { ok: true };
  } catch {
    return WRITE_REJECTED;
  }
}

/** AC-71..AC-73, AC-75, AC-102, AC-103: records a movement outcome. */
export async function saveTransferOutcome(
  transferId: string,
  input: { outcome: string; reason: string; followUpOn: string; outcomeOn: string },
): Promise<OutcomeActionResult> {
  return recordOutcomeFact(transferId, (tx, identity, transfer) =>
    recordOutcome(tx, identity, transfer, input, true));
}

/** AC-73: Resume transfer ends a deferral. */
export async function resumeDeferredTransfer(transferId: string): Promise<OutcomeActionResult> {
  return recordOutcomeFact(transferId, (tx, identity, transfer) => resumeTransfer(tx, identity, transfer, true));
}

/** AC-78: appends a correction to the movement history. */
export async function saveTransferCorrection(
  transferId: string,
  input: { correction: string },
): Promise<OutcomeActionResult> {
  return recordOutcomeFact(transferId, (tx, identity, transfer) =>
    recordCorrection(tx, identity, transfer, input, true));
}

export type ReceiptComparisonResult =
  | { ok: true; lines: ReceiptLineDraft[] }
  | { ok: false; errors: ReceiptFieldError[] };

/** AC-36: the holdings this transfer expects to arrive, read under the caller's row security. */
async function expectedReceiptFor(
  identity: Identity,
  transferId: string,
): Promise<{ ok: true; expected: ExpectedReceiptLine[] } | { ok: false; result: ReceiptComparisonResult }> {
  const transfer = await withUserScope(identity, (tx) => tx.transfer.findUnique({
    where: { id: transferId },
    select: {
      funding_type: true,
      asset_map_folder_id: true,
      asset_map_custodian: true,
      asset_map_account_number: true,
      asset_map_account_type: true,
      decisions: { select: { symbol: true, decision: true } },
    },
  }));
  if (!transfer) return { ok: false, result: WRITE_REJECTED };
  const fundingType = transfer.funding_type as FundingType | null;
  if (!transfer.asset_map_folder_id || !transfer.asset_map_custodian) {
    return { ok: false, result: { ok: false, errors: [{ field: "file", message: "Link an asset map before comparing the receipt." }] } };
  }
  const key = {
    folderId: transfer.asset_map_folder_id,
    custodian: transfer.asset_map_custodian,
    accountNumber: transfer.asset_map_account_number,
    accountType: transfer.asset_map_account_type,
  };
  const detail = await getAssignedAssetMapDetail(identity, key);
  const transferring = fundingType === "ACAT_PARTIAL"
    ? await getPartialAcatPositions(identity, { transferId, ...key })
    : null;
  const expected = expectedReceiptLines(fundingType, detail?.positions ?? [], transfer.decisions, transferring);
  if (expected.length === 0) {
    return { ok: false, result: { ok: false, errors: [{ field: "file", message: "No expected holdings were found for this transfer." }] } };
  }
  return { ok: true, expected };
}

/** AC-49, AC-79: compares an uploaded custodian file to the expected holdings. Saves nothing. */
export async function applyReceiptComparison(
  transferId: string,
  csvText: string,
): Promise<ReceiptComparisonResult> {
  const identity = await identityFromSession();
  if (
    !receiptRecordsEnabled() ||
    !canRecordOperationsOnlyTransferFact(identity.role) ||
    typeof transferId !== "string" || !transferId.trim() ||
    typeof csvText !== "string" || csvText.length > 1_000_000
  ) return WRITE_REJECTED;
  const parsed = parseReceiptCsv(csvText);
  if (!parsed.ok) return { ok: false, errors: [{ field: "file", message: parsed.message }] };
  try {
    const loaded = await expectedReceiptFor(identity, transferId);
    if (!loaded.ok) return loaded.result;
    return { ok: true, lines: compareReceipt(loaded.expected, parsed.lines) };
  } catch {
    return WRITE_REJECTED;
  }
}

export type SampleReceiptResult = { ok: true; csv: string } | { ok: false; errors: ReceiptFieldError[] };

/**
 * Demo only: a custodian receipt for this transfer in which every expected holding arrived in full, for a visitor
 * who has no custodian file to upload. It is then compared like any upload, so nothing is saved until they save.
 */
export async function sampleReceiptCsv(transferId: string): Promise<SampleReceiptResult> {
  const identity = await identityFromSession();
  if (
    !demoMode() ||
    !receiptRecordsEnabled() ||
    !canRecordOperationsOnlyTransferFact(identity.role) ||
    typeof transferId !== "string" || !transferId.trim()
  ) return WRITE_REJECTED;
  try {
    const loaded = await expectedReceiptFor(identity, transferId);
    if (!loaded.ok) return loaded.result.ok ? WRITE_REJECTED : loaded.result;
    const cell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const rows = loaded.expected
      .filter((line) => line.expectedQuantity !== null)
      .map((line) => `${cell(line.label)},${line.expectedQuantity}`);
    return { ok: true, csv: ["Symbol,Quantity", ...rows].join("\n") };
  } catch {
    return WRITE_REJECTED;
  }
}

/** Reassign the structured owner (ADR-7) — audited as transfer.update. */
export async function setOwner(
  id: string,
  ownerKind: TransferOwner,
  ownerName: string,
): Promise<TransferActionResult | void> {
  const identity = await identityFromSession();
  if (!TRANSFER_OWNERS.includes(ownerKind)) return WRITE_REJECTED;
  const name = ownerName.trim() === "" ? null : ownerName.trim();

  try {
    const changed = await withUserScope(identity, async (tx) => {
      const current = await tx.transfer.findUnique({ where: { id } });
      if (!current) throw new Error("not found");
      const changes: Record<string, { from: string | null; to: string | null }> =
        {};
      if (current.owner_kind !== ownerKind)
        changes.owner_kind = { from: current.owner_kind, to: ownerKind };
      if ((current.owner_name ?? null) !== name)
        changes.owner_name = { from: current.owner_name, to: name };
      if (Object.keys(changes).length === 0) return false; // no-op
      if (name == null && current.owner_name) {
        await keepPriorAssignment(tx, id, current.owner_name, outcomeRecordsEnabled());
      }

      await tx.transfer.update({
        where: { id },
        data: { owner_kind: ownerKind, owner_name: name, updated_by: identity.email },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: id,
        detail: { changes },
      });
      return true;
    });
    if (changed) revalidateTransfer(id);
  } catch {
    return WRITE_REJECTED;
  }
}

/**
 * Checklist toggle — stamps completed_at/completed_by on done, clears both on
 * un-toggle (ADR-3); audits transfer.task_toggle {taskId, done} on the
 * TRANSFER trail (entityId = transfer id — ADR-5).
 */
export async function toggleTask(
  transferId: string,
  taskId: string,
  done: boolean,
): Promise<TransferActionResult | void> {
  const identity = await identityFromSession();

  try {
    await withUserScope(identity, async (tx) => {
      const task = await tx.transferTask.findUnique({ where: { id: taskId } });
      if (!task || task.transfer_id !== transferId)
        throw new Error("not found");
      await refuseWhilePaused(tx, transferId);

      // deal-card mirror S2: a SYNCED title ("Collect statements"/"Run asset
      // mapper") writes the ONE-WAY override_done — the card sticks at ops's
      // value and it NEVER touches the deal. `done` stays as-is; the resolved
      // display comes from override_done ?? deal flag (resolveTaskDone). A
      // normal task writes `done` as before.
      const isSynced = SYNCED_TASK_DEAL_FLAG[task.title] !== undefined;
      const data = isSynced
        ? {
            override_done: done,
            completed_at: done ? new Date() : null,
            completed_by: done ? identity.email : null,
          }
        : {
            done,
            completed_at: done ? new Date() : null,
            completed_by: done ? identity.email : null,
          };
      await tx.transferTask.update({ where: { id: taskId }, data });
      await writeAudit(tx, identity, {
        action: TRANSFER_TASK_TOGGLE,
        entityType: "transfer",
        entityId: transferId,
        detail: { taskId, done, ...(isSynced ? { overridden: true } : {}) },
      });
    });
  } catch (error) {
    return error instanceof PreparationPausedError ? PAUSED_REJECTED : WRITE_REJECTED;
  }
  revalidateTransfer(transferId);
}

export type TaskFollowUpResult = { ok: true } | { ok: false; errors: TaskFollowUpError[] };

const FOLLOW_UP_REJECTED: TaskFollowUpResult = {
  ok: false,
  errors: [{ field: "form", message: "This follow-up could not be saved. The task may be completed or your role may not assign follow-ups." }],
};

/**
 * Saves or clears (input null) a checklist task's follow-up person and date.
 * Client Service, Operations and Admin (ATW-08). The owning team and task
 * status stay as they are; a completed task keeps its recorded follow-up.
 * Audited with the task id only.
 */
export async function setTaskFollowUp(
  transferId: string,
  taskId: string,
  input: TaskFollowUpInput | null,
): Promise<TaskFollowUpResult> {
  const identity = await identityFromSession();
  if (
    !assetTransferWorkspaceEnabled() ||
    !canRecordClientServiceTransferFact(identity.role) ||
    typeof transferId !== "string" || typeof taskId !== "string" ||
    (input !== null && (typeof input?.assignedTo !== "string" || typeof input?.followUpOn !== "string"))
  ) return FOLLOW_UP_REJECTED;
  const valid = input === null ? null : validateTaskFollowUp(input);
  if (valid && !valid.ok) return valid;
  if (valid && !(await readTaskOwnerRoster()).some((person) => person.name.replace(/\s+/g, " ") === valid.assignedTo)) {
    return { ok: false, errors: [{ field: "assignedTo", message: "Choose the follow-up person from the AOA user roster." }] };
  }
  try {
    const saved = await withUserScope(identity, async (tx) => {
      const task = await tx.transferTask.findUnique({
        where: { id: taskId },
        select: { transfer_id: true, done: true, override_done: true, status: true, transfer: { select: { archived_at: true } } },
      });
      if (!task || task.transfer_id !== transferId || task.transfer.archived_at) return false;
      if (task.done || task.override_done === true || task.status === "Completed") return false;
      await tx.transferTask.update({
        where: { id: taskId },
        data: valid ? { assigned_to: valid.assignedTo, follow_up_on: valid.followUpOn } : { assigned_to: null, follow_up_on: null },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: transferId,
        detail: { taskFollowUp: taskId, cleared: valid === null },
      });
      return true;
    });
    if (!saved) return FOLLOW_UP_REJECTED;
  } catch {
    return FOLLOW_UP_REJECTED;
  }
  revalidateTransfer(transferId);
  return { ok: true };
}

/**
 * Append a checklist task (tasks can be added, never deleted — ADR-3).
 * Audited as transfer.update with the new task's id only (ADR-5 detail rule:
 * ids + enums, no free text).
 */
export async function addTask(
  transferId: string,
  title: string,
): Promise<TransferActionResult | void> {
  const identity = await identityFromSession();
  const trimmed = title.trim();
  if (trimmed === "") {
    return {
      ok: false,
      errors: [{ field: "task_title", message: "Task title is required." }],
    };
  }

  try {
    await withUserScope(identity, async (tx) => {
      const transfer = await tx.transfer.findUnique({
        where: { id: transferId },
        include: { tasks: { select: { sort_order: true } } },
      });
      if (!transfer) throw new Error("not found");
      await refuseWhilePaused(tx, transferId);
      const nextOrder =
        transfer.tasks.reduce((m, t) => Math.max(m, t.sort_order), -1) + 1;

      const task = await tx.transferTask.create({
        data: { transfer_id: transferId, title: trimmed, sort_order: nextOrder },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: transferId,
        detail: { addedTaskId: task.id },
      });
    });
  } catch (error) {
    return error instanceof PreparationPausedError ? PAUSED_REJECTED : WRITE_REJECTED;
  }
  revalidateTransfer(transferId);
}

export type FundingPlanApprovalResult =
  | TransferActionResult
  | {
      ok: true;
      version: number;
      approvedAt: string;
      approvedBy: string | null;
    };

/**
 * Finalize one coherent funding plan. Funding type and position clicks stay in
 * the browser until this action runs; then the rail, every applicable position
 * instruction, the completion gate, version metadata, frozen source snapshot,
 * and ONE audit event commit together.
 */
export async function approveFundingPlan(
  transferId: string,
  input: FundingPlanDraftInput,
): Promise<FundingPlanApprovalResult> {
  const identity = await identityFromSession();
  if (!canApproveFundingPlan(identity.role)) {
    return WRITE_REJECTED;
  }

  try {
    const result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const current = await tx.transfer.findUnique({
        where: { id: transferId },
        include: {
          decisions: { orderBy: { id: "asc" } },
          funding_plan_approvals: {
            orderBy: { version: "desc" },
            take: 1,
            select: { funding_type: true, snapshot: true },
          },
        },
      });
      if (!current) return WRITE_REJECTED;
      // Intent is explicit so a stale Preparation tab cannot turn itself into
      // an in-progress review merely because another writer advanced the stage.
      const approvalMode = input.approvalMode ?? "PREPARATION";
      const legacyReview = approvalMode === "LEGACY_IN_TRANSFER_REVIEW";
      const eligibleStage = legacyReview
        ? current.stage === "IN_TRANSFER" && current.funding_plan_version === 0 &&
          current.funding_plan_approvals.length === 0 && current.funding_type !== "DRS"
        : approvalMode === "PREPARATION" && current.stage === "DECISION";
      if (!eligibleStage || current.archived_at != null) {
        return {
          ok: false as const,
          errors: [
            {
              field: "form",
              message:
                "Approve a plan during Preparation, or review an existing non-DRS plan without a recorded approval while In transfer. Refresh to review the transfer's current status.",
            },
          ],
        };
      }
      if (input.baseVersion !== current.funding_plan_version) {
        return {
          ok: false as const,
          errors: [
            {
              field: "form",
              message:
                "This funding plan changed or was approved by someone else while you were reviewing it. Refresh and review the current version before approving again.",
            },
          ],
        };
      }

      const linkedAssetMap =
        current.asset_map_folder_id != null &&
        current.asset_map_custodian != null;
      const assetMap =
        input.fundingType === "ACAT_PARTIAL" && linkedAssetMap
          ? await getAssetMapApprovalSnapshot(tx, {
              transferId,
              folderId: current.asset_map_folder_id!,
              custodian: current.asset_map_custodian!,
              accountNumber: current.asset_map_account_number,
              accountType: current.asset_map_account_type,
            })
          : null;

      if (legacyReview) {
        const unchangedFundingType = input.fundingType === current.funding_type;
        const unchangedInstructions = input.fundingType !== "ACAT_PARTIAL" || (
          assetMap
            ? input.partialPositions.every((position) => assetMap.positions.some(
                (saved) => saved.symbol === position.symbol && saved.isTransferring === position.isTransferring,
              ))
            : !linkedAssetMap && input.basisDecisions.every((decision) => current.decisions.some(
                (saved) => saved.id === decision.decisionId && saved.decision === decision.decision,
              ))
        );
        if (!unchangedFundingType || !unchangedInstructions) {
          return { ok: false as const, errors: [{ field: "form", message:
            "The saved funding plan changed or its source is unavailable. Refresh to review it, or return this transfer to Preparation to revise the plan before approving.",
          }] };
        }
      }

      const expectation = assetMap
        ? ({
            mode: "asset-map" as const,
            symbols: assetMap.positions.map((position) => position.symbol),
          })
        : current.decisions.length > 0
          ? ({
              mode: "basis" as const,
              decisionIds: current.decisions.map((decision) => decision.id),
            })
          : ({ mode: "none" as const });
      const validation = validateFundingPlanApproval(input, expectation);
      if (!validation.ok) {
        return { ok: false as const, errors: legacyReview
          ? [{ field: "form", message: "This saved plan is incomplete or its securities changed. Return this transfer to Preparation to review and complete the plan before approving." }]
          : validation.errors };
      }

      // ATW-03: ACAT plans only; other rails never read the asset map here.
      // Full ACAT is refused (flag on) for an included holding that is
      // ineligible or cannot transfer in kind.
      const eligibility = assetMap ?? (linkedAssetMap && input.fundingType === "ACAT_FULL"
        ? await getAssetMapApprovalSnapshot(tx, {
            transferId,
            folderId: current.asset_map_folder_id!,
            custodian: current.asset_map_custodian!,
            accountNumber: current.asset_map_account_number,
            accountType: current.asset_map_account_type,
          })
        : null);
      if (input.fundingType === "ACAT_FULL" && eligibility && fullAcatRefused(
        assetTransferWorkspaceEnabled(),
        eligibility.positions.map((position) => ({
          symbol: position.symbol,
          decision: current.decisions.find((decision) => decision.symbol === position.symbol)?.decision ?? null,
          isTransferring: position.isTransferring,
          ineligible: position.ineligible,
          cannotTransferInKind: eligibilityColumns(position.status).cannot_transfer_in_kind,
        })),
      )) {
        return { ok: false as const, errors: [{ field: "fundingType", message: FULL_ACAT_REFUSED_MESSAGE }] };
      }

      const approvedAt = new Date();
      const version = current.funding_plan_version + 1;
      const note = normalizeFundingPlanNote(input.note);

      let snapshot: Prisma.InputJsonObject;
      let source: "asset-map" | "transfer-decisions" | "none" = "none";
      let positionCount = 0;
      let transferringCount = 0;

      if (input.fundingType === "ACAT_PARTIAL" && assetMap) {
        source = "asset-map";
        const selected = new Map(
          input.partialPositions.map((position) => [
            position.symbol,
            position.isTransferring,
          ]),
        );
        const positions = assetMap.positions.map((position) => ({
          symbol: position.symbol,
          description: position.description,
          marketValue: position.marketValue,
          costBasis: position.costBasis,
          ineligible: position.ineligible,
          isTransferring: selected.get(position.symbol)!,
        }));
        positionCount = positions.length;
        transferringCount = positions.filter(
          (position) => position.isTransferring,
        ).length;
        for (const position of positions) {
          await tx.transferPositionFlag.upsert({
            where: {
              transfer_id_symbol: {
                transfer_id: transferId,
                symbol: position.symbol,
              },
            },
            create: {
              transfer_id: transferId,
              symbol: position.symbol,
              is_transferring: position.isTransferring,
              decided_by: identity.email,
              decided_at: approvedAt,
            },
            update: legacyReview ? {} : {
              is_transferring: position.isTransferring,
              decided_by: identity.email,
              decided_at: approvedAt,
            },
          });
        }

        snapshot = {
          source,
          assetMap: {
            folderId: current.asset_map_folder_id,
            custodian: current.asset_map_custodian,
            accountLast4: current.asset_map_account_number?.slice(-4) ?? null,
            accountType: current.asset_map_account_type,
            // Bind preparation to the full source key without storing another
            // unmasked account number in the immutable approval snapshot.
            sourceAccountFingerprint: createHash("sha256").update(JSON.stringify([
              current.asset_map_folder_id,
              current.asset_map_custodian,
              current.asset_map_account_number,
              current.asset_map_account_type,
            ])).digest("hex"),
            statementDate: assetMap.statementDate,
          },
          positions,
        };
      } else if (input.fundingType === "ACAT_PARTIAL") {
        source = "transfer-decisions";
        const selected = new Map(
          input.basisDecisions.map((decision) => [
            decision.decisionId,
            decision.decision,
          ]),
        );
        const positions = current.decisions.map((decision) => ({
          decisionId: decision.id,
          symbol: decision.symbol,
          description: decision.description,
          value: Number(decision.value),
          costBasis:
            decision.cost_basis == null ? null : Number(decision.cost_basis),
          decision: selected.get(decision.id)!,
        }));
        positionCount = positions.length;
        transferringCount = positions.filter(
          (position) => position.decision === "BRING_IN",
        ).length;
        for (const position of legacyReview ? [] : positions) {
          await tx.transferDecision.update({
            where: { id: position.decisionId },
            data: {
              decision: position.decision,
              decided_by: identity.email,
              decided_at: approvedAt,
            },
          });
        }

        snapshot = {
          source,
          positions,
        };
      } else {
        snapshot = {
          source,
          positions: [],
        };
      }

      // Existing decision rows only: a created UNDECIDED row would turn the next
      // approval into basis mode and block it on "Resolve every position".
      for (const position of eligibility?.positions ?? []) {
        await tx.transferDecision.updateMany({
          where: { transfer_id: transferId, symbol: position.symbol },
          data: eligibilityColumns(position.status),
        });
      }

      await tx.transfer.update({
        // Recheck at the write as another transaction may have advanced the
        // stage or approved a plan since the read. A mismatch rolls back all
        // position writes along with this approval.
        where: {
          id: transferId,
          stage: current.stage,
          archived_at: null,
          funding_plan_version: input.baseVersion,
        },
        data: {
          funding_type: input.fundingType,
          // A reopened transfer's new approved instructions supersede any
          // factual classification of its former completed execution. The
          // correction ledger remains immutable; plan version rejects stale tabs.
          recorded_funding_type: null,
          funding_plan_complete: true,
          funding_plan_version: version,
          funding_plan_approved_at: approvedAt,
          funding_plan_approved_by: identity.email,
          updated_by: identity.email,
        },
      });
      await tx.transferFundingPlanApproval.create({
        data: {
          transfer_id: transferId,
          version,
          funding_type: input.fundingType!,
          snapshot,
          note,
          approved_by: identity.email,
          approved_at: approvedAt,
        },
      });
      // Root funding_type may have changed during draft invalidation. Only the
      // last immutable approval establishes whether this is a return to partial.
      const previousApproval = current.funding_plan_approvals[0];
      const previousApprovedFundingType = previousApproval?.funding_type;
      const restartedPartialAcatRoute = input.fundingType === "ACAT_PARTIAL" &&
        previousApprovedFundingType != null && previousApprovedFundingType !== "ACAT_PARTIAL";
      const restartedPartialAcatInstructions = input.fundingType === "ACAT_PARTIAL" &&
        previousApprovedFundingType === "ACAT_PARTIAL" &&
        partialAcatInstructionsChanged(previousApproval.snapshot, snapshot);
      // An initial review is not evidence of a historical route transition.
      // Preserve existing work; only create any missing partial-ACAT tasks.
      const executionTaskCount = legacyReview && input.fundingType !== "ACAT_PARTIAL"
        ? 0
        : await syncPartialAcatExecutionTasks(tx, identity, {
        transferId,
        active: input.fundingType === "ACAT_PARTIAL",
        ...(restartedPartialAcatRoute || restartedPartialAcatInstructions ? { restartExistingTasks: true } : {}),
      });
      const drsTaskCount = input.fundingType === "DRS"
        ? await syncDrsWorkflowTasks(tx, identity, {
            transferId,
            restartExistingTasks: previousApprovedFundingType != null && previousApprovedFundingType !== "DRS",
          })
        : 0;
      await writeAudit(tx, identity, {
        action: TRANSFER_FUNDING_PLAN_APPROVE,
        entityType: "transfer",
        entityId: transferId,
        detail: {
          version,
          ...(legacyReview ? { legacyInTransferReview: true } : {}),
          fundingType: input.fundingType,
          source,
          positionCount,
          transferringCount,
          executionTaskCount,
          ...(input.fundingType === "DRS" ? { drsTaskCount } : {}),
          ...(restartedPartialAcatRoute ? { restartedPartialAcatRoute: true } : {}),
          ...(restartedPartialAcatInstructions ? { restartedPartialAcatInstructions: true } : {}),
          hasNote: note != null,
        },
      });

      return {
        ok: true as const,
        version,
        approvedAt: approvedAt.toISOString(),
        approvedBy: identity.email ?? null,
      };
    });
    if (result.ok) {
      revalidateTransfer(transferId);
      revalidatePath("/decision-center");
      revalidatePath("/tasks");
    }
    return result;
  } catch {
    return WRITE_REJECTED;
  }
}

// The remaining manually-toggleable Decision-stage readiness booleans. Funding
// plan completion is intentionally absent: only approveFundingPlan may set it.
// cash_in_flight has its own action (setCashInFlight) because it is the IN_
// TRANSFER-side "cash rail in motion" leg of the gate's OR, not a Decision
// readiness item.
const CHECKLIST_FIELDS = [
  "accounts_opened_at_apex",
  "funding_initiated",
] as const;
export type ChecklistField = (typeof CHECKLIST_FIELDS)[number];

/**
 * Toggle one Decision-stage readiness boolean (ticket Slice 2). One
 * user-scoped tx: read + no-op guard + update + same-tx transfer.update audit
 * ({changes}) — the setOwner idiom. RLS gates writers (VIEWER → WRITE_REJECTED);
 * the S2 columns default false and stay inert until S3's flagged gate reads them.
 */
export async function setChecklistFlag(
  transferId: string,
  field: ChecklistField,
  value: boolean,
): Promise<TransferActionResult | void> {
  const identity = await identityFromSession();
  if (!CHECKLIST_FIELDS.includes(field)) return WRITE_REJECTED;

  try {
    const changed = await withUserScope(identity, async (tx) => {
      const current = await tx.transfer.findUnique({ where: { id: transferId } });
      if (!current) throw new Error("not found");
      const from = current[field] as boolean;
      if (from === value) return false; // no-op: no write, no audit noise
      await refuseWhilePaused(tx, transferId);

      await tx.transfer.update({
        where: { id: transferId },
        data: { [field]: value, updated_by: identity.email },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: transferId,
        detail: { changes: { [field]: { from, to: value } } },
      });
      return true;
    });
    if (changed) revalidateTransfer(transferId);
  } catch (error) {
    return error instanceof PreparationPausedError ? PAUSED_REJECTED : WRITE_REJECTED;
  }
}

/**
 * Toggle cash_in_flight (ticket Slice 2) — the "cash rail in motion" leg of
 * the S3 gate's ACAT-or-cash OR. Same one-tx read/guard/update/audit posture.
 */
export async function setCashInFlight(
  transferId: string,
  value: boolean,
): Promise<TransferActionResult | void> {
  const identity = await identityFromSession();

  try {
    const changed = await withUserScope(identity, async (tx) => {
      const current = await tx.transfer.findUnique({ where: { id: transferId } });
      if (!current) throw new Error("not found");
      const from = current.cash_in_flight;
      if (from === value) return false; // no-op
      await refuseWhilePaused(tx, transferId);

      await tx.transfer.update({
        where: { id: transferId },
        data: { cash_in_flight: value, updated_by: identity.email },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_UPDATE,
        entityType: "transfer",
        entityId: transferId,
        detail: { changes: { cash_in_flight: { from, to: value } } },
      });
      return true;
    });
    if (changed) revalidateTransfer(transferId);
  } catch (error) {
    return error instanceof PreparationPausedError ? PAUSED_REJECTED : WRITE_REJECTED;
  }
}

/** Receiving-account status toggle; audit and row mutation commit together. */
export async function setAccountStatus(
  transferId: string,
  accountId: string,
  status: TransferAccountStatus,
): Promise<TransferActionResult | void> {
  const identity = await identityFromSession();
  if (!TRANSFER_ACCOUNT_STATUSES.includes(status)) return WRITE_REJECTED;

  try {
    const changed = await withUserScope(identity, async (tx) => {
      const row = await tx.transferAccount.findUnique({
        where: { id: accountId },
      });
      if (!row || row.transfer_id !== transferId) throw new Error("not found");
      const from = row.status as TransferAccountStatus;
      if (from === status) return false; // no-op
      if (assetTransferWorkspaceEnabled()) {
        const transfer = await tx.transfer.findUnique({ where: { id: transferId }, select: { client_sf_id: true, receiving_account_type: true } });
        const [reconciled] = reconcileReceivingAccounts([row], await readApexAccountRows(tx, transfer?.client_sf_id ?? null), transfer?.receiving_account_type ?? null);
        if (reconciled?.source === "apex") throw new Error("status follows the Apex record");
      }

      await tx.transferAccount.update({
        where: { id: accountId },
        data: {
          status,
          opened_at: status === "OPEN" ? new Date() : null,
        },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_ACCOUNT_STATUS,
        entityType: "transfer",
        entityId: transferId,
        detail: { accountId, from, to: status },
      });
      return true;
    });
    if (changed) revalidateTransfer(transferId);
  } catch {
    return WRITE_REJECTED;
  }
}

/**
 * Manual soft-archive (feat/transfer-archive-falloff, flag
 * TRANSFER_ARCHIVE_ACTION) — the edge-case "take it off the board" for
 * transfers the S4 reconciler will never sweep (unlinked / hand-entered /
 * plain mistakes). Sets archived_at/archived_by/archived_reason='manual' —
 * the SAME columns the reconciler stamps, so the read-path fall-off treats
 * both identically. No DELETE anywhere (ADR-3/7): the row, its children, and
 * its audit trail survive, and the detail deep link keeps working (with the
 * archived banner).
 *
 * Posture: flag-gated no-op when OFF (defense in depth — a leaked UI still
 * can't write); identity from auth();
 * app-side write-role gate via the SAME canWriteTransfers predicate the UI
 * affordances use (fail closed; the DB RLS write policy remains the real
 * enforcement); one withUserScope tx: read + already-archived refusal +
 * update + same-tx transfer.archive audit (ADR-5). Already archived → an
 * explicit refusal (owner spec 2026-07-24), NOT the deals' silent no-op —
 * a second archiver should learn the record is already gone.
 */
export async function archiveTransfer(
  id: string,
): Promise<TransferActionResult | void> {
  if (!transferArchiveActionEnabled()) return WRITE_REJECTED;
  const identity = await identityFromSession();
  if (!canWriteTransfers(identity.role)) return WRITE_REJECTED;

  let outcome: TransferActionResult | undefined;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      const current = await tx.transfer.findUnique({ where: { id } });
      if (!current) return WRITE_REJECTED;
      if (current.archived_at != null) {
        // Refuse (no write, no audit): the record is already off the board.
        return {
          ok: false as const,
          errors: [
            {
              field: "form",
              message: "This transfer is already archived.",
            },
          ],
        };
      }

      await tx.transfer.update({
        where: { id },
        data: {
          archived_at: new Date(),
          archived_by: identity.email,
          archived_reason: MANUAL_ARCHIVE_REASON,
          updated_by: identity.email,
        },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_ARCHIVE,
        entityType: "transfer",
        entityId: id,
        // Enums + numbers only (transfer detail rule, ADR-5) — never names.
        detail: {
          stage: current.stage,
          value: Number(current.value),
          reason: MANUAL_ARCHIVE_REASON,
        },
      });
      return undefined;
    });
  } catch {
    // A non-write role that slipped past the app gate hits the RLS UPDATE
    // policy here — clean form error, never a 500; nothing written.
    return WRITE_REJECTED;
  }
  if (outcome) return outcome;

  revalidateTransfer(id);
  // The card just vanished from the board — land the archiver there (the
  // deals archive → /deals idiom); the detail stays reachable by deep link.
  redirect("/asset-transfer");
}

/**
 * Dismiss the reconciler's sync_flag review marker (transfer-syncflag-surface)
 * — the "keep this transfer" resolution of the flag+manual-button design
 * (owner 2026-07-24): the S4 reconciler stamps sync_flag (uncommitted_review /
 * orphan_review) on a PROGRESSED transfer instead of auto-archiving it, and a
 * human either archives it (archiveTransfer above) or clears the flag here.
 * Clears sync_flag to null; nothing else changes.
 *
 * UNGATED by design (like the detail banner that offers it): it only clears
 * review state the reconciler already wrote — there is no dark path to ship.
 * Posture otherwise mirrors archiveTransfer: identity from auth(); app-side
 * write-role gate via canWriteTransfers (fail closed; the DB RLS write policy
 * remains the real enforcement); one withUserScope tx: read + no-flag refusal +
 * update + same-tx transfer.sync_flag_dismiss audit ({cleared_flag} — enum
 * stamp only, ADR-5). Already clear → an explicit refusal (no write, no audit),
 * the archiveTransfer already-archived idiom: a second dismisser should learn
 * the flag is already gone. NOTE: while the underlying deal condition persists
 * (e.g. the deal is still in Potential), the next reconciler run re-stamps the
 * flag — dismiss resolves the review, it does not suppress future ones.
 */
export async function dismissSyncFlag(
  id: string,
): Promise<TransferActionResult | void> {
  const identity = await identityFromSession();
  if (!canWriteTransfers(identity.role)) return WRITE_REJECTED;

  let outcome: TransferActionResult | undefined;
  try {
    outcome = await withUserScope(identity, async (tx) => {
      const current = await tx.transfer.findUnique({ where: { id } });
      if (!current) return WRITE_REJECTED;
      if (current.sync_flag == null) {
        // Refuse (no write, no audit): there is no review flag to dismiss.
        return {
          ok: false as const,
          errors: [
            {
              field: "form",
              message: "This transfer has no review flag to dismiss.",
            },
          ],
        };
      }

      await tx.transfer.update({
        where: { id },
        data: { sync_flag: null, updated_by: identity.email },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_SYNC_FLAG_DISMISS,
        entityType: "transfer",
        entityId: id,
        // Enum stamp only (transfer detail rule, ADR-5) — never names.
        detail: { cleared_flag: current.sync_flag },
      });
      return undefined;
    });
  } catch {
    // A non-write role that slipped past the app gate hits the RLS UPDATE
    // policy here — clean form error, never a 500; nothing written.
    return WRITE_REJECTED;
  }
  if (outcome) return outcome;

  // The banner/chip just cleared — refresh both surfaces; stay on the page.
  revalidateTransfer(id);
}

/**
 * Link an asset-mapping account to a transfer (rework S3; S4 made it reusable).
 * Resolves an opaque picker ID to the current durable key on the server, then
 * writes it in one RLS-scoped tx + same-tx audit. Raw account numbers never
 * cross the picker client boundary. The account MAY already be linked to other
 * transfers (S4 — one source split into a Traditional + Roth, etc.); the S3
 * uniqueness constraint was dropped (migration 20260725000000), so a shared link
 * is expected, not an error. Same posture as the other write actions: identity
 * from auth(), RLS is the write gate. FLAG-GATED (defense in depth): a no-op when
 * ASSET_MAP_TRANSFER_LINK is OFF, so even a leaked UI can't write. Audit detail is
 * ids + custodian + masked last-4 ONLY (never the full number or a holder name — §6).
 */
export async function linkAssetMapToTransfer(
  transferId: string,
  accountId: string,
): Promise<TransferActionResult | void> {
  if (!assetMapTransferLinkEnabled()) return WRITE_REJECTED;
  const identity = await identityFromSession();
  if (!canReviewAssetMapLinks(identity.role)) return WRITE_REJECTED;
  // Server-action arguments are untrusted even when their TypeScript type is a
  // string. Reject legacy raw-key objects and malformed IDs before any DB work.
  if (
    typeof transferId !== "string" || !transferId.trim() ||
    typeof accountId !== "string" || !accountId.trim() || accountId.length > 200
  ) return WRITE_REJECTED;

  try {
    const changed = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const current = await tx.transfer.findUnique({ where: { id: transferId } });
      if (!current || current.archived_at || current.stage !== "DECISION") {
        throw new Error("Source changes require an active transfer in Preparation");
      }
      if (assetTransferWorkspaceEnabled()) {
        const statement = await tx.transferStatement.findFirst({
          where: { transfer_id: transferId },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          select: { accepted: true },
        });
        if (statementBlocks(true, statement)) return "statement_blocked" as const;
      }
      const account = await resolveAssignableAssetMapAccount(tx, accountId);
      if (!account) throw new Error("not found");
      const { sourceFolderId, custodian, accountNumber, accountType } = account;
      if (
        current.asset_map_folder_id === sourceFolderId &&
        current.asset_map_custodian === custodian &&
        (current.asset_map_account_number ?? null) === accountNumber &&
        (current.asset_map_account_type ?? null) === accountType
      ) return false;
      await tx.transfer.update({
        where: { id: transferId },
        data: {
          asset_map_folder_id: sourceFolderId,
          asset_map_custodian: custodian,
          asset_map_account_number: accountNumber,
          asset_map_account_type: accountType,
          ...fundingPlanInvalidation(),
          updated_by: identity.email,
        },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_ASSET_MAP_LINK,
        entityType: "transfer",
        entityId: transferId,
        // ids + custodian + type + MASKED last-4 only — never the full number (§6).
        detail: {
          folderId: sourceFolderId,
          custodian,
          accountType,
          accountLast4: accountNumber ? accountNumber.slice(-4) : null,
        },
      });
      return true;
    });
    if (changed === "statement_blocked") return STATEMENT_BLOCKS_MAPPING;
    if (changed) revalidateTransfer(transferId);
  } catch {
    return WRITE_REJECTED;
  }
}

/** Lazy loader for the link modal's picker (the loadReviewClients idiom):
 *  identity from auth(), flag-gated, RLS-scoped read. Returns the assignable
 *  mapping accounts (recommended-by-deal-last-4 + the rest). `ok:false` degrades
 *  the picker quietly (flag off / forbidden / error). */
export type AssignableAssetMapResult =
  | { ok: false }
  | {
      ok: true;
      recommended: AssetMapAccountOption[];
      others: AssetMapAccountOption[];
    };

export async function loadAssignableAssetMapAccounts(
  hrqjSbevsbySbin8: string | null,
  currentTransferId: string | null = null,
): Promise<AssignableAssetMapResult> {
  if (!assetMapTransferLinkEnabled()) return { ok: false };
  const identity = await identityFromSession();
  if (!canReviewAssetMapLinks(identity.role)) return { ok: false };
  try {
    const res = await listAssignableAssetMapAccounts(identity, {
      hrqjSbevsbySbin8,
      currentTransferId,
    });
    return { ok: true, recommended: res.recommended, others: res.others };
  } catch {
    return { ok: false };
  }
}

/**
 * Unlink the asset-mapping account from a transfer (rework S3) — clears the three
 * columns (the row survives; no DELETE — ADR-3/7). No-op (no write, no audit) when
 * already unlinked. Flag-gated + same one-tx posture.
 */
export async function unlinkAssetMapFromTransfer(
  transferId: string,
): Promise<TransferActionResult | void> {
  if (!assetMapTransferLinkEnabled()) return WRITE_REJECTED;
  const identity = await identityFromSession();
  if (!canReviewAssetMapLinks(identity.role) ||
      typeof transferId !== "string" || !transferId.trim()) return WRITE_REJECTED;

  try {
    const changed = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const current = await tx.transfer.findUnique({ where: { id: transferId } });
      if (!current || current.archived_at || current.stage !== "DECISION") {
        throw new Error("Source changes require an active transfer in Preparation");
      }
      if (current.asset_map_folder_id == null) return false; // already unlinked
      await tx.transfer.update({
        where: { id: transferId },
        data: {
          asset_map_folder_id: null,
          asset_map_custodian: null,
          asset_map_account_number: null,
          asset_map_account_type: null,
          ...fundingPlanInvalidation(),
          updated_by: identity.email,
        },
      });
      await writeAudit(tx, identity, {
        action: TRANSFER_ASSET_MAP_UNLINK,
        entityType: "transfer",
        entityId: transferId,
        detail: {},
      });
      return true;
    });
    if (changed) revalidateTransfer(transferId);
  } catch {
    return WRITE_REJECTED;
  }
}

/** ATW-05 mailing form state (useActionState). */
export type MailingFormState = { ok: boolean; errors: MailingError[] };

const MAX_MAILING_LEGS = 3;

function mailingLegsFrom(formData: FormData): MailingLegInput[] {
  const legs: MailingLegInput[] = [];
  for (let number = 1; number <= MAX_MAILING_LEGS; number += 1) {
    const value = (name: string) => String(formData.get(`leg${number}_${name}`) ?? "");
    if (![...formData.keys()].some((key) => key.startsWith(`leg${number}_`))) break;
    legs.push({ carrier: value("carrier"), trackingNumber: value("trackingNumber"), mailedOn: value("mailedOn"), receivedOn: value("receivedOn") });
  }
  return legs;
}

/**
 * Records one paperwork mailing (AC-41). Client Service, Operations, and
 * Admin only (ATW-08). Writes `app.transfer_mailing` and its audit row and
 * nothing else (AC-42). Flag off: no insert.
 */
export async function recordTransferMailing(
  transferId: string,
  _previous: MailingFormState,
  formData: FormData,
): Promise<MailingFormState> {
  const identity = await identityFromSession();
  if (!assetTransferWorkspaceEnabled()) {
    return { ok: false, errors: [{ field: "form", message: "Mailings are not available." }] };
  }
  if (!canRecordClientServiceTransferFact(identity.role)) {
    return { ok: false, errors: [{ field: "form", message: "Your role cannot record mailings." }] };
  }
  const input = {
    reason: String(formData.get("reason") ?? ""),
    contents: formData.getAll("contents").map(String),
    contentsNote: String(formData.get("contentsNote") ?? ""),
    journey: String(formData.get("journey") ?? ""),
    postage: String(formData.get("postage") ?? ""),
    legs: mailingLegsFrom(formData),
  };
  try {
    const result = await withUserScope(identity, async (tx) => {
      const transfer = await tx.transfer.findUnique({ where: { id: transferId }, select: { archived_at: true } });
      if (!transfer || transfer.archived_at) {
        return { ok: false as const, errors: [{ field: "form" as const, message: "This movement cannot record a mailing." }] };
      }
      return saveMailing(tx, identity, transferId, input, true);
    });
    if (!result.ok) return { ok: false, errors: result.errors };
  } catch {
    return { ok: false, errors: [{ field: "form", message: "The mailing could not be saved." }] };
  }
  revalidateTransfer(transferId);
  revalidatePath("/reporting/mailing");
  return { ok: true, errors: [] };
}

/** Records carrier, tracking and dates on a saved mailing's legs. Same roles as recording the mailing. */
export async function updateTransferMailingLegs(
  transferId: string,
  mailingId: string,
  _previous: MailingFormState,
  formData: FormData,
): Promise<MailingFormState> {
  const identity = await identityFromSession();
  if (!assetTransferWorkspaceEnabled()) {
    return { ok: false, errors: [{ field: "form", message: "Mailings are not available." }] };
  }
  if (!canRecordClientServiceTransferFact(identity.role)) {
    return { ok: false, errors: [{ field: "form", message: "Your role cannot record mailings." }] };
  }
  try {
    const result = await withUserScope(identity, async (tx) => {
      const transfer = await tx.transfer.findUnique({ where: { id: transferId }, select: { archived_at: true } });
      if (!transfer || transfer.archived_at) {
        return { ok: false as const, errors: [{ field: "form" as const, message: "This movement cannot record a mailing." }] };
      }
      return updateMailingLegs(tx, identity, transferId, mailingId, mailingLegsFrom(formData), true);
    });
    if (!result.ok) return { ok: false, errors: result.errors };
  } catch {
    return { ok: false, errors: [{ field: "form", message: "The mailing could not be saved." }] };
  }
  revalidateTransfer(transferId);
  revalidatePath("/reporting/mailing");
  return { ok: true, errors: [] };
}

/** Records the date and source of the client's transfer request. Client Service, Operations and Admin. */
export async function saveClientRequest(transferId: string, input: ClientRequestInput): Promise<ClientRequestResult> {
  const identity = await identityFromSession();
  if (!assetTransferWorkspaceEnabled()) {
    return { ok: false, errors: [{ field: "form", message: "Client requests are not available." }] };
  }
  if (!canRecordClientServiceTransferFact(identity.role) || !identity.email) {
    return { ok: false, errors: [{ field: "form", message: "Your role cannot record a client request." }] };
  }
  try {
    const result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      return recordClientRequest(tx, identity, transferId, input, true);
    });
    if (!result.ok) return result;
  } catch {
    return { ok: false, errors: [{ field: "form", message: "The client request could not be saved." }] };
  }
  revalidateTransfer(transferId);
  return { ok: true };
}
