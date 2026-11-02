import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { afterSpy, reconcileSpy, relationshipSpy } = vi.hoisted(() => ({
  afterSpy: vi.fn(),
  reconcileSpy: vi.fn(
    async (_runId: string, _dryRun: boolean, _timeoutMs?: number) => ({}),
  ),
  relationshipSpy: vi.fn(
    async (
      _runId: string,
      _dryRun: boolean,
      _completeness: { contact: boolean; deal: boolean; transfer: boolean },
      _timeoutMs?: number,
    ) => [],
  ),
}));

vi.mock("next/server", () => ({ after: afterSpy }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/crm/reconcile", () => ({
  runCrmIdentityReconciliation: reconcileSpy,
}));
vi.mock("@/lib/crm/relationships", () => ({
  runCrmRelationshipSnapshot: relationshipSpy,
}));

import {
  CRM_POST_COMMIT_STEP_TIMEOUT_MS,
  scheduleCrmIdentityReconciliation,
} from "@/lib/crm/post-commit-signal";

const IDENTITY_KEYS = [
  "CRM_IDENTITY_POST_COMMIT_SIGNALS",
  "CRM_IDENTITY_RECONCILIATION",
  "CRM_IDENTITY_RECONCILIATION_WRITES",
] as const;
const RELATIONSHIP_KEYS = [
  "CRM_RELATIONSHIP_RECONCILIATION",
  "CRM_RELATIONSHIP_RECONCILIATION_WRITES",
  "CRM_RELATIONSHIP_CONTINUOUS_REFRESH",
] as const;
const KEYS = [...IDENTITY_KEYS, ...RELATIONSHIP_KEYS] as const;

describe("CRM identity post-commit signal", () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    afterSpy.mockReset();
    reconcileSpy.mockReset();
    reconcileSpy.mockResolvedValue({});
    relationshipSpy.mockReset();
    relationshipSpy.mockResolvedValue([]);
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      const prior = saved.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    saved.clear();
    vi.restoreAllMocks();
  });

  it.each(IDENTITY_KEYS)("does not schedule when %s is not enabled", (missing) => {
    for (const key of IDENTITY_KEYS) process.env[key] = "1";
    delete process.env[missing];

    expect(scheduleCrmIdentityReconciliation("transfer_action")).toBe(false);
    expect(afterSpy).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(relationshipSpy).not.toHaveBeenCalled();
  });

  it("schedules identity reconciliation without running it inline", async () => {
    for (const key of IDENTITY_KEYS) process.env[key] = "1";

    expect(scheduleCrmIdentityReconciliation("acat_link")).toBe(true);
    expect(afterSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).not.toHaveBeenCalled();

    const callback = afterSpy.mock.calls[0]?.[0] as () => Promise<void>;
    await callback();

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    const [runId, dryRun, timeoutMs] = reconcileSpy.mock.calls[0];
    expect(runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(dryRun).toBe(false);
    expect(timeoutMs).toBe(CRM_POST_COMMIT_STEP_TIMEOUT_MS);
    expect(relationshipSpy).not.toHaveBeenCalled();
  });

  it.each(RELATIONSHIP_KEYS)(
    "keeps the identity signal live but skips relationships when %s is off",
    async (missing) => {
      for (const key of KEYS) process.env[key] = "1";
      delete process.env[missing];

      expect(scheduleCrmIdentityReconciliation("transfer_action")).toBe(true);
      const callback = afterSpy.mock.calls[0]?.[0] as () => Promise<void>;
      await callback();

      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(relationshipSpy).not.toHaveBeenCalled();
    },
  );

  it("runs one complete live relationship snapshot after identity", async () => {
    for (const key of KEYS) process.env[key] = "1";

    expect(scheduleCrmIdentityReconciliation("transfer_action")).toBe(true);
    const callback = afterSpy.mock.calls[0]?.[0] as () => Promise<void>;
    await callback();

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(relationshipSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy.mock.invocationCallOrder[0]).toBeLessThan(
      relationshipSpy.mock.invocationCallOrder[0]!,
    );
    const [runId, dryRun, completeness, timeoutMs] = relationshipSpy.mock.calls[0];
    expect(runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(dryRun).toBe(false);
    expect(completeness).toEqual({ contact: true, deal: true, transfer: true });
    expect(timeoutMs).toBe(CRM_POST_COMMIT_STEP_TIMEOUT_MS);
  });

  it("stops before relationships when identity reconciliation fails", async () => {
    for (const key of KEYS) process.env[key] = "1";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    reconcileSpy.mockRejectedValue(new Error("secret client name"));

    scheduleCrmIdentityReconciliation("transfer_sync");
    const callback = afterSpy.mock.calls[0]?.[0] as () => Promise<void>;
    await expect(callback()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "[crm:post-commit] source=transfer_sync identity_run_failed",
    );
    expect(relationshipSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret client name");
  });

  it("swallows a relationship failure and logs only a static source marker", async () => {
    for (const key of KEYS) process.env[key] = "1";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    relationshipSpy.mockRejectedValue(new Error("secret household detail"));

    scheduleCrmIdentityReconciliation("acat_link");
    const callback = afterSpy.mock.calls[0]?.[0] as () => Promise<void>;
    await expect(callback()).resolves.toBeUndefined();

    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[crm:post-commit] source=acat_link relationship_run_failed",
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      "secret household detail",
    );
  });

  it("does not surface a scheduling failure after the source commit", () => {
    for (const key of IDENTITY_KEYS) process.env[key] = "1";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    afterSpy.mockImplementation(() => {
      throw new Error("request lifecycle detail");
    });

    expect(scheduleCrmIdentityReconciliation("transfer_action")).toBe(false);
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[crm:post-commit] source=transfer_action schedule_failed",
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      "request lifecycle detail",
    );
  });
});
