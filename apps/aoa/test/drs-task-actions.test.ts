import { beforeEach, describe, expect, it, vi } from "vitest";
const { authSpy, scopeSpy, auditSpy, revalidateSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(), scopeSpy: vi.fn(), auditSpy: vi.fn(), revalidateSpy: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rls", () => ({ withUserScope: scopeSpy }));
vi.mock("next/cache", () => ({ revalidatePath: revalidateSpy }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()), writeAudit: auditSpy,
}));
import { updateDecisionTask } from "@/app/(authenticated)/(workflow)/decision-center/actions";

const at = new Date("2026-09-25T12:00:00.000Z");
const input = { taskId: "task-1", status: "DONE" as const, priority: "HIGH" as const,
  expectedUpdatedAt: at.toISOString(), expectedFundingPlanVersion: 2 };
function makeTask() {
  return { id: "task-1", transfer_id: "transfer-1", decision_id: null,
    task_key: "drs-paperwork", source_key: "asset-transfer:transfer-1:drs:paperwork",
    owner_team: "CLIENT_SERVICE", updated_at: at, status: "TODO", priority: "HIGH" };
}
function makeTx() {
  return {
    $queryRaw: vi.fn(async () => [{ id: "transfer-1" }]),
    transfer: { findUnique: vi.fn(async () => ({ funding_type: "DRS", funding_plan_complete: true,
      funding_plan_version: 2, stage: "DECISION", archived_at: null as Date | null })) },
    decisionTask: { findUnique: vi.fn(async () => makeTask()), update: vi.fn(), updateMany: vi.fn(async (_args: { where: object; data: object }) => ({ count: 1 })) },
    decisionCaseEvent: { create: vi.fn() },
  };
}
let tx: ReturnType<typeof makeTx>;
beforeEach(() => {
  vi.resetAllMocks();
  authSpy.mockResolvedValue({ user: { email: "cs@example.com", role: "CLIENT_SERVICE" } });
  tx = makeTx();
  scopeSpy.mockImplementation(async (_identity, fn) => fn(tx));
});

describe("guarded DRS task action", () => {
  it("locks and rereads before a conditional owned update and audit", async () => {
    expect(await updateDecisionTask(input)).toEqual({ ok: true, id: "task-1" });
    expect(tx.decisionTask.findUnique).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeGreaterThan(tx.decisionTask.findUnique.mock.invocationCallOrder[0]);
    expect(tx.decisionTask.findUnique.mock.invocationCallOrder[1]).toBeGreaterThan(tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(tx.decisionTask.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "task-1", updated_at: at, owner_team: "CLIENT_SERVICE", transfer_id: "transfer-1", decision_id: null }),
      data: expect.objectContaining({ status: "DONE", completed_by: "cs@example.com", completed_at: expect.any(Date) }),
    });
    expect(auditSpy).toHaveBeenCalledWith(tx, expect.anything(), expect.objectContaining({
      entityId: "transfer-1", detail: expect.objectContaining({ taskKey: "drs-paperwork", fundingPlanVersion: 2 }),
    }));
    expect(tx.decisionTask.update).not.toHaveBeenCalled();
    expect(revalidateSpy).toHaveBeenCalledWith("/asset-transfer");
  });

  it.each([
    { expectedUpdatedAt: undefined }, { expectedUpdatedAt: "2026-09-24T12:00:00.000Z" },
    { expectedFundingPlanVersion: undefined }, { expectedFundingPlanVersion: 1 },
  ])("rejects stale or missing tokens %j", async (override) => {
    expect(await updateDecisionTask({ ...input, ...override })).toMatchObject({ ok: false, message: expect.stringMatching(/changed/) });
    expect(tx.decisionTask.updateMany).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it.each([
    { funding_type: "ACAT_FULL" }, { funding_plan_complete: false }, { funding_plan_version: 0 }, { archived_at: at },
  ])("rejects inactive transfer state %j", async (override) => {
    const transfer = await tx.transfer.findUnique();
    tx.transfer.findUnique.mockResolvedValue({ ...transfer, ...override });
    expect(await updateDecisionTask(input)).toMatchObject({ ok: false });
    expect(tx.decisionTask.updateMany).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("rejects a task changed while waiting on the transfer lock", async () => {
    tx.decisionTask.findUnique.mockResolvedValueOnce(makeTask()).mockResolvedValue({ ...makeTask(), updated_at: new Date("2026-09-25T12:01:00.000Z") });
    expect(await updateDecisionTask(input)).toMatchObject({ ok: false, message: expect.stringMatching(/changed/) });
    expect(tx.decisionTask.updateMany).not.toHaveBeenCalled();
  });

  it("never falls back to a generic update for malformed DRS identity", async () => {
    tx.decisionTask.findUnique.mockResolvedValue({ ...makeTask(), source_key: "asset-transfer:wrong-transfer:drs:paperwork" });
    expect(await updateDecisionTask(input)).toMatchObject({ ok: false });
    expect(tx.decisionTask.update).not.toHaveBeenCalled();
    expect(tx.decisionTask.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an advisor and requires Ops for Apex tasks", async () => {
    authSpy.mockResolvedValue({ user: { email: "advisor@example.com", role: "ADVISOR" } });
    expect(await updateDecisionTask(input)).toMatchObject({ ok: false });
    authSpy.mockResolvedValue({ user: { email: "cs@example.com", role: "CLIENT_SERVICE" } });
    tx.decisionTask.findUnique.mockResolvedValue({ ...makeTask(), task_key: "drs-apex-submitted",
      source_key: "asset-transfer:transfer-1:drs:apex-submitted", owner_team: "OPERATIONS" });
    expect(await updateDecisionTask(input)).toMatchObject({ ok: false, message: expect.stringMatching(/Operations/) });
    expect(tx.decisionTask.updateMany).not.toHaveBeenCalled();
  });

  it("disallows confirmation before In transfer and allows it during that stage", async () => {
    authSpy.mockResolvedValue({ user: { email: "ops@example.com", role: "OPERATIONS" } });
    tx.decisionTask.findUnique.mockResolvedValue({ ...makeTask(), task_key: "drs-apex-confirmed",
      source_key: "asset-transfer:transfer-1:drs:apex-confirmed", owner_team: "OPERATIONS" });
    expect(await updateDecisionTask(input)).toMatchObject({ ok: false, message: expect.stringMatching(/In transfer/) });
    tx.transfer.findUnique.mockResolvedValue({ ...(await tx.transfer.findUnique()), stage: "IN_TRANSFER" });
    expect(await updateDecisionTask(input)).toMatchObject({ ok: true });
  });

  it("allows remaining client follow-ups after Funded", async () => {
    tx.decisionTask.findUnique.mockResolvedValue({ ...makeTask(), task_key: "drs-client-communication",
      source_key: "asset-transfer:transfer-1:drs:client-communication" });
    tx.transfer.findUnique.mockResolvedValue({ ...(await tx.transfer.findUnique()), stage: "FUNDED" });
    expect(await updateDecisionTask(input)).toMatchObject({ ok: true });
  });

  it("preserves completion evidence during priority-only edits", async () => {
    tx.decisionTask.findUnique.mockResolvedValue({ ...makeTask(), status: "DONE" });
    tx.transfer.findUnique.mockResolvedValue({ ...(await tx.transfer.findUnique()), stage: "FUNDED" });
    expect(await updateDecisionTask({ ...input, priority: "NORMAL" })).toMatchObject({ ok: true });
    expect(tx.decisionTask.updateMany.mock.calls[0][0]).toMatchObject({ data: { status: "DONE", priority: "NORMAL" } });
    expect(tx.decisionTask.updateMany.mock.calls[0][0].data).not.toHaveProperty("completed_at");
    expect(tx.decisionTask.updateMany.mock.calls[0][0].data).not.toHaveProperty("completed_by");
  });

  it("does not audit or report success when the conditional update loses a race", async () => {
    tx.decisionTask.updateMany.mockResolvedValue({ count: 0 });
    expect(await updateDecisionTask(input)).toMatchObject({ ok: false, message: expect.stringMatching(/changed/) });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("invalidates the optimistic token even within one clock millisecond", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(at.getTime());
    try {
      expect(await updateDecisionTask(input)).toMatchObject({ ok: true });
      expect(tx.decisionTask.updateMany.mock.calls[0][0].data).toMatchObject({
        updated_at: new Date(at.getTime() + 1),
      });
    } finally {
      clock.mockRestore();
    }
  });
});
