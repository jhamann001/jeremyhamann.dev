import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { authSpy } = vi.hoisted(() => ({ authSpy: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/flags", () => ({
  transferDealSourcedRedesignEnabled: () => true,
  assetMapTransferLinkEnabled: () => true,
  checklistStageGateEnabled: () => false,
  slackCloseoutEnabled: () => false,
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: () => false,
}));
vi.mock("@/lib/crm/post-commit-signal", () => ({ scheduleCrmIdentityReconciliation: vi.fn() }));

import { approveFundingPlan, unlinkAssetMapFromTransfer, setStage, updateTransfer } from "@/app/(authenticated)/asset-transfer/actions";
import { transferToFormValues } from "@/components/transfers/transfer-form";
import type { TransferStage } from "@/lib/data/transfer-types";
import {
  createManualDecision,
  createTransferExceptionDecision,
  resolveDecisionCase,
  updateDecisionTask,
  type DecisionActionResult,
} from "@/app/(authenticated)/(workflow)/decision-center/actions";
import { listDecisionCasesForTransfer, listDecisionTasks } from "@/lib/data/decision-cases";
import { prisma } from "@/lib/db";
import { withUserScope } from "@/lib/rls";

const RUN = process.env.AUDIT_TEST_CLEANUP_URL ? describe : describe.skip;
const PREFIX = "ticket-DEC-";
const EMAIL = "ticket-dec-synthetic@example.test";
const OPS = { role: "OPERATIONS", email: EMAIL };
const VIEWER = { role: "VIEWER", email: EMAIL };
const transferId = `${PREFIX}transfer`;
const legacyIds = [`${PREFIX}legacy-partial`, `${PREFIX}legacy-wire`];
const fixtureIds = [transferId, ...legacyIds];

function successfulId(result: DecisionActionResult): string {
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.message);
  return result.id;
}

RUN("Transfer approval, decisions and tasks with PostgreSQL/RLS", () => {
  let owner: PrismaClient | undefined;

  async function cleanup() {
    if (!owner) return;
    const cases = await owner.decisionCase.findMany({
      where: { created_by: EMAIL }, select: { id: true },
    });
    const ids = cases.map((row) => row.id);
    await owner.decisionCaseEvent.deleteMany({ where: { decision_id: { in: ids } } });
    await owner.decisionTask.deleteMany({
      where: { OR: [{ decision_id: { in: ids } }, { transfer_id: { in: fixtureIds } }] },
    });
    await owner.decisionCase.deleteMany({ where: { id: { in: ids } } });
    await owner.transferFundingPlanApproval.deleteMany({ where: { transfer_id: { in: fixtureIds } } });
    await owner.transferDecision.deleteMany({ where: { transfer_id: { in: fixtureIds } } });
    await owner.transfer.deleteMany({ where: { id: { in: fixtureIds } } });
    await owner.auditLog.deleteMany({ where: { actorEmail: EMAIL } });
    const pattern = `${PREFIX}%`;
    await owner.$executeRaw`DELETE FROM audit.row_change WHERE row_pk LIKE ${pattern}`;
  }

  beforeAll(async () => {
    const appUrl = process.env.DATABASE_URL;
    const ownerUrl = process.env.AUDIT_TEST_CLEANUP_URL;
    if (!appUrl || !ownerUrl) throw new Error("Explicit local synthetic database URLs required");
    const target = new URL(ownerUrl);
    for (const value of [appUrl, ownerUrl]) {
      const url = new URL(value);
      const syntheticDatabase = url.pathname.endsWith("_synthetic") ||
        (process.env.CI === "true" && url.pathname === "/aoa");
      if (
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.host !== target.host || url.pathname !== target.pathname ||
        !syntheticDatabase ||
        ["host", "hostaddr", "service", "servicefile"].some((key) => url.searchParams.has(key))
      ) throw new Error("Decision acceptance requires one loopback synthetic database");
    }
    if (new URL(appUrl).username !== "app_rw") throw new Error("RLS actions must use app_rw");
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    await cleanup();
    await owner.transfer.create({
      data: {
        id: transferId, source: "APP", client_first_name: "Synthetic", client_last_name: "Decision",
        household_name: "Synthetic Decision Household", value: 1250, stage: "DECISION",
        owner_kind: "OPERATIONS", accounts_opened_at_apex: true, funding_initiated: true,
        cash_in_flight: true,
        decisions: { create: [
          { id: `${PREFIX}included`, symbol: "SYNIN", description: "Synthetic included", value: 1000, decision: "UNDECIDED" },
          { id: `${PREFIX}excluded`, symbol: "SYNOUT", description: "Synthetic excluded", value: 250, decision: "UNDECIDED" },
        ] },
      },
    });
  });

  beforeEach(() => authSpy.mockResolvedValue({ user: OPS }));

  afterAll(async () => {
    try { await cleanup(); } finally {
      await owner?.$disconnect();
      await prisma.$disconnect();
    }
  });

  it.each(["ACAT_PARTIAL", "WIRE"] as const)("reviews a legacy %s plan in place, preserving work and requiring approval before Funded", async (fundingType) => {
    const id = legacyIds[fundingType === "ACAT_PARTIAL" ? 0 : 1];
    const entered = new Date("2026-08-01T12:00:00Z");
    await owner!.transfer.create({ data: {
      id, source: "APP", client_first_name: "Synthetic", client_last_name: "Legacy review",
      value: 100, stage: "IN_TRANSFER", stage_entered_at: entered,
      funding_type: fundingType, funding_plan_complete: true, funding_plan_version: 0,
      owner_kind: "OPERATIONS", decisions: { create: {
        id: `${id}-position`, symbol: "SYN", description: "Saved synthetic instruction",
        value: 100, decision: "BRING_IN", decided_by: "prior@example.test", decided_at: entered,
      } },
    } });
    const { syncPartialAcatExecutionTasks } = await import("@/lib/data/decision-case-workflow");
    await withUserScope(OPS, (tx) => syncPartialAcatExecutionTasks(tx, OPS, { transferId: id, active: true }));
    const seededTasks = await owner!.decisionTask.findMany({ where: { transfer_id: id }, orderBy: { id: "asc" } });
    await owner!.decisionTask.update({ where: { id: seededTasks[0].id }, data: {
      status: "DONE", completed_by: "prior@example.test", completed_at: entered,
    } });
    await owner!.decisionTask.delete({ where: { id: seededTasks[2].id } }); // synthetic missing legacy task
    const reload = async () => ({
      transfer: await owner!.transfer.findUniqueOrThrow({ where: { id }, include: { decisions: true } }),
      tasks: await owner!.decisionTask.findMany({ where: { transfer_id: id }, orderBy: { id: "asc" } }),
      approvals: await owner!.transferFundingPlanApproval.findMany({ where: { transfer_id: id } }),
      audits: await owner!.auditLog.findMany({ where: { entityId: id }, orderBy: { id: "asc" } }),
    });
    const before = await reload();
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: false, blocked: true });
    const values = transferToFormValues({ ...before.transfer, value: Number(before.transfer.value), stage: before.transfer.stage as TransferStage });
    expect(await updateTransfer(id, { ...values, stage: "FUNDED" })).toMatchObject({ ok: false });
    const draft = {
      baseVersion: 0, fundingType, note: "Reviewed saved synthetic instructions now.", partialPositions: [],
      basisDecisions: [{ decisionId: `${id}-position`, decision: "BRING_IN" as const }],
    };
    // A previously opened Preparation tab cannot become a legacy review.
    expect(await approveFundingPlan(id, draft)).toMatchObject({ ok: false });
    expect(await reload()).toEqual(before);
    const started = Date.now();
    const approved = await approveFundingPlan(id, { ...draft, approvalMode: "LEGACY_IN_TRANSFER_REVIEW" });
    expect(approved).toMatchObject({ ok: true, version: 1 });
    const after = await reload();
    expect(after.transfer).toMatchObject({ stage: "IN_TRANSFER", stage_entered_at: entered,
      funding_plan_complete: true, funding_plan_version: 1, funding_plan_approved_by: EMAIL });
    expect(after.transfer.funding_plan_approved_at!.getTime()).toBeGreaterThanOrEqual(started);
    expect(after.transfer.decisions).toEqual(before.transfer.decisions);
    for (const task of before.tasks) {
      expect(after.tasks.find((row) => row.id === task.id)).toMatchObject({
        id: task.id, status: task.status, completed_by: task.completed_by, completed_at: task.completed_at,
      });
    }
    expect(after.tasks).toHaveLength(fundingType === "ACAT_PARTIAL" ? 3 : 2);
    expect(after.tasks.filter((task) => !before.tasks.some((row) => row.id === task.id))
      .every((task) => task.status === "TODO")).toBe(true);
    expect(after.approvals).toHaveLength(1);
    expect(JSON.parse(after.audits[0].detail!)).toMatchObject({ legacyInTransferReview: true, version: 1 });
    expect(await approveFundingPlan(id, { ...draft, approvalMode: "LEGACY_IN_TRANSFER_REVIEW" })).toMatchObject({ ok: false });
    expect(await reload()).toEqual(after);
    expect(await setStage(id, "FUNDED")).toMatchObject({ ok: true });
    expect((await reload()).transfer.stage).toBe("FUNDED");
  });

  it("persists approval, blocked exception, resolution handoff and task completion across fresh reads", async () => {
    const approval = await approveFundingPlan(transferId, {
      baseVersion: 0, fundingType: "ACAT_PARTIAL", note: "Synthetic reviewed plan.", partialPositions: [],
      basisDecisions: [
        { decisionId: `${PREFIX}included`, decision: "BRING_IN" },
        { decisionId: `${PREFIX}excluded`, decision: "LEAVE_GIFT" },
      ],
    });
    expect(approval).toMatchObject({ ok: true, version: 1 });
    const snapshot = await owner!.transferFundingPlanApproval.findFirstOrThrow({ where: { transfer_id: transferId } });
    const standard = (await listDecisionTasks(OPS)).filter((task) => task.transferId === transferId);
    expect(standard).toHaveLength(3);
    expect(standard.every((task) => task.decisionId === null && task.status === "TODO")).toBe(true);
    expect(standard.map((task) => task.ownerTeam).sort()).toEqual(["CLIENT_SERVICE", "OPERATIONS", "OPERATIONS"]);

    const decisionId = successfulId(await createTransferExceptionDecision({
      transferId, question: "Synthetic receiving registration needs review.",
      ownerTeam: "OPERATIONS", blocksTransfer: true,
    }));
    const [created] = await listDecisionCasesForTransfer(OPS, transferId);
    expect(created).toMatchObject({
      id: decisionId, sourceVersion: 1, status: "OPEN", blocksTransfer: true,
      sourceSnapshot: { fundingPlanVersion: 1, included: ["SYNIN"], excluded: ["SYNOUT"] },
    });
    expect(created.tasks).toHaveLength(1);
    expect(await setStage(transferId, "IN_TRANSFER")).toMatchObject({ ok: false, blocked: true });

    const resolutionInput = {
      decisionId, baseVersion: 0, resolutionCode: "TRANSFER_EXCEPTION_APPROVED",
      resolutionSummary: "Synthetic registration reviewed; proceed with saved plan.",
    };
    successfulId(await resolveDecisionCase(resolutionInput));
    const [resolved] = await listDecisionCasesForTransfer(OPS, transferId);
    expect(resolved).toMatchObject({
      status: "RESOLVED", version: 1, resolutionSummary: resolutionInput.resolutionSummary, resolvedBy: EMAIL,
    });
    expect(resolved.tasks).toHaveLength(2);
    expect(resolved.tasks.find((task) => task.id === created.tasks[0].id)?.status).toBe("DONE");
    const followUp = resolved.tasks.find((task) => task.id !== created.tasks[0].id)!;
    expect(followUp).toMatchObject({ status: "TODO", ownerTeam: "OPERATIONS", transferId });
    expect(resolved.events.filter((event) => event.action === "RESOLVED")).toHaveLength(1);
    expect(await resolveDecisionCase(resolutionInput)).toMatchObject({ ok: false });
    expect(await setStage(transferId, "IN_TRANSFER")).toMatchObject({ ok: true });

    successfulId(await updateDecisionTask({ taskId: followUp.id, status: "DONE", priority: "HIGH" }));
    expect((await listDecisionTasks(OPS)).find((task) => task.id === followUp.id)?.status).toBe("DONE");
    expect(await owner!.transferFundingPlanApproval.findFirstOrThrow({ where: { transfer_id: transferId } })).toEqual(snapshot);
    expect(await owner!.decisionCaseEvent.count({ where: { decision_id: decisionId, action: "RESOLVED" } })).toBe(1);
    expect(await owner!.auditLog.count({ where: { entityId: decisionId, action: "decision.case_resolve" } })).toBe(1);
  });

  it("accepts one concurrent resolution and keeps one follow-up, event and audit record", async () => {
    const decisionId = successfulId(await createManualDecision({
      householdName: "Synthetic Concurrent Household", question: "Synthetic competing instruction?", ownerTeam: "OPERATIONS",
    }));
    // Hold the row before either action starts. Both actions can read OPEN v0,
    // but their conditional writes must wait; release only after PostgreSQL
    // reports both UPDATEs waiting on locks. This exercises real contention,
    // not a sequential stale-version rejection that happens to use Promise.all.
    let announceLock!: () => void;
    const locked = new Promise<void>((resolve) => { announceLock = resolve; });
    let releaseLock!: () => void;
    const released = new Promise<void>((resolve) => { releaseLock = resolve; });
    const blocker = owner!.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM app.decision_case WHERE id = ${decisionId} FOR UPDATE`;
      announceLock();
      await released;
    }, { timeout: 10000 });
    await Promise.race([locked, blocker]);
    const pendingReplies = Promise.all(["First", "Second"].map((instruction) => resolveDecisionCase({
      decisionId, baseVersion: 0, resolutionCode: "GENERAL_APPROVED", resolutionSummary: `${instruction} synthetic instruction.`,
    })));
    let replies: DecisionActionResult[] = [];
    try {
      await expect.poll(async () => {
        const [row] = await owner!.$queryRaw<{ count: bigint }[]>`
          SELECT count(*) FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'app_rw'
            AND wait_event_type = 'Lock'
            AND query LIKE '%UPDATE "app"."decision_case"%'`;
        return Number(row.count);
      }, { timeout: 3000, interval: 10 }).toBe(2);
    } finally {
      releaseLock();
      await blocker;
      // Drain both requests even if the wait assertion fails, before fixture
      // cleanup can remove their decision and tasks.
      replies = await pendingReplies;
    }
    expect(replies.filter((result) => result.ok)).toHaveLength(1);
    expect(replies.filter((result) => !result.ok)).toHaveLength(1);
    const saved = await owner!.decisionCase.findUniqueOrThrow({ where: { id: decisionId }, include: { tasks: true } });
    expect(saved.version).toBe(1);
    expect(saved.tasks.map((task) => [task.task_key, task.status]).sort()).toEqual([
      ["execute-resolution", "TODO"], ["resolve-decision", "DONE"],
    ]);
    expect(await owner!.decisionCaseEvent.count({ where: { decision_id: decisionId, action: "RESOLVED" } })).toBe(1);
    expect(await owner!.auditLog.count({ where: { entityId: decisionId, action: "decision.case_resolve" } })).toBe(1);
  });

  it("enforces the same durable blocker through both human stage paths, including a skipped stage", async () => {
    expect(await setStage(transferId, "DECISION")).toMatchObject({ ok: true });
    const question = "Synthetic stage-boundary instruction requires approval.";
    const blockingId = successfulId(await createTransferExceptionDecision({
      transferId, question, ownerTeam: "OPERATIONS", blocksTransfer: true,
    }));
    const nonblockingId = successfulId(await createTransferExceptionDecision({
      transferId, question: "Synthetic optional follow-up can remain open.",
      ownerTeam: "OPERATIONS", blocksTransfer: false,
    }));
    const paths = ["toolbar", "edit form"] as const;
    const targets = ["IN_TRANSFER", "FUNDED"] as const;
    const savedState = async () => ({
      transfer: await owner!.transfer.findUniqueOrThrow({ where: { id: transferId } }),
      checklist: await owner!.transferTask.findMany({ where: { transfer_id: transferId }, orderBy: { id: "asc" } }),
      tasks: await owner!.decisionTask.findMany({ where: { transfer_id: transferId }, orderBy: { id: "asc" } }),
      audit: await owner!.auditLog.findMany({ where: { actorEmail: EMAIL }, orderBy: { id: "asc" } }),
    });
    const advance = async (path: (typeof paths)[number], stage: (typeof targets)[number], rejectedEdit = false) => {
      if (path === "toolbar") return setStage(transferId, stage);
      const current = await owner!.transfer.findUniqueOrThrow({ where: { id: transferId } });
      const values = transferToFormValues({
        ...current, value: Number(current.value), stage: current.stage as TransferStage,
      });
      return updateTransfer(transferId, {
        ...values, stage,
        ...(rejectedEdit ? { next_step: "This accompanying blocked edit must not persist." } : {}),
      });
    };

    for (const status of ["OPEN", "SNOOZED"] as const) {
      if (status === "SNOOZED") {
        // Synthetic fixture setup exercises the persisted snoozed status; the
        // actual stage actions still execute through app_rw and real RLS.
        await owner!.decisionCase.update({ where: { id: blockingId }, data: { status } });
      }
      const before = await savedState();
      for (const path of paths) {
        for (const target of targets) {
          const result = await advance(path, target, true);
          const message = `Resolve Decision Center item: ${question}`;
          if (path === "toolbar") expect(result).toEqual({ ok: false, blocked: true, unmet: [message] });
          else expect(result).toEqual({ ok: false, errors: [{ field: "stage", message }] });
          // Full snapshots include timestamps and completion metadata: a failed
          // action cannot partially save form fields, reset work or emit audits.
          expect(await savedState()).toEqual(before);
        }
      }
    }

    successfulId(await resolveDecisionCase({
      decisionId: blockingId, baseVersion: 0, resolutionCode: "TRANSFER_EXCEPTION_APPROVED",
      resolutionSummary: "Synthetic instruction reviewed; the saved plan may advance.",
    }));
    expect(await owner!.decisionCase.findUniqueOrThrow({ where: { id: nonblockingId } })).toMatchObject({
      status: "OPEN", blocks_transfer: false,
    });
    for (const path of paths) {
      for (const target of targets) {
        expect(await setStage(transferId, "DECISION")).toMatchObject({ ok: true });
        const result = await advance(path, target);
        if (path === "toolbar") expect(result).toMatchObject({ ok: true });
        else expect(result).toBeUndefined();
        expect(await owner!.transfer.findUniqueOrThrow({ where: { id: transferId } })).toMatchObject({ stage: target });
      }
    }
    // Preserve the surrounding workflow fixture's stage and version for later
    // approval-history assertions in this suite.
    expect(await setStage(transferId, "IN_TRANSFER")).toMatchObject({ ok: true });
  });

  it.each(["ADVISOR", "CLIENT_SERVICE"])("keeps %s escalation available while approval snapshots remain private", async (role) => {
    const identity = { role, email: EMAIL };
    authSpy.mockResolvedValue({ user: identity });
    expect(await withUserScope(identity, (tx) => tx.transferFundingPlanApproval.findMany({
      where: { transfer_id: transferId },
    }))).toEqual([]);
    const decisionId = successfulId(await createTransferExceptionDecision({
      transferId, question: `Synthetic ${role} clarification.`, ownerTeam: "OPERATIONS", blocksTransfer: false,
    }));
    const saved = (await listDecisionCasesForTransfer(identity, transferId)).find((row) => row.id === decisionId);
    expect(saved).toMatchObject({
      sourceVersion: 1, sourceLabel: "Asset Transfer · exception · approval details unavailable",
      sourceSnapshot: { fundingPlanVersion: null, positions: [], included: [], excluded: [] },
    });
  });

  it("invalidates saved approval on a source change and reapproves without rewriting history or duplicating work", async () => {
    expect(await setStage(transferId, "DECISION")).toMatchObject({ ok: true });
    const originalApproval = await owner!.transferFundingPlanApproval.findFirstOrThrow({
      where: { transfer_id: transferId, version: 1 },
    });
    const originalTasks = await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: null }, orderBy: { id: "asc" },
    });
    expect(originalTasks).toHaveLength(3);
    const otherDecisionTasks = await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: { not: null } }, orderBy: { id: "asc" },
    });
    for (const task of originalTasks) {
      successfulId(await updateDecisionTask({ taskId: task.id, status: "DONE", priority: "HIGH" }));
    }
    const completedTasks = await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: null }, orderBy: { id: "asc" },
    });
    expect(completedTasks.every((task) => task.status === "DONE" && task.completed_by === EMAIL && task.completed_at != null)).toBe(true);
    // Synthetic source context: unlink must invalidate it under RLS without
    // changing the approved snapshot or the existing completed tasks.
    await owner!.transfer.update({ where: { id: transferId }, data: {
      asset_map_folder_id: `${PREFIX}source`, asset_map_custodian: "Synthetic Custodian",
    } });
    const priorAudit = await owner!.auditLog.findMany({
      where: { entityId: transferId }, orderBy: { id: "asc" },
    });

    expect(await unlinkAssetMapFromTransfer(transferId)).toBeUndefined();
    const invalidated = await owner!.transfer.findUniqueOrThrow({ where: { id: transferId } });
    expect(invalidated).toMatchObject({
      funding_plan_version: 2, funding_plan_complete: false,
      funding_plan_approved_at: null, funding_plan_approved_by: null,
    });
    // Persisting a source change invalidates approval; only explicit approval
    // of revised instructions may restart completed work.
    expect(await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: null }, orderBy: { id: "asc" },
    })).toEqual(completedTasks);
    const auditCount = await owner!.auditLog.count({ where: { entityId: transferId } });
    expect(await unlinkAssetMapFromTransfer(transferId)).toBeUndefined();
    expect(await owner!.transfer.findUniqueOrThrow({ where: { id: transferId } })).toEqual(invalidated);
    expect(await owner!.auditLog.count({ where: { entityId: transferId } })).toBe(auditCount);

    const revisedPlan = {
      fundingType: "ACAT_PARTIAL" as const, note: "Synthetic revised selection.", partialPositions: [],
      basisDecisions: [
        { decisionId: `${PREFIX}included`, decision: "BRING_IN" as const },
        { decisionId: `${PREFIX}excluded`, decision: "BRING_IN" as const },
      ],
    };
    expect(await approveFundingPlan(transferId, { ...revisedPlan, baseVersion: 1 })).toMatchObject({ ok: false });
    expect(await owner!.transfer.findUniqueOrThrow({ where: { id: transferId } })).toEqual(invalidated);
    expect(await owner!.transferFundingPlanApproval.count({ where: { transfer_id: transferId } })).toBe(1);
    expect(await owner!.auditLog.count({ where: { entityId: transferId } })).toBe(auditCount);
    expect(await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: null }, orderBy: { id: "asc" },
    })).toEqual(completedTasks);

    expect(await approveFundingPlan(transferId, {
      ...revisedPlan, baseVersion: invalidated.funding_plan_version,
    })).toMatchObject({ ok: true, version: 3 });
    expect(await owner!.transfer.findUniqueOrThrow({ where: { id: transferId } })).toMatchObject({
      funding_plan_version: 3, funding_plan_complete: true, funding_plan_approved_by: EMAIL,
    });
    const history = await owner!.transferFundingPlanApproval.findMany({
      where: { transfer_id: transferId }, orderBy: { version: "asc" },
    });
    expect(history.map((row) => row.version)).toEqual([1, 3]);
    expect(history[0]).toEqual(originalApproval);
    expect(history[1].snapshot).toMatchObject({
      positions: expect.arrayContaining([
        expect.objectContaining({ symbol: "SYNOUT", decision: "BRING_IN" }),
      ]),
    });
    const currentTasks = await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: null }, orderBy: { id: "asc" },
    });
    expect(currentTasks).toHaveLength(3);
    expect(currentTasks.map((task) => task.id)).toEqual(originalTasks.map((task) => task.id));
    expect(currentTasks.every((task) => task.status === "TODO" && task.completed_by === null && task.completed_at === null)).toBe(true);
    expect(currentTasks.map((task) => [task.task_key, task.owner_team])).toEqual(originalTasks.map((task) => [task.task_key, task.owner_team]));
    expect(await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: { not: null } }, orderBy: { id: "asc" },
    })).toEqual(otherDecisionTasks);
    expect(await owner!.auditLog.findMany({
      where: { id: { in: priorAudit.map((event) => event.id) } }, orderBy: { id: "asc" },
    })).toEqual(priorAudit);
    const approvalAudit = await owner!.auditLog.findMany({
      where: { entityId: transferId, action: "transfer.funding_plan_approve" },
    });
    expect(approvalAudit.map((event) => JSON.parse(event.detail ?? "{}")).find((detail) => detail.version === 3)).toMatchObject({
      restartedPartialAcatInstructions: true,
    });

    // Reapproving genuinely unchanged instructions preserves all three
    // completion records, not just the preparation task.
    for (const task of currentTasks) {
      successfulId(await updateDecisionTask({ taskId: task.id, status: "DONE", priority: "HIGH" }));
    }
    const completedAgain = await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: null }, orderBy: { id: "asc" },
    });
    expect(await approveFundingPlan(transferId, { ...revisedPlan, baseVersion: 3 })).toMatchObject({ ok: true, version: 4 });
    const unchangedTasks = await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: null }, orderBy: { id: "asc" },
    });
    expect(unchangedTasks.map((task) => [task.id, task.status, task.completed_by, task.completed_at, task.owner_team])).toEqual(
      completedAgain.map((task) => [task.id, task.status, task.completed_by, task.completed_at, task.owner_team]),
    );
    expect(await owner!.transferFundingPlanApproval.findMany({
      where: { transfer_id: transferId, version: { in: [1, 3] } }, orderBy: { version: "asc" },
    })).toEqual(history);
    const latestAudit = await owner!.auditLog.findMany({
      where: { entityId: transferId, action: "transfer.funding_plan_approve" },
    });
    const unchangedDetail = latestAudit.map((event) => JSON.parse(event.detail ?? "{}")).find((detail) => detail.version === 4);
    expect(unchangedDetail).toBeDefined();
    expect(unchangedDetail?.restartedPartialAcatInstructions).toBeUndefined();
    expect(unchangedDetail?.restartedPartialAcatRoute).toBeUndefined();
  });

  it("denies viewer writes in actions and in the actual database policies", async () => {
    const decisionId = successfulId(await createManualDecision({
      householdName: "Synthetic Read-only Household", question: "Synthetic viewer denial?", ownerTeam: "OPERATIONS",
    }));
    const task = await owner!.decisionTask.findFirstOrThrow({ where: { decision_id: decisionId } });
    const before = await owner!.auditLog.count({ where: { entityId: decisionId } });
    authSpy.mockResolvedValue({ user: VIEWER });
    expect(await resolveDecisionCase({
      decisionId, baseVersion: 0, resolutionCode: "GENERAL_APPROVED", resolutionSummary: "Must not save.",
    })).toMatchObject({ ok: false });
    expect(await updateDecisionTask({ taskId: task.id, status: "DONE", priority: "HIGH" })).toMatchObject({ ok: false });
    expect(await withUserScope(VIEWER, (tx) => tx.decisionCase.updateMany({
      where: { id: decisionId }, data: { question: "Must not save." },
    }))).toEqual({ count: 0 });
    expect(await withUserScope(VIEWER, (tx) => tx.decisionTask.updateMany({
      where: { id: task.id }, data: { priority: "HIGH" },
    }))).toEqual({ count: 0 });
    expect(await owner!.decisionCase.findUniqueOrThrow({ where: { id: decisionId } })).toMatchObject({
      status: "OPEN", version: 0, question: "Synthetic viewer denial?",
    });
    expect(await owner!.auditLog.count({ where: { entityId: decisionId } })).toBe(before);
  });

  it("reopens all standard partial-ACAT work on route return while repeated partial approval preserves new completion", async () => {
    const priorApprovals = await owner!.transferFundingPlanApproval.findMany({
      where: { transfer_id: transferId }, orderBy: { version: "asc" },
    });
    const priorAudit = await owner!.auditLog.findMany({
      where: { entityId: transferId }, orderBy: { id: "asc" },
    });
    const decisionTasks = await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: { not: null } }, orderBy: { id: "asc" },
    });
    expect(decisionTasks.some((task) => task.status === "DONE")).toBe(true);
    expect(decisionTasks.some((task) => task.status === "TODO")).toBe(true);
    const starting = await owner!.transfer.findUniqueOrThrow({ where: { id: transferId } });
    let version = starting.funding_plan_version;
    const approveRoute = async (fundingType: "ACAT_PARTIAL" | "WIRE") => {
      expect(await approveFundingPlan(transferId, {
        baseVersion: version, fundingType, note: "Synthetic route-return review.", partialPositions: [],
        basisDecisions: [
          { decisionId: `${PREFIX}included`, decision: "BRING_IN" },
          { decisionId: `${PREFIX}excluded`, decision: "BRING_IN" },
        ],
      })).toMatchObject({ ok: true, version: version + 1 });
      version += 1;
    };
    const standardTasks = () => owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: null }, orderBy: { id: "asc" },
    });

    await approveRoute("ACAT_PARTIAL");
    const originalTasks = await standardTasks();
    expect(originalTasks).toHaveLength(3);
    const paperwork = originalTasks.find((task) => task.task_key === "prepare-wet-signature-paperwork")!;
    successfulId(await updateDecisionTask({ taskId: paperwork.id, status: "DONE", priority: "HIGH" }));
    expect(await owner!.decisionTask.findUniqueOrThrow({ where: { id: paperwork.id } })).toMatchObject({
      status: "DONE", completed_by: EMAIL, completed_at: expect.any(Date),
    });

    await approveRoute("WIRE");
    expect((await standardTasks()).every((task) => task.status === "DONE")).toBe(true);
    await approveRoute("ACAT_PARTIAL");
    const reopened = await standardTasks();
    expect(reopened).toHaveLength(3);
    expect(reopened.map((task) => task.id)).toEqual(originalTasks.map((task) => task.id));
    expect(reopened.every((task) =>
      task.status === "TODO" && task.completed_by === null && task.completed_at === null,
    )).toBe(true);
    expect(reopened.map((task) => [task.task_key, task.owner_team]).sort()).toEqual([
      ["prepare-wet-signature-paperwork", "CLIENT_SERVICE"],
      ["review-submit-partial-acat", "OPERATIONS"],
      ["track-partial-acat", "OPERATIONS"],
    ]);
    expect(await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: { not: null } }, orderBy: { id: "asc" },
    })).toEqual(decisionTasks);

    successfulId(await updateDecisionTask({ taskId: paperwork.id, status: "DONE", priority: "HIGH" }));
    const completedAgain = await owner!.decisionTask.findUniqueOrThrow({ where: { id: paperwork.id } });
    await approveRoute("ACAT_PARTIAL");
    const repeated = await standardTasks();
    expect(repeated).toHaveLength(3);
    expect(repeated.map((task) => task.id)).toEqual(originalTasks.map((task) => task.id));
    expect(repeated.find((task) => task.id === paperwork.id)).toMatchObject({
      status: "DONE", completed_by: EMAIL, completed_at: completedAgain.completed_at,
    });
    expect(repeated.filter((task) => task.id !== paperwork.id).every((task) => task.status === "TODO")).toBe(true);
    expect(await owner!.decisionTask.findMany({
      where: { transfer_id: transferId, decision_id: { not: null } }, orderBy: { id: "asc" },
    })).toEqual(decisionTasks);

    const history = await owner!.transferFundingPlanApproval.findMany({
      where: { transfer_id: transferId }, orderBy: { version: "asc" },
    });
    expect(history).toHaveLength(priorApprovals.length + 4);
    expect(history.slice(0, priorApprovals.length)).toEqual(priorApprovals);
    expect(history.slice(-4).map((approval) => approval.funding_type)).toEqual([
      "ACAT_PARTIAL", "WIRE", "ACAT_PARTIAL", "ACAT_PARTIAL",
    ]);
    expect(await owner!.auditLog.findMany({
      where: { id: { in: priorAudit.map((event) => event.id) } }, orderBy: { id: "asc" },
    })).toEqual(priorAudit);
  });
});
