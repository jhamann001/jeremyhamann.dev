import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  applyGuardedStageWrite,
  STAGE_CONFLICT_MESSAGE,
} from "../lib/data/deal-stage-write";
import type { StageHistoryEntry } from "../lib/data/deal-types";

// QC MEDIUM-1 (PR #80): the guarded stage write. Concurrency is simulated at
// the seam the DB exposes it through — updateMany's matched-row count: a
// competing committed stage change makes the { id, stage: expectedFrom }
// guard match zero rows. On that "conflict" outcome NOTHING else may run
// (no history append; the caller then skips field update + audit rows).
// The happy path must append the entry via SQL (`||`), never a JS-side
// read-modify-write. All data invented.

const entry: StageHistoryEntry = {
  stage: "COMMITTED",
  from: "POTENTIAL",
  at: "2026-07-02T20:00:00.000Z",
  by: "Riley Ops",
};

// Minimal fake transaction client — just the two members the guarded write
// touches. $executeRaw is a tagged-template call: (strings, ...values).
function fakeTx(matchedRows: number) {
  const updateMany = vi.fn(async (_args: unknown) => ({ count: matchedRows }));
  const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
  const tx = {
    deal: { updateMany },
    $executeRaw: executeRaw,
  } as unknown as Prisma.TransactionClient;
  return { tx, updateMany, executeRaw };
}

describe("applyGuardedStageWrite", () => {
  it("applies: guarded update matched, then SQL-side history append", async () => {
    const { tx, updateMany, executeRaw } = fakeTx(1);
    const outcome = await applyGuardedStageWrite(
      tx, "deal_1", "POTENTIAL", "COMMITTED", entry, "ops@example.com",
    );
    expect(outcome).toBe("applied");

    // The guard is the expected-from stage on the WHERE.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "deal_1", stage: "POTENTIAL" },
      data: {
        stage: "COMMITTED",
        updated_by: "ops@example.com",
      },
    });

    // The append runs in SQL with the serialized entry as the parameter —
    // the JS side never supplies the concatenation base.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...params] = executeRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("stage_history || ");
    expect(params[0]).toBe(JSON.stringify([entry]));
    expect(params[1]).toBe("deal_1");
  });

  it("conflict: a lost race (zero matched rows) writes NOTHING further", async () => {
    const { tx, executeRaw } = fakeTx(0);
    const outcome = await applyGuardedStageWrite(
      tx, "deal_1", "POTENTIAL", "COMMITTED", entry, "ops@example.com",
    );
    expect(outcome).toBe("conflict");
    expect(executeRaw).not.toHaveBeenCalled(); // no history append on conflict
  });

  it("transition to LOST sets lost_from to the guarded from-stage", async () => {
    const { tx, updateMany } = fakeTx(1);
    const lost: StageHistoryEntry = { ...entry, stage: "LOST", from: "FUNDING" };
    await applyGuardedStageWrite(tx, "deal_1", "FUNDING", "LOST", lost, null);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "deal_1", stage: "FUNDING" },
      data: { stage: "LOST", lost_from: "FUNDING", updated_by: null },
    });
  });

  it("non-LOST transitions never touch lost_from", async () => {
    const { tx, updateMany } = fakeTx(1);
    await applyGuardedStageWrite(tx, "deal_1", "LOST", "FUNDING", entry, null);
    const call = updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect("lost_from" in call.data).toBe(false); // re-opening keeps the provenance
  });

  it("the conflict message tells the operator what to do", () => {
    expect(STAGE_CONFLICT_MESSAGE).toMatch(/refresh/i);
  });
});
