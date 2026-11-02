import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(), enabled: vi.fn(), paused: vi.fn(), scope: vi.fn(), source: vi.fn(), targets: vi.fn(),
  matches: vi.fn(), pairReason: vi.fn(), lifecycle: vi.fn(), pair: vi.fn(), manifest: vi.fn(), prepare: vi.fn(), review: vi.fn(), rejects: vi.fn(),
  apply: vi.fn(), undo: vi.fn(), hold: vi.fn(), revalidate: vi.fn(), saved: vi.fn(), position: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/flags", () => ({ acatAutoLinkReviewEnabled: m.enabled }));
vi.mock("@/lib/maintenance", () => ({ appWritesPaused: m.paused }));
vi.mock("@/lib/rls", () => ({ withUserScope: m.scope }));
vi.mock("@/lib/data/acat-match-source", () => ({ fetchTransferLinkageSnapshot: m.source, readAcatCandidatesWithinScope: m.targets }));
vi.mock("@/lib/data/acat-match", () => ({ matchAcatPopulation: m.matches, acatPairIdentityReason: m.pairReason, acatPairLifecycleEligible: m.lifecycle, makeAcatMatchDecision: m.pair }));
vi.mock("@/lib/data/acat-reconciliation/prepare", () => ({ prepareManifestFromMatches: m.manifest }));
vi.mock("@/lib/data/acat-reconciliation/persistence", () => ({ prepareReconciliationRun: m.prepare, reviewReconciliationDecision: m.review }));
vi.mock("@/lib/data/acat-auto-link", () => ({ applyAcatDecision: m.apply, undoAcatDecision: m.undo, setAcatAutomationHoldWithinScope: m.hold, readAcatRejectedPairsWithinScope: m.rejects }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidate }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));

import { applyReviewedAcatDecision, prepareAcatPair, prepareAcatReview, reviewAcatDecision, undoReviewedAcatDecision } from "@/app/(authenticated)/acat-link-review/actions";

const actor = { role: "OPERATIONS", email: "ops@example.invalid" };
const tx = { syntheticTransaction: true, acatLinkDecision: { findUnique: m.saved, count: m.position } };
function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({ decisionId: "decision-1", reviewVersion: "3", evidenceDigest: "a".repeat(64), ...values })) data.set(key, value);
  return data;
}
beforeEach(() => {
  vi.resetAllMocks();
  m.saved.mockResolvedValue({ id: "decision-1", run_id: "saved-run", transfer_id: "transfer-1" });
  m.position.mockResolvedValue(101);
  m.auth.mockResolvedValue({ user: actor });
  m.enabled.mockReturnValue(true);
  m.paused.mockReturnValue(false);
  m.scope.mockImplementation(async (_identity, callback) => callback(tx));
  m.targets.mockResolvedValue([]);
  m.source.mockResolvedValue({ source: { system: "transfer-tracker", installationId: "synthetic", environment: "synthetic" }, records: [], observedAt: "2026-09-26T10:00:00.000Z", directory: {} });
  m.matches.mockReturnValue([]);
  m.rejects.mockResolvedValue([]);
  m.lifecycle.mockReturnValue(true);
  m.manifest.mockReturnValue({ manifest: {}, summary: { records: 0 } });
  m.prepare.mockResolvedValue({ runId: "run-1" });
  m.review.mockResolvedValue({ result: "saved" });
  m.apply.mockResolvedValue({ outcome: "APPLIED", transferId: "transfer-1" });
  m.undo.mockResolvedValue({ outcome: "UNDONE", transferId: "transfer-1" });
});

describe("ACAT review action boundaries", () => {
  it.each(["disabled", "paused", "viewer", "signed-out"])("%s cannot read source or mutate evidence/links", async (condition) => {
    if (condition === "disabled") m.enabled.mockReturnValue(false);
    if (condition === "paused") m.paused.mockReturnValue(true);
    if (condition === "viewer") m.auth.mockResolvedValue({ user: { ...actor, role: "VIEWER" } });
    if (condition === "signed-out") m.auth.mockResolvedValue(null);
    await prepareAcatReview();
    await prepareAcatPair(form({ transferId: "transfer-1", recordId: "record-1" }));
    await reviewAcatDecision(form({ action: "ACCEPT" }));
    await applyReviewedAcatDecision(form());
    await undoReviewedAcatDecision(form());
    expect(m.source).not.toHaveBeenCalled();
    expect(m.scope).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
    expect(m.undo).not.toHaveBeenCalled();
  });

  it("prepares evidence with installation identity, without applying a link", async () => {
    await expect(prepareAcatReview()).rejects.toThrow("REDIRECT:/acat-link-review?run=run-1&message=prepared");
    expect(m.prepare).toHaveBeenCalledWith(tx, actor, expect.objectContaining({
      sourceBoundary: expect.objectContaining({ source: { system: "transfer-tracker", installationId: "synthetic", environment: "synthetic" } }),
    }));
    expect(m.apply).not.toHaveBeenCalled();
    expect(m.review).not.toHaveBeenCalled();
  });

  it("includes persisted rejection decisions in a fresh review", async () => {
    const rejectedPairs = [{ transferId: "transfer-1", recordId: "record-1", evidenceDigest: "a".repeat(64) }];
    m.rejects.mockResolvedValue(rejectedPairs);
    await expect(prepareAcatReview()).rejects.toThrow("message=prepared");
    expect(m.matches).toHaveBeenCalledWith(expect.anything(), [], expect.objectContaining({ rejectedPairs }));
  });

  it("never persists a partial review when the complete source read fails", async () => {
    m.source.mockRejectedValue(new Error("private source failure"));
    await expect(prepareAcatReview()).rejects.toThrow("REDIRECT:/acat-link-review?message=unavailable");
    expect(m.prepare).not.toHaveBeenCalled();
  });

  it("does not let a selected pair bypass identity corroboration", async () => {
    m.targets.mockResolvedValue([{ transferId: "transfer-1", existingRecordId: null, existingTransferUuid: null }]);
    m.source.mockResolvedValue({ records: [{ recordId: "record-1" }] });
    m.pairReason.mockReturnValue("identity_conflict");
    await expect(prepareAcatPair(form({ transferId: "transfer-1", recordId: "record-1" }))).rejects.toThrow("message=stale");
    expect(m.prepare).not.toHaveBeenCalled();
  });

  it.each(["HOLD", "RESUME"])("%s requires a target version and delegates its mutation in the review transaction", async (action) => {
    await reviewAcatDecision(form({ action }));
    expect(m.review).not.toHaveBeenCalled();
    await expect(reviewAcatDecision(form({ action, targetVersion: "11" }))).rejects.toThrow("message=reviewed");
    expect(m.review).toHaveBeenCalledWith(tx, actor, expect.objectContaining({
      action, expectedReviewVersion: 3, expectedTargetVersion: 11, expectedEvidenceDigest: "a".repeat(64),
    }), m.hold);
  });

  it("carries the authenticated actor and review revision into apply", async () => {
    await expect(applyReviewedAcatDecision(form())).rejects.toThrow("message=applied");
    expect(m.apply).toHaveBeenCalledWith({ identity: actor, decisionId: "decision-1", expectedReviewVersion: 3, mode: "reviewed" });
    expect(m.revalidate).toHaveBeenCalledWith("/asset-transfer/transfer-1");
  });

  it("reports a failed conditional apply without claiming success or refreshing business routes", async () => {
    m.apply.mockResolvedValue({ outcome: "CONFLICT", reason: "target_changed" });
    await expect(applyReviewedAcatDecision(form())).rejects.toThrow("message=blocked");
    expect(m.revalidate.mock.calls).toEqual([["/acat-link-review"]]);
  });

  it("review/apply/undo stay on the selected saved run even when another run becomes newest", async () => {
    for (const action of [() => reviewAcatDecision(form({ action: "ACCEPT", focus: "unrelated-decision" })), () => applyReviewedAcatDecision(form({ focus: "unrelated-decision" })), () => undoReviewedAcatDecision(form({ focus: "unrelated-decision" }))]) {
      await expect(action()).rejects.toThrow("run=saved-run&population=aoa&page=3&focus=decision-1#decision-decision-1");
    }
    expect(m.position).toHaveBeenCalledWith({ where: { run_id: "saved-run", transfer_id: { not: null }, id: { lte: "decision-1" } } });
  });
  it("source-only review retains its source population without accepting an external return URL", async () => {
    m.saved.mockResolvedValue({ id: "decision-1", run_id: "saved-run", transfer_id: null });
    await expect(reviewAcatDecision(form({ action: "PENDING", returnTo: "https://foreign.invalid/" }))).rejects.toThrow("run=saved-run&population=tracker_only&page=3&focus=decision-1#decision-decision-1");
  });
  it("undo uses the review revision and guarded compensation service", async () => {
    await expect(undoReviewedAcatDecision(form())).rejects.toThrow("message=undone");
    expect(m.undo).toHaveBeenCalledWith({ identity: actor, decisionId: "decision-1", expectedReviewVersion: 3 });
    expect(m.apply).not.toHaveBeenCalled();
  });

  it("rejects malformed revisions and actions before opening a transaction", async () => {
    await reviewAcatDecision(form({ action: "DROP", reviewVersion: "3" }));
    await reviewAcatDecision(form({ action: "ACCEPT", reviewVersion: "-1" }));
    await applyReviewedAcatDecision(form({ reviewVersion: "NaN" }));
    expect(m.scope).not.toHaveBeenCalled();
    expect(m.apply).not.toHaveBeenCalled();
  });
});
