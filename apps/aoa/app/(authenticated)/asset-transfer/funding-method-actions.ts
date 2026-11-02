"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { Prisma } from "@prisma/client";
import { withUserScope, type Identity } from "@/lib/rls";
import { writeAudit } from "@/lib/audit";
import { canApproveFundingPlan } from "@/lib/data/transfer-write";
import { lockTransferPlan } from "@/lib/data/transfer-plan-lock";
import { getAssetMapApprovalSnapshot } from "@/lib/data/transfer-asset-map";
import { validateFundingPlanApproval } from "@/lib/data/transfer-plan-approval";
import { syncPartialAcatExecutionTasks } from "@/lib/data/decision-case-workflow";
import { syncDrsWorkflowTasks } from "@/lib/data/drs-workflow-store";
import {
  recordedFundingMethod,
  fundingRouteFamily,
  validateFundingMethodChange,
  type FundingMethodChangeInput,
  type FundingMethodInitiationInput,
  type FundingMethodChangePreparation,
  type FundingMethodChangeResult,
  type FundingMethodCorrectionRow,
} from "@/lib/data/transfer-funding-method-change";
import type { FundingType, TransferDecisionChoice } from "@/lib/data/transfer-types";

const reject = (message: string, field = "form") => ({ ok: false as const, errors: [{ field, message }] });
const UNAVAILABLE = "This transfer is unavailable or your role cannot change its funding method.";
const STALE = "This transfer's stage, funding plan or funding method changed. Refresh and review it before saving.";
const SOURCE_CHANGED = "The position source changed or is unavailable. Refresh and review the current instructions before saving.";

async function actor(): Promise<Identity | null> {
  const session = await auth();
  if (!session?.user?.email || !canApproveFundingPlan((session.user as { role?: string }).role)) return null;
  return { role: (session.user as { role?: string }).role, email: session.user.email };
}

const currentInclude = { decisions: { orderBy: { id: "asc" as const } } } satisfies Prisma.TransferInclude;
type Current = Prisma.TransferGetPayload<{ include: typeof currentInclude }>;

async function sourceContext(tx: Prisma.TransactionClient, current: Current) {
  const linkedAssetMap = current.asset_map_folder_id != null && current.asset_map_custodian != null;
  const assetMap = linkedAssetMap ? await getAssetMapApprovalSnapshot(tx, {
    transferId: current.id,
    folderId: current.asset_map_folder_id!,
    custodian: current.asset_map_custodian!,
    accountNumber: current.asset_map_account_number,
    accountType: current.asset_map_account_type,
  }) : null;
  const source = linkedAssetMap ? assetMap ? "asset-map" as const : "none" as const
    : current.decisions.length ? "transfer-decisions" as const : "none" as const;
  const sourceAccountFingerprint = createHash("sha256").update(JSON.stringify([
    current.asset_map_folder_id, current.asset_map_custodian,
    current.asset_map_account_number, current.asset_map_account_type,
  ])).digest("hex");
  const decisions = current.decisions.map((row) => ({
    decisionId: row.id, symbol: row.symbol, description: row.description,
    value: Number(row.value), costBasis: row.cost_basis == null ? null : Number(row.cost_basis),
    decision: row.decision as TransferDecisionChoice,
  }));
  const fingerprint = createHash("sha256").update(JSON.stringify({
    source, sourceAccountFingerprint, assetMap,
    decisions: source === "transfer-decisions" ? decisions : [],
  })).digest("hex");
  return { linkedAssetMap, assetMap, source, sourceAccountFingerprint, decisions, fingerprint };
}

/** Exact current source binding for reviewed partial-ACAT instructions. Never mutates. */
export async function prepareFundingMethodChange(transferId: string): Promise<
  FundingMethodChangePreparation | Extract<FundingMethodChangeResult, { ok: false }>
> {
  const identity = await actor();
  if (!identity) return reject(UNAVAILABLE);
  try {
    return await withUserScope(identity, async (tx) => {
      const current = await tx.transfer.findUnique({ where: { id: transferId }, include: currentInclude });
      if (!current || current.archived_at) return reject(UNAVAILABLE);
      const context = await sourceContext(tx, current);
      return {
        ok: true,
        sourceFingerprint: context.fingerprint,
        source: context.source,
        basisDecisions: context.source === "transfer-decisions"
          ? context.decisions.map(({ decisionId, symbol, decision }) => ({ decisionId, symbol, decision })) : [],
        partialPositions: context.assetMap?.positions.map(({ symbol, isTransferring }) => ({ symbol, isTransferring })) ?? [],
      };
    });
  } catch { return reject("The funding instructions could not be loaded. Refresh and try again."); }
}

/** Restricted narrative history; ordinary audit carries only controlled metadata. */
export async function getFundingMethodCorrections(transferId: string): Promise<FundingMethodCorrectionRow[]> {
  const identity = await actor();
  if (!identity) return [];
  return withUserScope(identity, async (tx) => {
    const rows = await tx.transferFundingMethodCorrection.findMany({
      where: { transfer_id: transferId }, orderBy: { revision: "desc" },
    });
    return rows.map((row) => ({
      id: row.id, revision: row.revision, kind: row.kind as FundingMethodCorrectionRow["kind"],
      previousFundingType: row.previous_funding_type as FundingType | null,
      fundingType: row.funding_type as FundingType,
      stage: row.stage as FundingMethodCorrectionRow["stage"],
      basePlanVersion: row.base_plan_version, planVersion: row.plan_version,
      reason: row.reason, changedBy: row.changed_by, changedAt: row.changed_at.toISOString(),
    }));
  });
}

/** A reviewed operational revision or a factual Funded correction, never a custody instruction. */
export async function changeFundingMethod(
  transferId: string,
  input: FundingMethodChangeInput,
): Promise<FundingMethodChangeResult> {
  const identity = await actor();
  if (!identity) return reject(UNAVAILABLE);
  const errors = validateFundingMethodChange(input);
  if (errors.length) return { ok: false, errors };
  try {
    const result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const current = await tx.transfer.findUnique({ where: { id: transferId }, include: currentInclude });
      if (!current || current.archived_at) return reject(UNAVAILABLE);
      if (current.stage !== input.expectedStage || current.funding_plan_version !== input.basePlanVersion ||
          current.funding_method_revision !== input.baseMethodRevision) return reject(STALE);
      const before = recordedFundingMethod(current);
      if (before === input.fundingType) return reject("Choose a different funding method.", "funding_type");
      const factual = current.stage === "FUNDED";
      const routeChanged = !factual && fundingRouteFamily(current.funding_type) !== fundingRouteFamily(input.fundingType);
      // Full and partial ACAT share a rail but authorize different securities
      // instructions. Either direction needs fresh initiation evidence.
      const acatScopeChanged = !factual && (
        input.fundingType === "ACAT_PARTIAL" ||
        (current.funding_type === "ACAT_PARTIAL" && input.fundingType === "ACAT_FULL")
      );
      const now = new Date();
      const revision = current.funding_method_revision + 1;
      const version = current.funding_plan_version + (factual ? 0 : 1);
      const reason = input.reason.trim();
      // Capture affected task state before any explicit restart. Switching away
      // keeps original rows untouched; switching back keeps this immutable proof.
      const affectedTasks = factual ? [] : await tx.decisionTask.findMany({
        where: { transfer_id: transferId, decision_id: null, OR: [
          { source_key: { startsWith: `asset-transfer:${transferId}:drs:` } },
          { source_key: { startsWith: `asset-transfer:${transferId}:standard-partial-acat:` } },
        ] }, orderBy: { id: "asc" },
      });
      let snapshot: Prisma.InputJsonObject = { source: "none", positions: [] };
      let source = "none";
      let executionTaskCount = 0;
      let drsTaskCount = 0;
      if (!factual) {
        const draft = {
          baseVersion: input.basePlanVersion, fundingType: input.fundingType,
          basisDecisions: input.basisDecisions ?? [], partialPositions: input.partialPositions ?? [], note: reason,
        };
        const context = input.fundingType === "ACAT_PARTIAL" ? await sourceContext(tx, current) : null;
        if (context && (input.sourceFingerprint !== context.fingerprint ||
            (context.linkedAssetMap && !context.assetMap))) return reject(SOURCE_CHANGED, "positions");
        const expectation = context?.assetMap ? { mode: "asset-map" as const, symbols: context.assetMap.positions.map((p) => p.symbol) }
          : context?.source === "transfer-decisions" ? { mode: "basis" as const, decisionIds: current.decisions.map((p) => p.id) }
          : { mode: "none" as const };
        const validation = validateFundingPlanApproval(draft, expectation);
        if (!validation.ok) return { ok: false as const, errors: validation.errors };
        if (context?.assetMap) {
          source = "asset-map";
          const selected = new Map(draft.partialPositions.map((p) => [p.symbol, p.isTransferring]));
          const positions = context.assetMap.positions.map((p) => ({ ...p, isTransferring: selected.get(p.symbol)! }));
          snapshot = { source, assetMap: {
            folderId: current.asset_map_folder_id, custodian: current.asset_map_custodian,
            accountLast4: current.asset_map_account_number?.slice(-4) ?? null,
            accountType: current.asset_map_account_type, sourceAccountFingerprint: context.sourceAccountFingerprint,
            statementDate: context.assetMap.statementDate,
          }, positions };
          for (const position of positions) await tx.transferPositionFlag.upsert({
            where: { transfer_id_symbol: { transfer_id: transferId, symbol: position.symbol } },
            create: { transfer_id: transferId, symbol: position.symbol, is_transferring: position.isTransferring,
              decided_by: identity.email, decided_at: now },
            update: { is_transferring: position.isTransferring, decided_by: identity.email, decided_at: now },
          });
        } else if (context?.source === "transfer-decisions") {
          source = "transfer-decisions";
          const selected = new Map(draft.basisDecisions.map((p) => [p.decisionId, p.decision]));
          const positions = context.decisions.map((p) => ({ ...p, decision: selected.get(p.decisionId)! }));
          snapshot = { source, positions };
          for (const position of positions) await tx.transferDecision.update({
            where: { id: position.decisionId },
            data: { decision: position.decision, decided_by: identity.email, decided_at: now },
          });
        }
      }
      await tx.transfer.update({
        where: { id: transferId, stage: input.expectedStage, archived_at: null,
          funding_plan_version: input.basePlanVersion, funding_method_revision: input.baseMethodRevision,
          funding_type: current.funding_type, recorded_funding_type: current.recorded_funding_type },
        data: factual ? {
          recorded_funding_type: input.fundingType, funding_method_revision: revision, updated_by: identity.email,
        } : {
          funding_type: input.fundingType, recorded_funding_type: null,
          funding_method_revision: revision, funding_plan_version: version, funding_plan_complete: true,
          funding_plan_approved_at: now, funding_plan_approved_by: identity.email, updated_by: identity.email,
          drs_method_change_pending: current.stage === "IN_TRANSFER" && input.fundingType === "DRS",
          funding_route_change_pending: routeChanged || acatScopeChanged || current.funding_route_change_pending,
          ...(routeChanged || acatScopeChanged ? { funding_initiated: false, cash_in_flight: false } : {}),
        },
      });
      if (!factual) {
        await tx.transferFundingPlanApproval.create({ data: {
          transfer_id: transferId, version, funding_type: input.fundingType, snapshot, note: reason,
          approved_by: identity.email, approved_at: now,
        } });
        // Do not invoke the legacy inactive task-retirement writer: obsolete
        // partial tasks retain their actual status and are projected inactive.
        if (input.fundingType === "ACAT_PARTIAL") executionTaskCount = await syncPartialAcatExecutionTasks(tx, identity, {
          transferId, active: true, restartExistingTasks: true,
        });
        if (input.fundingType === "DRS") drsTaskCount = await syncDrsWorkflowTasks(tx, identity, {
          transferId, restartExistingTasks: true,
        });
      }
      await tx.transferFundingMethodCorrection.create({ data: {
        transfer_id: transferId, revision, kind: factual ? "RECORDED_CORRECTION" : "PLAN_REVISION",
        previous_funding_type: before, funding_type: input.fundingType, stage: current.stage,
        base_plan_version: current.funding_plan_version, plan_version: version,
        reason, changed_by: identity.email!, changed_at: now,
        affected_work_snapshot: {
          reviewed: true,
          acatLinked: current.acat_record_id != null || current.acat_transfer_id != null,
          assetMapLinked: current.asset_map_folder_id != null,
          readinessBefore: { fundingInitiated: current.funding_initiated, cashInFlight: current.cash_in_flight },
          tasksBefore: affectedTasks.map((task) => ({ id: task.id, taskKey: task.task_key,
            status: task.status, completedAt: task.completed_at?.toISOString() ?? null, completedBy: task.completed_by })),
        },
      } });
      await writeAudit(tx, identity, {
        action: "transfer.funding_method_change", entityType: "transfer", entityId: transferId,
        detail: { revision, kind: factual ? "RECORDED_CORRECTION" : "PLAN_REVISION",
          fromFundingType: before, fundingType: input.fundingType, stage: current.stage,
          basePlanVersion: current.funding_plan_version, planVersion: version,
          source, executionTaskCount, drsTaskCount, affectedWorkReviewed: true, hasReason: true },
      });
      return { ok: true as const };
    });
    if (result.ok) {
      revalidatePath("/asset-transfer");
      revalidatePath(`/asset-transfer/${transferId}`);
      revalidatePath("/tasks");
      revalidatePath("/decision-center");
    }
    return result;
  } catch {
    return reject("The funding method could not be saved. Refresh and review the current record before trying again.");
  }
}

/** Confirm actual initiation after a rail change; never send a funding request. */
export async function confirmFundingMethodInitiated(
  transferId: string,
  input: FundingMethodInitiationInput,
): Promise<FundingMethodChangeResult> {
  const identity = await actor();
  if (!identity) return reject(UNAVAILABLE);
  if (!input || !["DECISION", "IN_TRANSFER"].includes(input.expectedStage) ||
      !Number.isSafeInteger(input.basePlanVersion) || !Number.isSafeInteger(input.baseMethodRevision)) return reject(STALE);
  try {
    const result = await withUserScope(identity, async (tx) => {
      await lockTransferPlan(tx, transferId);
      const current = await tx.transfer.findUnique({ where: { id: transferId } });
      if (!current || current.archived_at) return reject(UNAVAILABLE);
      if (current.stage !== input.expectedStage || current.funding_plan_version !== input.basePlanVersion ||
          current.funding_method_revision !== input.baseMethodRevision) return reject(STALE);
      if (!current.funding_route_change_pending) return reject("Funding initiation is already confirmed for this method.");
      if (!current.funding_plan_complete || current.funding_type == null) return reject("Approve the current funding plan first.");
      if (current.funding_type === "DRS" || current.funding_type === "ACAT_PARTIAL") {
        return reject("Complete the required workflow tasks for this funding method before advancing.");
      }
      if (current.funding_type === "ACAT_FULL" && !current.acat_record_id && !current.acat_transfer_id) {
        return reject("Link and review the ACAT for this funding method before confirming initiation.");
      }
      await tx.transfer.update({ where: { id: transferId }, data: {
        funding_route_change_pending: false, funding_initiated: true,
        cash_in_flight: fundingRouteFamily(current.funding_type) === "CASH", updated_by: identity.email,
      } });
      await writeAudit(tx, identity, {
        action: "transfer.funding_method_initiated", entityType: "transfer", entityId: transferId,
        detail: { fundingMethodRevision: current.funding_method_revision, planVersion: current.funding_plan_version,
          fundingType: current.funding_type, stage: current.stage },
      });
      return { ok: true as const };
    });
    if (result.ok) { revalidatePath("/asset-transfer"); revalidatePath(`/asset-transfer/${transferId}`); }
    return result;
  } catch { return reject("Funding initiation could not be confirmed. Refresh and try again."); }
}
