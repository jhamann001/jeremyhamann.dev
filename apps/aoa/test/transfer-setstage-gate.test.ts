import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Readiness-gate wiring after independent funding approval is satisfied.
// The complete two-action/flag matrix lives in transfer-stage-contract.test.ts.
// Auth, RLS and flags are mocked; callbacks still execute the real action.
// These cases verify readiness rejection writes nothing, successful moves
// audit once, and only forward moves seed missing destination checklist rows.

const { authSpy, withUserScopeSpy, flagSpy, checklistFlagSpy } = vi.hoisted(
  () => ({
    authSpy: vi.fn(),
    withUserScopeSpy: vi.fn(),
    flagSpy: vi.fn(),
    checklistFlagSpy: vi.fn(),
  }),
);

// actions.ts transitively imports a server-only data seam (transfer-asset-map)
// for the S3 link/unlink actions; stub it so this node-env test can import the
// module (the repo's per-file server-only convention).
vi.mock("server-only", () => ({}));

vi.mock("@/auth", () => ({ auth: authSpy }));
vi.mock("@/lib/rls", () => ({
  withUserScope: withUserScopeSpy,
}));
vi.mock("@/lib/flags", () => ({
  transferDealSourcedRedesignEnabled: flagSpy,
  checklistStageGateEnabled: checklistFlagSpy,
  // Closeout feature OFF for the gate tests — setStage now calls this in the
  // IN_TRANSFER-entry guard, so it must exist on the mock or the && short-circuit
  // throws "not a function" and every transition returns WRITE_REJECTED.
  slackCloseoutEnabled: () => false,
  // Manual-archive feature OFF for the gate tests (same partial-mock trap:
  // actions.ts imports it, and any action calling it needs it to exist).
  transferArchiveActionEnabled: () => false,
  assetTransferWorkspaceEnabled: () => false,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { setStage } from "@/app/(authenticated)/asset-transfer/actions";
import { DEFAULT_TASKS } from "@/lib/data/transfer-types";

type FakeTx = {
  $queryRaw: ReturnType<typeof vi.fn>;
  transfer: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
  transferTask: { createMany: ReturnType<typeof vi.fn> };
  deal: { findUnique: ReturnType<typeof vi.fn> };
};

// A DECISION-stage row. `overrides` tune the S3 scalar columns; tasks/decisions/
// accounts are empty (the soft-gate readers tolerate empty arrays).
function decisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    stage: "DECISION",
    accounts_opened_at_apex: false,
    funding_plan_complete: true,
    funding_plan_version: 1,
    funding_initiated: false,
    cash_in_flight: false,
    funding_type: null,
    acat_transfer_id: null,
    tasks: [],
    decisions: [],
    accounts: [],
    decision_cases: [],
    ...overrides,
  };
}

const ALL_MET = {
  accounts_opened_at_apex: true,
  funding_plan_complete: true,
  funding_initiated: true,
  cash_in_flight: true,
};

let tx: FakeTx;

beforeEach(() => {
  authSpy.mockResolvedValue({
    user: { email: "ops@example.com", role: "OPERATIONS" },
  });
  tx = {
    $queryRaw: vi.fn(async () => [{ id: "t1" }]),
    transfer: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    transferTask: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    deal: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  // Default the checklist-gate flag OFF so the existing (old-gate) cases below
  // exercise the unchanged path; the checklist describe turns it on explicitly.
  checklistFlagSpy.mockReturnValue(false);
  // Run the real action callback against the fake tx.
  withUserScopeSpy.mockImplementation(
    async (_identity: unknown, fn: (t: FakeTx) => unknown) => fn(tx),
  );
});

afterEach(() => vi.clearAllMocks());

describe("setStage — legacy readiness flag OFF", () => {
  beforeEach(() => flagSpy.mockReturnValue(false));

  it("DECISION→IN_TRANSFER with an approved plan ignores disabled legacy readiness (write + stage_change audit)", async () => {
    tx.transfer.findUnique.mockResolvedValue(decisionRow());
    const res = await setStage("t1", "IN_TRANSFER");
    expect(res.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("byte-identical parity: IN_TRANSFER→FUNDED on a deal-linked transfer does NOT fetch deal flags (soft path unchanged)", async () => {
    // Regression guard for the dealFlags relocation: the fetch condition stays
    // (from === "DECISION" && deal_id), so a non-DECISION origin never resolves
    // synced tasks against the deal — the advisory-warning path is unchanged.
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({ stage: "IN_TRANSFER", deal_id: "d1" }),
    );
    const res = await setStage("t1", "FUNDED");
    expect(res.ok).toBe(true);
    expect(tx.deal.findUnique).not.toHaveBeenCalled();
    expect(tx.transferTask.createMany).not.toHaveBeenCalled(); // flag OFF → no seeding
  });

  it("blocks DECISION→IN_TRANSFER while a linked Decision Center judgment remains open", async () => {
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({
        ...ALL_MET,
        decision_cases: [
          { id: "decision-1", question: "Confirm treatment for excluded positions" },
        ],
      }),
    );
    const res = await setStage("t1", "IN_TRANSFER");
    expect(res).toMatchObject({
      ok: false,
      blocked: true,
      unmet: [
        "Resolve Decision Center item: Confirm treatment for excluded positions",
      ],
    });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("allows the stage move once the blocking exception is no longer open", async () => {
    tx.transfer.findUnique.mockResolvedValueOnce(decisionRow({
      ...ALL_MET,
      decision_cases: [{ id: "decision-1", question: "Confirm treatment for excluded positions" }],
    }));
    const blocked = await setStage("t1", "IN_TRANSFER");
    expect(blocked).toMatchObject({
      ok: false,
      blocked: true,
      unmet: ["Resolve Decision Center item: Confirm treatment for excluded positions"],
    });
    expect(tx.transfer.update).not.toHaveBeenCalled();

    tx.transfer.findUnique.mockResolvedValueOnce(decisionRow({ ...ALL_MET, decision_cases: [] }));
    const moved = await setStage("t1", "IN_TRANSFER");
    expect(moved.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
  });
});

describe("setStage — flag ON, DECISION→IN_TRANSFER hard gate", () => {
  beforeEach(() => flagSpy.mockReturnValue(true));

  it("blocks when unmet: returns { ok:false, blocked:true, unmet } and writes NOTHING", async () => {
    tx.transfer.findUnique.mockResolvedValue(decisionRow());
    const res = await setStage("t1", "IN_TRANSFER");
    expect(res).toMatchObject({ ok: false, blocked: true });
    if ("blocked" in res && res.blocked) {
      expect(res.unmet.length).toBeGreaterThan(0);
    }
    // The transition never happened — no row update, no audit row.
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("proceeds when every condition is met via cash-in-flight (write + audit)", async () => {
    tx.transfer.findUnique.mockResolvedValue(decisionRow({ ...ALL_MET }));
    const res = await setStage("t1", "IN_TRANSFER");
    expect(res.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("proceeds when the ACAT leg is met via a linked acat_transfer_id (not a string check)", async () => {
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({
        accounts_opened_at_apex: true,
        funding_plan_complete: true,
        funding_initiated: true,
        cash_in_flight: false,
        funding_type: "ACAT_FULL",
        acat_transfer_id: "b3f1c0de-0000-4000-8000-000000000000", // a real linked UUID
      }),
    );
    const res = await setStage("t1", "IN_TRANSFER");
    expect(res.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
  });

  it("still blocks when funding_type=ACAT but acat_transfer_id is null (no real link)", async () => {
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({
        accounts_opened_at_apex: true,
        funding_plan_complete: true,
        funding_initiated: true,
        cash_in_flight: false,
        funding_type: "ACAT_FULL",
        acat_transfer_id: null,
      }),
    );
    const res = await setStage("t1", "IN_TRANSFER");
    expect(res).toMatchObject({ ok: false, blocked: true });
    expect(tx.transfer.update).not.toHaveBeenCalled();
  });
});

describe("setStage — legacy readiness does not govern later or backward transitions", () => {
  beforeEach(() => flagSpy.mockReturnValue(true));

  it("IN_TRANSFER→FUNDED with an approved plan does not require legacy Decision readiness", async () => {
    tx.transfer.findUnique.mockResolvedValue(decisionRow({ stage: "IN_TRANSFER" }));
    const res = await setStage("t1", "FUNDED");
    expect(res.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("backward IN_TRANSFER→DECISION proceeds (soft)", async () => {
    tx.transfer.findUnique.mockResolvedValue(decisionRow({ stage: "IN_TRANSFER" }));
    const res = await setStage("t1", "DECISION");
    expect(res.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
  });
});

describe("setStage — CHECKLIST_STAGE_GATE (checklist is the gate, all forward moves)", () => {
  // Task rows as the setStage select returns them (title/done/override_done/sort_order).
  const task = (title: string, done: boolean, sort_order: number) => ({
    id: `k-${sort_order}`,
    title,
    done,
    override_done: null as boolean | null,
    sort_order,
  });
  // The four always-visible DECISION titles (non-partial-ACAT), all complete.
  const DECISION_DONE = [
    task("Collect statements", true, 0),
    task("Run asset mapper", true, 1),
    task("Open receiving accounts", true, 2),
    task("Confirm account numbers", true, 3),
  ];

  beforeEach(() => {
    // New gate ON, old gate OFF — checklist governs readiness after approval.
    checklistFlagSpy.mockReturnValue(true);
    flagSpy.mockReturnValue(false);
  });

  it("blocks a forward move while a visible task is open — { blocked, unmet } and writes NOTHING", async () => {
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({ tasks: [task("Open receiving accounts", false, 2)] }),
    );
    const res = await setStage("t1", "IN_TRANSFER");
    expect(res).toMatchObject({ ok: false, blocked: true });
    if ("blocked" in res && res.blocked) {
      expect(res.unmet).toEqual(["Open receiving accounts"]);
    }
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.transferTask.createMany).not.toHaveBeenCalled();
  });

  it("proceeds when every visible task is done AND seeds the destination stage's checklist", async () => {
    tx.transfer.findUnique.mockResolvedValue(decisionRow({ tasks: DECISION_DONE }));
    const res = await setStage("t1", "IN_TRANSFER");
    expect(res.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
    // Seeded exactly the IN_TRANSFER defaults, none already present, appended
    // after the current max sort_order (3 → base 4).
    expect(tx.transferTask.createMany).toHaveBeenCalledTimes(1);
    const seeded = tx.transferTask.createMany.mock.calls[0][0].data as {
      transfer_id: string;
      title: string;
      sort_order: number;
    }[];
    expect(seeded.map((r) => r.title)).toEqual([...DEFAULT_TASKS.IN_TRANSFER]);
    expect(seeded.every((r) => r.transfer_id === "t1")).toBe(true);
    expect(seeded[0].sort_order).toBe(4);
  });

  it("uses the visible checklist for wire funding when both gate flags are enabled", async () => {
    flagSpy.mockReturnValue(true);
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({ funding_type: "WIRE", funding_plan_complete: true, tasks: DECISION_DONE }),
    );

    const res = await setStage("t1", "IN_TRANSFER");

    // Non-DRS routes retain checklist precedence over legacy readiness fields.
    // DRS now has its own explicit workflow tests.
    expect(res.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("still blocks wire funding on an unfinished visible task when both gate flags are enabled", async () => {
    flagSpy.mockReturnValue(true);
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({
        ...ALL_MET,
        funding_type: "WIRE",
        tasks: [task("Open receiving accounts", false, 2)],
      }),
    );

    const res = await setStage("t1", "IN_TRANSFER");

    expect(res).toMatchObject({
      ok: false, blocked: true, unmet: ["Open receiving accounts"],
    });
    expect(tx.transfer.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.transferTask.createMany).not.toHaveBeenCalled();
  });

  it("gates the second hop too: IN_TRANSFER→FUNDED blocks on an open IN_TRANSFER task", async () => {
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({
        stage: "IN_TRANSFER",
        tasks: [task("ACAT submitted to Apex", false, 0)],
      }),
    );
    const res = await setStage("t1", "FUNDED");
    expect(res).toMatchObject({ ok: false, blocked: true });
    expect(tx.transfer.update).not.toHaveBeenCalled();
  });

  it("resolves a synced task against the linked deal (deal.statements=true → treated done → not blocked)", async () => {
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({
        deal_id: "d1",
        tasks: [task("Collect statements", false, 0)], // raw done=false…
      }),
    );
    tx.deal.findUnique.mockResolvedValue({ statements: true, asset_mapped: false }); // …but the deal completes it
    const res = await setStage("t1", "IN_TRANSFER");
    expect(res.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
  });

  it("is vacuous when the stage has no visible tasks — forward move proceeds", async () => {
    tx.transfer.findUnique.mockResolvedValue(decisionRow({ tasks: [] }));
    const res = await setStage("t1", "IN_TRANSFER");
    expect(res.ok).toBe(true);
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
  });

  it("scopes the gate to the CURRENT stage — a stale open DECISION task does not block IN_TRANSFER→FUNDED", async () => {
    // A transfer accumulates earlier-stage rows. On IN_TRANSFER only the
    // IN_TRANSFER titles gate; a leftover open DECISION title is out of scope.
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({
        stage: "IN_TRANSFER",
        tasks: [
          task("Collect statements", false, 0), // stale open DECISION title
          task("ACAT submitted to Apex", true, 1),
          task("Transfer accepted by contra", true, 2),
          task("Positions settling", true, 3),
          task("Cost basis received", true, 4),
        ],
      }),
    );
    const res = await setStage("t1", "FUNDED");
    expect(res.ok).toBe(true); // the stale DECISION task is ignored
    expect(tx.transfer.update).toHaveBeenCalledTimes(1);
  });

  it("never blocks a backward move and never seeds on it", async () => {
    tx.transfer.findUnique.mockResolvedValue(
      decisionRow({
        stage: "IN_TRANSFER",
        tasks: [task("ACAT submitted to Apex", false, 0)],
      }),
    );
    const res = await setStage("t1", "DECISION");
    expect(res.ok).toBe(true);
    expect(tx.transferTask.createMany).not.toHaveBeenCalled();
  });
});
